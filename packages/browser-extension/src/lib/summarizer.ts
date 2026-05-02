// packages/browser-extension/src/lib/summarizer.ts
// Structured context extractor.
// Two outputs per call:
//   extracted — rich structured object used by translator.ts for per-model formatting
//   content   — legacy plain-text fallback for backward compatibility

import type { CodeBlock, ContextSession, ExtractedContext, Message } from "./types";
import { attentionEngine } from "./attention-engine";
import type { AttentionMap } from "./attention-engine";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface SummaryResult {
  mode: "verbatim" | "summarized";
  content: string;
  extracted: ExtractedContext;
  originalTokenEstimate: number;
  summaryTokenEstimate: number;
}

const TOKEN_THRESHOLD = 3000;
const MAX_VERBATIM_MESSAGES = 6;

// ── Tier 1 compression helpers ────────────────────────────────────────────────

// Patterns that indicate the message is an error report or stack trace.
// Rule: these messages are ALWAYS kept verbatim — never summarised.
const ERROR_STACKTRACE_RE = [
  /\b(?:Traceback|TypeError|ValueError|ReferenceError|SyntaxError|RuntimeError|AttributeError|NameError|ImportError|KeyError|IndexError|ZeroDivisionError)\b/,
  /\bat\s+\w[\w.]*\s+\([^)]+:\d+:\d+\)/,   // JS/TS stack frames: at fn (file:line:col)
  /\bError:\s+\S/,                             // "Error: <message>" (any variant)
  /Exception\s+in\s+thread/,                  // Java thread exceptions
];

function hasErrorOrStackTrace(content: string): boolean {
  return ERROR_STACKTRACE_RE.some((re) => re.test(content));
}

// Compress an assistant message body to at most `maxSentences` of prose.
// CODE BLOCKS are ALWAYS preserved verbatim and appended in full, even if
// they fall outside the kept sentence window.  Error / stack-trace messages
// bypass compression entirely and are returned unchanged.
function compressTier1Assistant(content: string, maxSentences: number): string {
  if (hasErrorOrStackTrace(content)) return content;

  const SENTINEL = "__CF_CODE_";
  const blocks: string[] = [];

  // Replace each code fence with a sentinel so sentence-splitting ignores it.
  const sanitized = content.replace(/```[\s\S]*?```/g, (match) => {
    const idx = blocks.length;
    blocks.push(match);
    return `${SENTINEL}${idx}__`;
  });

  // Split prose into sentences / paragraphs and keep the first N.
  const sentences = sanitized
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const textSlice = sentences.slice(0, maxSentences).join(" ");

  // Identify which sentinels are already referenced in the kept text slice.
  const mentionedIndices = new Set<number>();
  for (const m of textSlice.matchAll(new RegExp(`${SENTINEL}(\\d+)__`, "g"))) {
    mentionedIndices.add(Number(m[1]));
  }

  // Restore referenced code blocks in-place.
  let result = textSlice.replace(
    new RegExp(`${SENTINEL}(\\d+)__`, "g"),
    (_, idx) => blocks[Number(idx)]
  );

  // Append code blocks that were cut out by sentence-slicing — NEVER omit code.
  const missed = blocks.filter((_, i) => !mentionedIndices.has(i)).join("\n\n");
  if (missed) result = `${result}\n\n${missed}`;

  return result.trim() || content.slice(0, 200);
}

export default async function summarize(
  messages: Message[],
  options?: { caveman?: boolean }
): Promise<SummaryResult> {
  if (!messages.length) {
    const empty: ExtractedContext = {
      primaryGoal: "Not specified",
      currentFocus: "Not specified",
      completed: [],
      pending: [],
      decisions: "",
      facts: "",
      codeBlocks: [],
      conversationTail: [],
      messageCount: 0,
    };
    return {
      mode: "verbatim",
      content: "(no conversation history)",
      extracted: empty,
      originalTokenEstimate: 0,
      summaryTokenEstimate: 0,
    };
  }

  const compressed = options?.caveman ? aggressivelyCompressMessages(messages) : undefined;
  const extracted = extractContext(messages, compressed);

  const fullTranscript = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");
  const originalTokenEstimate = estimateTokens(fullTranscript);

  let content: string;
  let mode: "verbatim" | "summarized";
  const msgCount = messages.length;
  const originalLen = fullTranscript.length;

  if (msgCount < 30) {
    // Tier 1a — short session: return full conversation verbatim.
    content = fullTranscript;
    mode = "verbatim";
  } else {
    // Tier 1b (30–100 msgs): keep first 3 + last 10 verbatim; compress middle assistant to 2 sentences.
    // Tier 1c (>100 msgs):   keep first 3 + last 6  verbatim; compress middle assistant to 1 sentence.
    mode = "summarized";
    const tailCount    = msgCount <= 100 ? 10 : 6;
    const maxSentences = msgCount <= 100 ? 2  : 1;
    const tailStart    = Math.max(3, messages.length - tailCount);

    const head   = messages.slice(0, 3);
    const middle = messages.slice(3, tailStart);
    const tail   = messages.slice(tailStart);

    const processedMiddle: Message[] = middle.map((msg) => {
      // User messages: verbatim always.
      if (msg.role === "user") return msg;
      // Assistant messages: compress prose; code blocks + errors always preserved.
      return { ...msg, content: compressTier1Assistant(msg.content, maxSentences) };
    });

    const assembled = [...head, ...processedMiddle, ...tail];
    content = assembled
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");
  }

  const summaryLen = content.length;
  const compressionPct =
    originalLen > 0 ? Math.round((1 - summaryLen / originalLen) * 100) : 0;
  console.log(
    `[ContextForge:tier1] ${msgCount} msgs → ${summaryLen} chars (${compressionPct}% compressed)`
  );

  return {
    mode,
    content,
    extracted,
    originalTokenEstimate,
    summaryTokenEstimate: estimateTokens(content),
  };
}

// ── Aggressive compression (caveman mode) ────────────────────────────────────
// Body messages (all except last 6) are compressed:
//   user     → first non-fluff sentence, max 150 chars
//   assistant → at most 2 decision sentences; code stripped (kept in codeBlocks)

const FLUFF_PREFIX_RE =
  /^(?:(?:can|could|would|will|please|just|basically|actually|i was wondering|sure|of course|i'd like to|i need to|help me|hi|hello|hey)[,\s]+)+/i;

function stripUserFluff(text: string): string {
  const clean = text.replace(FLUFF_PREFIX_RE, "").trim();
  const sentence = clean.split(/[.!?\n]/)[0].trim();
  return (sentence || clean).slice(0, 150);
}

function compressAssistant(text: string): string {
  // Strip code fences — code preserved separately in codeBlocks.
  const noCode = text.replace(/```[\s\S]*?```/g, "").trim();
  const sentences = noCode
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
  // Pick up to 2 decision sentences.
  const decisions = sentences.filter((s) =>
    DECISION_RE.some((re) => re.test(s))
  );
  const chosen = decisions.slice(0, 2);
  if (chosen.length === 0 && sentences.length > 0) chosen.push(sentences[0]);
  return chosen.join(" ");
}

function aggressivelyCompressMessages(messages: Message[]): Message[] {
  if (messages.length <= MAX_VERBATIM_MESSAGES) return messages;
  const tail = messages.slice(-MAX_VERBATIM_MESSAGES);
  const body = messages.slice(0, -MAX_VERBATIM_MESSAGES);
  const compressedBody = body.map((msg) => ({
    ...msg,
    content:
      msg.role === "user"
        ? stripUserFluff(msg.content)
        : compressAssistant(msg.content),
  }));
  return [...compressedBody, ...tail];
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

function extractContext(messages: Message[], compressed?: Message[]): ExtractedContext {
  const src = compressed ?? messages;
  return {
    primaryGoal: extractPrimaryGoal(messages),
    currentFocus: extractCurrentFocus(messages),
    completed: extractCompleted(src),
    pending: extractPending(src),
    decisions: extractDecisions(src),
    facts: extractFacts(src),
    codeBlocks: extractAllCodeBlocks(messages),
    conversationTail: messages.slice(-MAX_VERBATIM_MESSAGES),
    messageCount: messages.length,
  };
}

// ── Goal extraction ───────────────────────────────────────────────────────────

function extractPrimaryGoal(messages: Message[]): string {
  const userMessages = messages.filter((m) => m.role === "user");
  if (!userMessages.length) return "Not specified";
  const first = userMessages[0].content.trim();
  return first.length > 600 ? first.slice(0, 600) + "…" : first;
}

function extractCurrentFocus(messages: Message[]): string {
  const userMessages = messages.filter((m) => m.role === "user");
  const lastThree = userMessages.slice(-3);
  if (!lastThree.length) return "Not specified";
  return lastThree
    .map((m) => {
      const text = m.content.trim();
      return text.length > 250 ? text.slice(0, 250) + "…" : text;
    })
    .join(" → ");
}

// ── Completed tasks ───────────────────────────────────────────────────────────

const COMPLETED_RE = [
  /^(?:here(?:'s| is)|i(?:'ve| have)|done|created|updated|fixed|added|implemented|built)[:\s]/im,
  /(?:\bis now\b|\bworks now\b|\bsuccessfully\b|\bcompleted?\b)/im,
];

function extractCompleted(messages: Message[]): string[] {
  const items: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (!COMPLETED_RE.some((re) => re.test(msg.content))) continue;
    const firstLine = msg.content.split("\n")[0].trim();
    const sentence = firstLine.split(/[.!?]/)[0].trim();
    if (sentence.length > 10 && sentence.length < 200) {
      items.push(sentence);
    }
  }
  return dedupe(items).slice(0, 12);
}

// ── Pending tasks ─────────────────────────────────────────────────────────────

const PENDING_RE = [
  /\btodo\b|next step|you(?:'ll| will) need|remaining|left to do|still need/im,
  /\bone more thing\b|should also|we need to|i(?:'ll| will) need/im,
  /\bnot yet\b|\bpending\b/im,
];

function extractPending(messages: Message[]): string[] {
  const items: string[] = [];
  for (const msg of messages.slice(-20)) {
    if (!PENDING_RE.some((re) => re.test(msg.content))) continue;
    const sentences = msg.content.split(/[.!?\n]/).filter((s) => s.trim().length > 15);
    for (const sentence of sentences) {
      if (PENDING_RE.some((re) => re.test(sentence))) {
        items.push(sentence.trim());
      }
    }
  }
  return dedupe(items).slice(0, 10);
}

// ── Key decisions ─────────────────────────────────────────────────────────────

const DECISION_RE = [
  /instead of|rather than|chose|chosen|decided|opted for|went with/im,
  /the reason|because.*approach|trade-?off/im,
  /(?:will|'ll) use .{3,30} (?:instead|for this|here)/im,
];

function extractDecisions(messages: Message[]): string {
  const items: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const sentences = msg.content.split(/[.!?\n]/).filter((s) => s.trim().length > 20);
    for (const s of sentences) {
      if (DECISION_RE.some((re) => re.test(s))) {
        items.push(`- ${s.trim()}`);
      }
    }
  }
  return dedupe(items).slice(0, 8).join("\n");
}

// ── Key facts / constraints ───────────────────────────────────────────────────

const FACT_RE = [
  /\b(?:must|cannot|can't|requires|depends on|note that|important:|warning:)\b/im,
  /\b(?:version|api key|endpoint|port|url|config)\b/im,
];

function extractFacts(messages: Message[]): string {
  const items: string[] = [];
  const earlyMessages = messages.slice(0, Math.min(20, messages.length));
  for (const msg of earlyMessages) {
    const sentences = msg.content.split(/[.!?\n]/).filter((s) => s.trim().length > 20);
    for (const s of sentences) {
      if (FACT_RE.some((re) => re.test(s))) {
        items.push(`- ${s.trim()}`);
      }
    }
  }
  return dedupe(items).slice(0, 8).join("\n");
}

// ── Code extraction — NEVER truncate code content ────────────────────────────

function extractAllCodeBlocks(messages: Message[]): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const codeRe = /```([\w-]*)[ \t]*\n([\s\S]*?)```/g;

  for (const msg of messages) {
    let match: RegExpExecArray | null;
    codeRe.lastIndex = 0;
    while ((match = codeRe.exec(msg.content)) !== null) {
      const language = match[1].trim();
      const content = match[2]; // Full content — never truncated

      // Detect file path from first-line comment: "// src/foo.ts" or "# path.py"
      const firstLine = content.split("\n")[0]?.trim() ?? "";
      const pathMatch =
        firstLine.match(/^(?:\/\/|#|--)\s+([\w./\\-]+\.\w+)\s*$/) ??
        firstLine.match(/^\/\*\*?\s*([\w./\\-]+\.\w+)\s*\*\//);
      const path = pathMatch?.[1];

      // Context: sentence immediately before the code fence in the message
      const before = msg.content.slice(
        Math.max(0, match.index - 200),
        match.index
      );
      const contextSentences = before.split(/[.!?\n]/).filter((s) => s.trim().length > 10);
      const context = contextSentences[contextSentences.length - 1]?.trim();

      blocks.push({ language, content, path, context });
    }
  }

  return blocks;
}

// ── Legacy plain-text summary (content field, backward compat) ───────────────

function buildPlainTextSummary(ex: ExtractedContext): string {
  const parts: string[] = [
    `=== CONVERSATION SUMMARY (${ex.messageCount} messages) ===`,
    `\nGOAL:\n${ex.primaryGoal}`,
    `\nCURRENT FOCUS:\n${ex.currentFocus}`,
  ];

  if (ex.completed.length) {
    parts.push(`\nCOMPLETED:\n${ex.completed.map((c) => `- ${c}`).join("\n")}`);
  }
  if (ex.pending.length) {
    parts.push(`\nPENDING:\n${ex.pending.map((p) => `- ${p}`).join("\n")}`);
  }
  if (ex.decisions) {
    parts.push(`\nKEY DECISIONS:\n${ex.decisions}`);
  }
  if (ex.codeBlocks.length) {
    parts.push(`\nCODE (${ex.codeBlocks.length} block(s)):`);
    for (const block of ex.codeBlocks) {
      const header = block.path
        ? ` ${block.path}`
        : block.context
        ? ` (${block.context})`
        : "";
      parts.push(`\`\`\`${block.language}${header}\n${block.content}\`\`\``);
    }
  }

  parts.push(
    `\n=== RECENT MESSAGES (verbatim) ===`,
    ex.conversationTail.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n")
  );

  return parts.join("\n");
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// ─────────────────────────────────────────────────────────────────────────────
// summarizeIntelligent — Tier 2: pure-logic structured extraction.
//
// No ML. No async. Completes in < 500 ms.
// Extracts goal, decisions, bugs fixed, all code blocks, current state,
// and a verbatim tail.  Compression rules:
//   • Code blocks   → 100% full content, always.
//   • User messages → scanned for goal / state, never compressed.
//   • Error msgs    → verbatim wherever detected.
//   • Decisions     → verbatim sentence kept (never < 1 full sentence).
// ─────────────────────────────────────────────────────────────────────────────

const TIER2_DECISION_RE = [
  /\bi['\u2019]ll use\b/i,
  /\bbest approach\b/i,
  /\bwe decided\b/i,
  /\bthe fix is\b/i,
  /\buse\s+\S+\s+for\b/i,
  /\bthis works because\b/i,
];

const TIER2_BUG_RE = [
  /\bthe issue was\b/i,
  /\bbug was caused\b/i,
  /\bfixed by\b/i,
  /\berror occurs because\b/i,
  /\broot cause\b/i,
];

export interface IntelligentSummary {
  goal: string;
  currentState: string;
  decisions: string[];
  bugsFixed: string[];
  codeBlocks: { language: string; path?: string; code: string }[];
  tail: Message[];
  originalCount: number;
  compressionRatio: number;
}

export function summarizeIntelligent(messages: Message[]): IntelligentSummary {
  const t0 = Date.now();

  // ── 1. Goal — first user message, up to 600 chars ─────────────────────────
  const userMessages = messages.filter((m) => m.role === "user");
  const goal =
    userMessages.length > 0
      ? userMessages[0].content.trim().slice(0, 600) || "Not specified"
      : "Not specified";

  // ── 5. Current state — last 6 user messages ───────────────────────────────
  const lastUserMessages = userMessages.slice(-6);
  const currentState =
    lastUserMessages.length > 0
      ? lastUserMessages
          .map((m) => {
            const t = m.content.trim();
            return t.length > 250 ? t.slice(0, 250) + "\u2026" : t;
          })
          .join(" \u2192 ")
      : "Not specified";

  // ── 2. Decisions — verbatim sentences from ALL assistant messages ──────────
  const rawDecisions: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const sentences = msg.content
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);
    for (const s of sentences) {
      if (TIER2_DECISION_RE.some((re) => re.test(s))) rawDecisions.push(s);
    }
  }
  const decisions = dedupe(rawDecisions).slice(0, 20);

  // ── 3. Bugs fixed — verbatim sentences from ALL messages ──────────────────
  const rawBugs: string[] = [];
  for (const msg of messages) {
    const sentences = msg.content
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);
    for (const s of sentences) {
      if (TIER2_BUG_RE.some((re) => re.test(s))) rawBugs.push(s);
    }
  }
  const bugsFixed = dedupe(rawBugs).slice(0, 15);

  // ── 4. Code blocks — ALL ``` fences, 100% content, language + path ────────
  const codeBlocks: { language: string; path?: string; code: string }[] = [];
  const codeRe = /```([\w-]*)[ \t]*\n([\s\S]*?)```/g;
  for (const msg of messages) {
    let match: RegExpExecArray | null;
    codeRe.lastIndex = 0;
    while ((match = codeRe.exec(msg.content)) !== null) {
      const language = match[1].trim() || "text";
      const code = match[2]; // Never truncated.
      const firstLine = code.split("\n")[0]?.trim() ?? "";
      const pathMatch =
        firstLine.match(/^(?:\/\/|#|--) ([\w./\\-]+\.\w+)\s*$/) ??
        firstLine.match(/^\/\*\*?\s*([\w./\\-]+\.\w+)\s*\*\//);
      codeBlocks.push({ language, path: pathMatch?.[1], code });
    }
  }

  // ── 6. Tail — last 8 messages verbatim, both roles ────────────────────────
  const tail = messages.slice(-8);

  // ── Compression ratio ─────────────────────────────────────────────────────
  const originalSize = messages.reduce((s, m) => s + m.content.length, 0);
  const extractedSize =
    goal.length +
    currentState.length +
    decisions.reduce((s, d) => s + d.length, 0) +
    bugsFixed.reduce((s, b) => s + b.length, 0) +
    codeBlocks.reduce((s, c) => s + c.code.length, 0) +
    tail.reduce((s, m) => s + m.content.length, 0);
  const compressionRatio =
    originalSize > 0 ? Math.round((1 - extractedSize / originalSize) * 100) : 0;

  console.log(
    `[ContextForge:tier2] ${messages.length} msgs \u2192 extracted:\n` +
    `  goals=1 decisions=${decisions.length} bugs=${bugsFixed.length} ` +
    `code_blocks=${codeBlocks.length} \u2192 ${extractedSize} chars ` +
    `(${compressionRatio}% compressed) [${Date.now() - t0}ms]`
  );

  return {
    goal,
    currentState,
    decisions,
    bugsFixed,
    codeBlocks,
    tail,
    originalCount: messages.length,
    compressionRatio,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// summarizeWithAttention — Attention Engine powered summarization.
//
// Scores every message against the user's task using semantic embeddings,
// keeps high-score content verbatim, compresses low-score messages to one
// sentence, and always preserves the last MAX_VERBATIM_MESSAGES messages.
// Falls back silently to summarize() on any engine failure.
// ─────────────────────────────────────────────────────────────────────────────

export async function summarizeWithAttention(
  messages: Message[],
  task: string,
  strength: "light" | "strict",
  session: ContextSession
): Promise<{ summary: string; attentionMap: AttentionMap; compressionRatio: number }> {
  try {
    if (!attentionEngine.initialized) {
      await attentionEngine.initialize();
    }

    await attentionEngine.indexSession(session);
    const attentionMap = await attentionEngine.buildAttentionMap(session, task, strength);
    const threshold = attentionMap.threshold;

    // content → best relevanceScore lookup for message-type chunks
    const scoreByContent = new Map<string, number>();
    for (const chunk of attentionMap.topChunks) {
      if (chunk.type === "message") {
        const prev = scoreByContent.get(chunk.content) ?? 0;
        if (chunk.relevanceScore > prev) scoreByContent.set(chunk.content, chunk.relevanceScore);
      }
    }

    // code block contents that scored above threshold (kept verbatim)
    const highScoreCode = new Set<string>(
      attentionMap.topChunks
        .filter((c) => c.type === "code" && c.relevanceScore >= threshold)
        .map((c) => c.content.trim())
    );

    const tailStart = Math.max(0, messages.length - MAX_VERBATIM_MESSAGES);

    const processed: Message[] = messages.map((msg, idx) => {
      // Last MAX_VERBATIM_MESSAGES messages: always keep verbatim.
      if (idx >= tailStart) return msg;

      const score = scoreByContent.get(msg.content) ?? 0;

      if (score >= threshold) {
        // High relevance — keep full text, strip only low-score code blocks.
        return { ...msg, content: stripLowScoreCode(msg.content, highScoreCode) };
      }

      // Low relevance — compress to first meaningful sentence, no code.
      const noCode = msg.content.replace(/```[\s\S]*?```/g, "").trim();
      const first = noCode.split(/[.!?\n]/)[0]?.trim() ?? noCode;
      return { ...msg, content: first.slice(0, 200) };
    });

    const extracted = extractContext(processed);
    const summary = buildPlainTextSummary(extracted);

    const originalSize = messages.reduce((s, m) => s + m.content.length, 0);
    const compressedSize = processed.reduce((s, m) => s + m.content.length, 0);
    const compressionRatio =
      originalSize > 0 ? Math.round((1 - compressedSize / originalSize) * 100) : 0;

    console.log(
      `[ContextForge:summarizer] summarizeWithAttention: msgs=${messages.length}→${processed.length} compression=${compressionRatio}%`
    );

    return { summary, attentionMap, compressionRatio };
  } catch (err) {
    console.warn(
      "[ContextForge:summarizer] summarizeWithAttention failed — falling back to summarize():",
      err
    );
    const fallback = await summarize(messages);
    return {
      summary: fallback.content,
      attentionMap: {
        task,
        threshold: 0.4,
        topChunks: [],
        highlightedFiles: [],
        highlightedModules: [],
        structuralContext: { files: [], modules: [], lastUpdated: Date.now() },
        focusedContext: "",
        compressionRatio: 0,
      },
      compressionRatio: 0,
    };
  }
}

function stripLowScoreCode(content: string, highScoreCode: Set<string>): string {
  return content.replace(/```[\s\S]*?```/g, (match) => {
    const inner = match.replace(/^```[\w-]*[ \t]*\n?/, "").replace(/\n?```$/, "").trim();
    return highScoreCode.has(inner) ? match : "";
  });
}
