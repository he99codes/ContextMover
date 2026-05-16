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

// Sentence patterns that signal a key decision or outcome worth keeping.
const KEY_DECISION_PATTERNS = [
  // Architecture decisions
  /\bwe decided\b/i,
  /\bdecided to\b/i,
  /\bgoing with\b/i,
  /\bopted for\b/i,
  /\bwe('?ll| will) use\b/i,
  /\bchose to\b/i,
  /\bwe chose\b/i,
  /\bswitching to\b/i,
  /\bmigrating to\b/i,
  /\bbest approach\b/i,
  /\bthe approach is\b/i,
  /\bwe use\b/i,
  /\busing\b/i,
  /\bwent with\b/i,
  /\bshould use\b/i,
  /\bmust use\b/i,
  // Bug / fix signals
  /\bthe fix is\b/i,
  /\bthe fix\b/i,
  /\bfixed by\b/i,
  /\b(?:root |the )?cause\b/i,
  /\broot cause\b/i,
  /\bbug was\b/i,
  /\berror occurs\b/i,
  /\bissue was\b/i,
  /\bthe problem\b/i,
  /\bthe issue\b/i,
  /\bresolved by\b/i,
  /\bfound it\b/i,
  // Goal signals
  /\bthe goal\b/i,
  /\bour goal\b/i,
  /\bwe want to\b/i,
  /\bwe need to\b/i,
  /\bwe('?re| are) building\b/i,
  /\bthe plan\b/i,
  /\bnext step\b/i,
  // Facts / reasoning
  /\bthis works because\b/i,
  /\bthe reason\b/i,
  /\bbecause of\b/i,
  /\bturns out\b/i,
  /\brealized that\b/i,
  /\barchitecture\b/i,
  // Legacy patterns (kept for compatibility)
  /\buse\s+\S+/i,
  /\bi[\u2019']?ve? updated\b/i,
  /\bhere[\u2019']?s the\b/i,
  /\bthe solution\b/i,
  /\bchanged.*\bto\b/i,
  /\binstead of\b/i,
  /\bneeds? to\b/i,
];

// Pure acknowledgment patterns — a message consisting ONLY of these phrases
// with no substantive content should be dropped entirely.
const PURE_ACK_RE =
  /^(?:sure|of course|absolutely|certainly|got it|understood|okay|ok|alright|happy to help|great|sounds good|will do|no problem|perfect)[!.,]?\s*(?:i[\u2019']?ll|let me|here[\u2019']?s|i can|to)?\s*[^a-zA-Z]*$/i;

/**
 * Extracts the single most important sentence from a (code-stripped) assistant
 * message body. Returns null when the message is pure filler with no decision,
 * fix, or key output — signalling the caller should drop it entirely.
 */
function extractKeyDecision(text: string): string | null {
  const cleaned = text.trim();
  if (cleaned.length < 5) return null;

  // Pure acknowledgment with no real content → drop.
  if (PURE_ACK_RE.test(cleaned)) return null;

  const sentences = cleaned
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  if (sentences.length === 0) return null;

  // Prefer a sentence that matches a key-decision pattern.
  const keyMatch = sentences.find((s) => KEY_DECISION_PATTERNS.some((re) => re.test(s)));
  if (keyMatch) return keyMatch.slice(0, 200);

  // No decision pattern found → signal drop.
  return null;
}

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
  } else if (msgCount <= 100) {
    // Tier 1b (30–100 msgs): keep first 3 + last 10 verbatim; compress middle to 2 sentences.
    mode = "summarized";
    const tailCount = 10;
    const tailStart = Math.max(3, messages.length - tailCount);
    const head   = messages.slice(0, 3);
    const middle = messages.slice(3, tailStart);
    const tail   = messages.slice(tailStart);
    const processedMiddle = middle.map((msg) =>
      msg.role === "user" ? msg : { ...msg, content: compressTier1Assistant(msg.content, 2) }
    );
    content = [...head, ...processedMiddle, ...tail]
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");
  } else {
    // Tier 1c aggressive (>100 msgs): target 80%+ compression.
    // • First 3 messages:  verbatim (keep)
    // • Last 6 messages:   verbatim (keep)
    // • All code blocks:   100% full content (keep)
    // • User messages:     verbatim (keep — they are short)
    // • Middle assistant messages:
    //     → Extract only the DECISION or KEY OUTPUT (1 sentence max)
    //     → If message contains ONLY explanation with no decision/code → DROP
    mode = "summarized";
    const tailCount = 6;
    const tailStart = Math.max(3, messages.length - tailCount);
    const head   = messages.slice(0, 3);
    const middle = messages.slice(3, tailStart);
    const tail   = messages.slice(tailStart);

    const processedMiddle: Message[] = [];
    for (const msg of middle) {
      if (msg.role === "user") { processedMiddle.push(msg); continue; }
      // Error / stack trace — always keep verbatim.
      if (hasErrorOrStackTrace(msg.content)) { processedMiddle.push(msg); continue; }

      // Extract code blocks first; they are ALWAYS kept verbatim.
      const codeBlocks: string[] = [];
      const noCode = msg.content.replace(/```[\s\S]*?```/g, (match) => {
        codeBlocks.push(match);
        return "";
      }).trim();

      // Try to find the single most important sentence from the prose.
      const keyDecision = noCode ? extractKeyDecision(noCode) : null;

      // If there is neither a key decision NOR any code → drop entirely.
      if (keyDecision === null && codeBlocks.length === 0) continue;

      const parts: string[] = [];
      if (keyDecision) parts.push(keyDecision);
      if (codeBlocks.length > 0) parts.push(codeBlocks.join("\n\n"));
      processedMiddle.push({ ...msg, content: parts.join("\n\n") });
    }

    content = [...head, ...processedMiddle, ...tail]
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");
  }

  // ── Hard output limit: 48,000 chars (safe for all AI platforms) ─────────────
  // If the compressed output is still over the limit, drop oldest middle messages
  // one by one until we fit. Head (3) and tail (6) are always preserved.
  const MAX_OUTPUT_CHARS = 48_000;
  if (content.length > MAX_OUTPUT_CHARS && msgCount >= 30) {
    const headCount = 3;
    const tailCount = msgCount > 100 ? 6 : 10;
    const tailStart = Math.max(headCount, messages.length - tailCount);
    const head = messages.slice(0, headCount);
    const tail = messages.slice(tailStart);

    // Re-derive the (possibly already compressed) middle from current content lines.
    // Rebuild as line-separated blocks so we can drop one message at a time.
    const lines = content.split("\n\n");
    const headLines = lines.slice(0, headCount);
    const tailLines = lines.slice(lines.length - tailCount);
    let middleLines = lines.slice(headCount, lines.length - tailCount);
    let trimmed = content;

    let dropped = 0;
    while (trimmed.length > MAX_OUTPUT_CHARS && middleLines.length > 0) {
      middleLines = middleLines.slice(1); // drop oldest middle block
      trimmed = [...headLines, ...middleLines, ...tailLines].join("\n\n");
      dropped++;
    }
    if (dropped > 0) {
      content = trimmed;
      mode = "summarized";
      console.log(
        `[ContextMover:tier1] Hard limit applied: dropped ${dropped} additional middle messages` +
        ` (head=${headCount} msgs, tail=${tail.length} msgs kept)`
      );
    }
  }

  const summaryLen = content.length;
  const compressionPct =
    originalLen > 0 ? Math.round((1 - summaryLen / originalLen) * 100) : 0;
  console.log(
    `[ContextMover:tier1] ${msgCount} msgs → ${summaryLen} chars (${compressionPct}% compressed)`
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
  if (!messages.length) return "Not specified";
  // Use last 8 messages regardless of role to capture assistant-introduced
  // direction changes that the user has acknowledged.
  let window = messages.slice(-8);
  // Skip a short ack (< 20 chars) from the tip so stale "ok"/"yes" don't
  // become the focus anchor.  Use the message before it instead.
  const tip = window[window.length - 1];
  if (tip && tip.role === "user" && tip.content.trim().length < 20) {
    window = window.slice(0, -1);
  }
  if (!window.length) return "Not specified";
  return window
    .map((m) => {
      const text = m.content.trim();
      return text.length > 300 ? text.slice(0, 300) + "…" : text;
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
  // Architecture decisions
  /instead of|rather than|chose|chosen|decided|opted for|went with/im,
  /\bgoing with\b/im,
  /\bopted for\b/im,
  /\blet['\u2019]s use\b/im,
  /\bsticking with\b/im,
  /\bswitching to\b/im,
  /\binstead I['\u2019]ll\b/im,
  /\bmigrating to\b/im,
  /\bbest approach\b/im,
  /\bthe approach is\b/im,
  /\bwe use\b/im,
  // Reasoning
  /the reason|because.*approach|trade-?off/im,
  /\bthis works because\b/im,
  /\bthe reason\b/im,
  /\bbecause of\b/im,
  // Usage
  /(?:will|'ll) use .{3,30} (?:instead|for this|here)/im,
  /\bwe('?ll| will) use\b/im,
];

const META_FILTER_RE =
  /Transformers\s+are\s+overkill|looking\s+for\s+['"‘“]|pattern\s+matched|keep\s+verbatim|overkill\s+when\s+you|detection\s+pattern|internal\s+regex|you['’]re\s+looking\s+for|scan\s+(the\s+)?first\s+\d/i;

function extractDecisions(messages: Message[]): string {
  const items: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const sentences = msg.content.split(/[.!?\n]/).filter((s) => s.trim().length > 20);
    for (const s of sentences) {
      if (DECISION_RE.some((re) => re.test(s)) && !META_FILTER_RE.test(s)) {
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
  for (const msg of messages) {
    const sentences = msg.content.split(/[.!?\n]/).filter((s) => s.trim().length > 20);
    for (const s of sentences) {
      if (FACT_RE.some((re) => re.test(s))) {
        items.push(`- ${s.trim()}`);
      }
    }
  }
  return dedupe(items).slice(0, 8).join("\n");
}

// ── Code extraction — NEVER truncate individual code block content ───────────
// At 1000+ messages a session can contain hundreds of code fences.
// Cap at MAX_CODE_BLOCKS to prevent the assembled prompt from overflowing
// AI platform context windows.  The most recent messages are processed last,
// so we process messages in reverse and then reverse again to preserve order.
const MAX_CODE_BLOCKS = 30;

function extractAllCodeBlocks(messages: Message[]): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const codeRe = /```([\w-]*)[ \t]*\n([\s\S]*?)```/g;

  for (const msg of [...messages].reverse()) {
    if (blocks.length >= MAX_CODE_BLOCKS) break;
    let match: RegExpExecArray | null;
    codeRe.lastIndex = 0;
    while ((match = codeRe.exec(msg.content)) !== null) {
      if (blocks.length >= MAX_CODE_BLOCKS) break;
      const language = match[1].trim();
      if (!language) continue; // Skip unlabeled fences — plain prose must never enter the code section
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

  return blocks.reverse(); // restore chronological order (collected newest-first)
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
  /\bi['']ll use\b/i,
  /\bbest approach\b/i,
  /\bwe decided\b/i,
  /\bthe fix is\b/i,
  /\buse\s+\S+\s+for\b/i,
  /\bthis works because\b/i,
  /\bgoing with\b/i,
  /\bopted for\b/i,
  /\blet['']s use\b/i,
  /\bswitched to\b/i,
  /\bmoved to\b/i,
  /\breplaced with\b/i,
  /\bchose\b/i,
  /\bchose to\b/i,
  /\binstead of\b/i,
  /\brather than\b/i,
  /\bsticking with\b/i,
  /\bwe['']re using\b/i,
  /\bwent with\b/i,
  /\bmigrating to\b/i,
  /\bwe will use\b/i,
  /\bthe approach is\b/i,
  /\bwe use\b/i,
  /\bdecided to\b/i,
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
  completed: string[];
  pending: string[];
  codeBlocks: { language: string; path?: string; code: string }[];
  tail: Message[];
  originalCount: number;
  compressionRatio: number;
}

export function summarizeIntelligent(messages: Message[], task?: string): IntelligentSummary {
  if (!messages.length) throw new Error('[CM:summarizer:tier2] Empty messages array — nothing to summarize');
  const t0 = Date.now();

  // ── 1. Goal — first user message, up to 600 chars ─────────────────────────────
  const userMessages = messages.filter((m) => m.role === "user");
  const goal =
    userMessages.length > 0
      ? userMessages[0].content.trim().slice(0, 600) || "Not specified"
      : "Not specified";

  // ── 5. Current state — last 8 messages regardless of role ───────────────────
  // Using all-role window captures assistant-introduced direction changes
  // (e.g. "I recommend Supabase" + user "ok") not visible in user-only slice.
  let stateWindow = messages.slice(-8);
  // Skip a short ack at the tip to avoid "ok" becoming the currentState anchor.
  const stateTip = stateWindow[stateWindow.length - 1];
  if (stateTip && stateTip.role === "user" && stateTip.content.trim().length < 20) {
    stateWindow = stateWindow.slice(0, -1);
  }
  const currentState =
    stateWindow.length > 0
      ? stateWindow
          .map((m) => {
            const t = m.content.trim();
            return t.length > 300 ? t.slice(0, 300) + "…" : t;
          })
          .join(" → ")
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
      if (TIER2_DECISION_RE.some((re) => re.test(s)) && !META_FILTER_RE.test(s)) rawDecisions.push(s);
    }
  }
  let decisions = dedupe(rawDecisions).slice(0, 20);

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
  let codeBlocks: { language: string; path?: string; code: string }[] = [];
  const codeRe = /```([\w-]*)[ \t]*\n([\s\S]*?)```/g;
  for (const msg of messages) {
    let match: RegExpExecArray | null;
    codeRe.lastIndex = 0;
    while ((match = codeRe.exec(msg.content)) !== null) {
      const language = match[1].trim();
      if (!language) continue; // Skip unlabeled fences — plain prose must never enter the code section
      const code = match[2]; // Never truncated.
      const firstLine = code.split("\n")[0]?.trim() ?? "";
      const pathMatch =
        firstLine.match(/^(?:\/\/|#|--)\s+([\w./\\-]+\.\w+)\s*$/) ??
        firstLine.match(/^\/\*\*?\s*([\w./\\-]+\.\w+)\s*\*\//);
      codeBlocks.push({ language, path: pathMatch?.[1], code });
    }
  }

  // ── Dedupe + cap code blocks — path-annotated first, max 15.
  // Code is NEVER truncated — losing partial code makes it unusable. The
  // count cap (15) is enough to keep total file size bounded while keeping
  // each block 100% verbatim, per the migration-quality spec.
  {
    const seen = new Set<string>();
    const pathBlocks = codeBlocks.filter(b => b.path);
    const anonBlocks = codeBlocks.filter(b => !b.path);
    const deduped = [...pathBlocks, ...anonBlocks].filter(b => {
      const key = b.path ?? b.code.slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    codeBlocks = deduped.slice(0, 15);
  }

  // ── Task-aware boosting — re-rank decisions and code blocks by task relevance
  if (task) {
    const taskWords = task.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (taskWords.length > 0) {
      const decisionsAll = decisions;
      const taskFiltered = decisions.filter((d) =>
        taskWords.some((w) => d.toLowerCase().includes(w))
      );
      decisions = taskFiltered.length > 0 ? taskFiltered : decisionsAll;

      codeBlocks = [...codeBlocks].sort((a, b) => {
        const score = (item: typeof a) =>
          taskWords.some(
            (w) => item.code.toLowerCase().includes(w) ||
                   (item.path ?? "").toLowerCase().includes(w)
          ) ? 1 : 0;
        return score(b) - score(a);
      });
    }
  }

  // ── 6. Tail — verbatim recent messages. Size scales with conversation
  // length so short sessions don't get over-compressed:
  //   • ≤30 msgs  → include ALL messages verbatim (nothing to compress)
  //   • 31–80 msgs → keep last 12 (~60-70% compression on typical content)
  //   • >80 msgs   → keep last MAX_VERBATIM_MESSAGES (6, per long-session spec)
  // This guarantees the spec rule "last 6 messages always in output" while
  // including more of the conversation for shorter sessions.
  const tailSize =
    messages.length <= 30
      ? messages.length
      : messages.length <= 80
        ? 12
        : MAX_VERBATIM_MESSAGES;
  const tail = messages.slice(-tailSize);

  // ── 7. Completed tasks — same COMPLETED_RE used by extractContext() ───────
  const rawCompleted: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (!COMPLETED_RE.some((re) => re.test(msg.content))) continue;
    const firstLine = msg.content.split("\n")[0].trim();
    const sentence = firstLine.split(/[.!?]/)[0].trim();
    if (sentence.length > 10 && sentence.length < 200) rawCompleted.push(sentence);
  }
  const completed = dedupe(rawCompleted).slice(0, 12);

  // ── 8. Pending tasks — same PENDING_RE, last 20 messages ─────────────────
  const rawPending: string[] = [];
  for (const msg of messages.slice(-20)) {
    if (!PENDING_RE.some((re) => re.test(msg.content))) continue;
    const sentences = msg.content.split(/[.!?\n]/).filter((s) => s.trim().length > 15);
    for (const sentence of sentences) {
      if (PENDING_RE.some((re) => re.test(sentence))) rawPending.push(sentence.trim());
    }
  }
  const pending = dedupe(rawPending).slice(0, 10);

  // ── Compression ratio ─────────────────────────────────────────────────────
  const originalSize = messages.reduce((s, m) => s + m.content.length, 0);
  const extractedSize =
    goal.length +
    currentState.length +
    decisions.reduce((s, d) => s + d.length, 0) +
    bugsFixed.reduce((s, b) => s + b.length, 0) +
    completed.reduce((s, c) => s + c.length, 0) +
    pending.reduce((s, p) => s + p.length, 0) +
    codeBlocks.reduce((s, c) => s + c.code.length, 0) +
    tail.reduce((s, m) => s + m.content.length, 0);
  const compressionRatio =
    originalSize > 0 ? Math.round((1 - extractedSize / originalSize) * 100) : 0;

  console.log(
    `[ContextMover:tier2] ${messages.length} msgs \u2192 extracted:\n` +
    `  goals=1 decisions=${decisions.length} bugs=${bugsFixed.length} ` +
    `completed=${completed.length} pending=${pending.length} ` +
    `code_blocks=${codeBlocks.length} \u2192 ${extractedSize} chars ` +
    `(${compressionRatio}% compressed) [${Date.now() - t0}ms]`
  );

  return {
    goal,
    currentState,
    decisions,
    bugsFixed,
    completed,
    pending,
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
      `[ContextMover:summarizer] summarizeWithAttention: msgs=${messages.length}→${processed.length} compression=${compressionRatio}%`
    );

    return { summary, attentionMap, compressionRatio };
  } catch (err) {
    console.warn(
      "[ContextMover:summarizer] summarizeWithAttention failed — falling back to summarize():",
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
