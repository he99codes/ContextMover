/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/summarizer.ts
// Structured context extractor.
// Two outputs per call:
//   extracted — rich structured object used by translator.ts for per-model formatting
//   content   — legacy plain-text fallback for backward compatibility

// Bump this when summarizer extraction logic changes to invalidate cached
// summaries in IndexedDB. Without this, stale (potentially broken) summaries
// are served for up to 24 hours after a code change.
export const SUMMARIZER_VERSION = 3;

import type { CodeBlock, ContextSession, ExtractedContext, Message, ScoredMessage } from "./types";
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
  options?: { caveman?: boolean; skipHardLimit?: boolean }
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
    // Tier 1b (30–100 msgs): keep first 5 + last 10 verbatim; compress middle to 2 sentences.
    mode = "summarized";
    const headCount = 5;
    const tailCount = 10;
    const tailStart = Math.max(headCount, messages.length - tailCount);
    const head   = messages.slice(0, headCount);
    const middle = messages.slice(headCount, tailStart);
    const tail   = messages.slice(tailStart);
    const processedMiddle = middle.map((msg) =>
      msg.role === "user" ? msg : { ...msg, content: compressTier1Assistant(msg.content, 2) }
    );
    content = [...head, ...processedMiddle, ...tail]
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");
  } else {
    // Tier 1c aggressive (>100 msgs): target 80%+ compression.
    // • First 5 messages:  verbatim (keep)         — establishes goal + setup
    // • Last 10 messages:  verbatim (keep)         — what the user is doing now
    // • All code blocks:   100% full content (keep)
    // • User messages:     verbatim (keep — they are short)
    // • Middle assistant messages:
    //     → Score by signal density (errors, decisions, code, length, recency)
    //     → Keep the top tier verbatim; compress the rest to a key decision;
    //       drop pure-fluff messages with no signal at all.
    mode = "summarized";
    const HEAD_COUNT = 5;
    const TAIL_COUNT = 10;
    const tailStart = Math.max(HEAD_COUNT, messages.length - TAIL_COUNT);
    const head   = messages.slice(0, HEAD_COUNT);
    const middle = messages.slice(HEAD_COUNT, tailStart);
    const tail   = messages.slice(tailStart);

    // Compute a 0..1 importance score for each middle message. Pure-logic —
    // no embedding round-trip in the summarizer hot path. Top quartile is
    // kept verbatim; the rest goes through the existing decision-extractor.
    const scoreMessage = (m: Message, idxInMiddle: number): number => {
      let score = 0;
      if (hasErrorOrStackTrace(m.content)) score += 0.45;
      if (/```[\s\S]*?```/.test(m.content)) score += 0.25;
      if (KEY_DECISION_PATTERNS.some((re) => re.test(m.content))) score += 0.20;
      // Length: very short messages rarely carry signal; cap the boost.
      score += Math.min(0.10, m.content.length / 8000);
      // Recency bias inside the middle window — later middle messages slightly
      // outrank earlier ones at equal signal density.
      score += 0.05 * (idxInMiddle / Math.max(1, middle.length - 1));
      return Math.min(1, score);
    };

    const scored = middle.map((m, i) => ({ m, i, s: scoreMessage(m, i) }));
    const sortedScores = [...scored].map((x) => x.s).sort((a, b) => b - a);
    // Top-quartile cutoff. Falls back to a sane minimum on tiny middles.
    const cutoffIndex = Math.max(0, Math.floor(sortedScores.length * 0.25) - 1);
    const KEEP_VERBATIM_THRESHOLD = sortedScores[cutoffIndex] ?? 0.5;

    const processedMiddle: Message[] = [];
    for (const { m: msg, s: score } of scored) {
      if (msg.role === "user") { processedMiddle.push(msg); continue; }
      // Error / stack trace — always keep verbatim.
      if (hasErrorOrStackTrace(msg.content)) { processedMiddle.push(msg); continue; }
      // High-signal assistant message — keep verbatim.
      if (score >= KEEP_VERBATIM_THRESHOLD && score >= 0.30) {
        processedMiddle.push(msg);
        continue;
      }

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
  // one by one until we fit. Head (5) and tail (10) are always preserved.
  // Skipped for file-based migrations (skipHardLimit=true) because the file is
  // uploaded directly — there is no context-window paste limit to respect.
  const MAX_OUTPUT_CHARS = 48_000;
  if (!options?.skipHardLimit && content.length > MAX_OUTPUT_CHARS && msgCount >= 30) {
    const headCount = 5;
    const tailCount = 10;
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

// [CM-T2-FIX] prompt-message filter — prevents regex extraction from matching
// on user prompts that contain keywords like "fix", "error", "decided" etc.
function isLikelyPromptMessage(content: string): boolean {
  if (content.startsWith('You are a')) return true;
  if (content.startsWith('Read every file')) return true;
  if (content.startsWith('TASK —')) return true;
  if (content.startsWith('REQUIRED')) return true;
  const codeBlockChars = (content.match(/```[\s\S]*?```/g) ?? [])
    .reduce((sum, block) => sum + block.length, 0);
  return codeBlockChars / content.length > 0.4;
}

// [CM-T2-FIX-3] Meta-discussion filter — skips messages that are pure AI model
// comparisons or benchmark discussions. MUST NOT filter messages that merely
// reference AI platform names in the context of building a product that targets
// those platforms (e.g. ContextMover discusses Claude/ChatGPT/Gemini constantly
// as its product targets — those are NOT meta-discussion).
function isMetaDiscussion(content: string): boolean {
  if (content.length < 30) return false;
  // Only flag pure benchmark/model-selection discussions — require both:
  //   (a) 5+ distinct model-family mentions AND
  //   (b) comparison context words like "benchmark", "vs", "compared to"
  const MODEL_RE = /\b(?:GPT-?[34o]|Haiku|Sonnet|Opus|Llama|Mistral|Gemma|Qwen|Kimi|Copilot)\b/gi;
  const distinctModels = new Set((content.match(MODEL_RE) ?? []).map(m => m.toLowerCase()));
  const hasComparisonContext = /\b(?:benchmark|leaderboard|eval(?:uation)?|ranking|compared? to|versus|\bvs\.?\b|outperform|scores? higher)\b/i.test(content);
  if (distinctModels.size >= 5 && hasComparisonContext) return true;
  if (/\bSWE-bench\b|\bSWE bench\b/i.test(content)) return true;
  return false;
}

// [CM-T2-FIX] multi-window goal sampling — captures goal evolution, not just opening
function extractEvolvingGoal(messages: Message[]): string {
  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length === 0) return '';

  const positions = [
    0,
    Math.floor(userMessages.length * 0.25),
    Math.floor(userMessages.length * 0.5),
    Math.floor(userMessages.length * 0.75),
    userMessages.length - 1,
  ];

  const candidates = [...new Set(positions)]
    .map(i => userMessages[i]?.content ?? '')
    .filter(c => c.length > 30 && c.length < 800)
    .filter(c => !c.startsWith('You are a') && !c.startsWith('Read every file'));

  if (candidates.length === 0) {
    return userMessages[userMessages.length - 1]?.content?.slice(0, 400) ?? '';
  }

  return candidates[candidates.length - 1].slice(0, 400);
}

// ── Goal extraction ───────────────────────────────────────────────────────────

// Patterns that indicate a message is a migration/bootstrap instruction
// rather than a real goal. The first user message in a migrated session is
// often a <context_migration> XML block — using it as the goal produces
// garbage like "I am continuing a conversation from claude..."
const MIGRATION_INSTRUCTION_RE =
  /^<context_migration>|<instruction>\s*I am continuing a conversation from/i;

function extractPrimaryGoal(messages: Message[]): string {
  const userMessages = messages.filter((m) => m.role === "user");
  if (!userMessages.length) return "Not specified";
  // Skip migration/bootstrap instructions — they are not real goals.
  let first = userMessages[0].content.trim();
  let idx = 0;
  while (idx < userMessages.length && MIGRATION_INSTRUCTION_RE.test(first)) {
    idx++;
    first = userMessages[idx]?.content.trim() ?? "Not specified";
  }
  return first.length > 600 ? first.slice(0, 600) + "…" : first;
}

function extractCurrentFocus(messages: Message[]): string {
  if (!messages.length) return "Not specified";
  // Use last 3 substantive messages (skip short acks < 20 chars).
  // Previously used last 8 joined with " → " which produced an unreadable
  // 1000+ char blob. 3 messages is enough to capture the current direction.
  const substantive: Message[] = [];
  for (let i = messages.length - 1; i >= 0 && substantive.length < 3; i--) {
    const m = messages[i];
    if (m.content.trim().length < 20) continue;
    substantive.unshift(m);
  }
  if (!substantive.length) return "Not specified";
  return substantive
    .map((m) => {
      const text = m.content.trim();
      return text.length > 300 ? text.slice(0, 300) + "…" : text;
    })
    .join("\n");
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

// [CM-T2-FIX] role filter + prompt filter on old decisions path
function extractDecisions(messages: Message[]): string {
  const items: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (isLikelyPromptMessage(msg.content)) continue;
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

// [CM-T2-FIX] prompt filter on old facts path
function extractFacts(messages: Message[]): string {
  const items: string[] = [];
  for (const msg of messages) {
    if (isLikelyPromptMessage(msg.content)) continue;
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
      const rawLang = match[1].trim();
      const content = match[2]; // Full content — never truncated
      // Accept unlabeled fences only when the body looks like code (has
      // programming syntax chars + at least 2 non-empty lines). This captures
      // Claude artifacts that omit the language tag while excluding plain-prose
      // block-quote fences.
      const CODE_SYNTAX_RE = /[{}()[\];=<>]|=>|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\bdef\b|\bclass\b/;
      if (!rawLang) {
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        if (lines.length < 2 || !CODE_SYNTAX_RE.test(content)) continue;
      }
      const language = rawLang || 'text';

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

// [CM-T2-FIX-2] Tightened decision regexes — only match FIRST-PERSON architectural
// decisions made in THIS conversation, not meta-discussion or advice about AI tools.
// Key principle: a decision is something WE did/chose, not something we're discussing.
const TIER2_DECISION_RE = [
  /\bwe decided\b/i,
  /\bi('?ve| have) decided\b/i,
  /\bdecided to\b/i,
  /\bthe fix is\b/i,
  /\bthe fix was\b/i,
  /\bgoing with\b/i,
  /\bwent with\b/i,
  /\bopted for\b/i,
  /\bchose to\b/i,
  /\bwe chose\b/i,
  /\bi chose\b/i,
  /\bswitched to\b/i,
  /\bswitching to\b/i,
  /\breplaced.*?with\b/i,
  /\blet['\u2019]s use\b/i,
  /\bwe['\u2019]re using\b/i,
  /\bwe will use\b/i,
  /\bwe use\b/i,
  /\bi['\u2019]ll use\b/i,
  /\bthe approach is\b/i,
  /\bbest approach is\b/i,
  /\bthis works because\b/i,
  /\bmigrating to\b/i,
  /\bsticking with\b/i,
  /\bmoved (?:the|it|this|everything) to\b/i,
  // [CM-T2-FIX-3] advisory/recommendation patterns
  /\bi['\u2019]d (?:recommend|suggest|build|use)\b/i,
  /\byou should\b/i,
  /\bthe (?:right|correct|best|recommended|durable|stronger) (?:approach|strategy|solution|fix|architecture|pattern|way)\b/i,
  /\bfix (?:that|this|it) first\b/i,
  /\binstead of\b.*\buse\b/i,
  /\brather than\b/i,
  /\bthe key (?:insight|change|difference|improvement) is\b/i,
  /\bthis (?:is|was) (?:the|a) (?:correct|right|better|proper|durable)\b/i,
  /\bthe (?:real|actual|core|underlying) (?:issue|problem|cause) (?:is|was)\b/i,
  /\bpractical plan\b/i,
  /\bimmediate action\b/i,
  /\bphase \d\b.*?:/i,
];

// [CM-T2-FIX-2] Tightened bug regexes — require concrete cause/fix phrasing,
// not just sentences that mention 'root cause' or 'issue' in passing.
const TIER2_BUG_RE = [
  // Concrete cause identification
  /\bthe (?:root )?cause (?:was|is)\b/i,
  /\bbug was caused by\b/i,
  /\berror occurs because\b/i,
  /\bcaused by (?:the|a|an)\b/i,
  /\bturned out (?:to be|that) (?:the|a|an)\b/i,
  /\bthe (?:real )?(?:bug|issue|error|problem) (?:was|is) (?:that|in|because|caused)\b/i,
  /\bbecause of (?:the|a|an) (?:missing|stale|bad|wrong|incorrect|broken)\b/i,
  // Concrete fix descriptions
  /\bfixed (?:it|this|the bug|the issue|the error) by\b/i,
  /\bresolved by\b/i,
  /\bthe fix (?:was|is)\b/i,
  // Concrete symptoms with specific type names (not generic 'issue')
  /\bthrows? (?:a |an )?[A-Z]\w+(?:Error|Exception)\b/,
  /\b(?:race condition|deadlock|null pointer|memory leak|off[- ]by[- ]one|infinite loop)\b/i,
  /\bregression\b/i,
  // [CM-T2-FIX-3] broader failure/breakage patterns
  /\b(?:is|was|keeps?) break(?:ing|s)\b/i,
  /\b(?:is|was) fail(?:ing|ed)\b/i,
  /\bfails? to (?:parse|extract|detect|capture|load|render|inject|match)\b/i,
  /\bnot (?:matching|detecting|capturing|parsing|loading|rendering)\b/i,
  /\breturning? (?:0|null|undefined|empty|nothing|no (?:results?|data|messages?))\b/i,
  /\blogs? show\b/i,
  /\bHTTP [45]\d\d\b/,
  /\b(?:selector|element|container) (?:not found|missing|changed|broken)\b/i,
  /\bfailed to (?:fetch|load|parse|connect|index)\b/i,
  // Negated modal + specific action that fails
  /\b(?:wasn['’]t|isn['’]t|doesn['’]t) (?:work|render|load|fire|trigger|update|fetch|save|persist)(?:ing|ed)?\b/i,
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
  techStack?: string[];
  coverageStats?: {
    messagesScored: number;
    messagesUsed: number;
    categoryCounts: Record<string, number>;
  };
}

// ── Hierarchical importance scorer (0–10) ────────────────────────────────────
// Pure heuristics — no ML, no async.
function scoreDecisionHierarchical(sentence: string): number {
  let s = 0;
  if (/\broot cause\b|\bcaused by\b|\bfixed by\b|\bresolved by\b/i.test(sentence)) s += 3;
  if (/\bdecided\b|\bchose\b|\bopted for\b|\bwent with\b|\bgoing with\b/i.test(sentence)) s += 2;
  if (/\binstead of\b|\brather than\b|\bswitching to\b|\bmigrating to\b/i.test(sentence)) s += 2;
  if (/`[^`]+`|\b[A-Z][a-zA-Z]+Error\b/.test(sentence)) s += 2;
  if (/\bthis works because\b|\bthe reason\b|\bbecause of\b/i.test(sentence)) s += 1;
  s += Math.min(1, sentence.length / 400);
  return Math.min(10, s);
}

function scoreBugHierarchical(sentence: string): number {
  let s = 0;
  if (/\broot cause\b|\bcaused by\b|\bfixed by\b|\bresolved by\b/i.test(sentence)) s += 4;
  if (/\b[A-Z][a-zA-Z]+(?:Error|Exception)\b/.test(sentence)) s += 3;
  if (/\brace condition\b|\bnull pointer\b|\bmemory leak\b|\bdeadlock\b/i.test(sentence)) s += 3;
  if (/\bworkaround\b|\bhotfix\b|\bpatched\b/i.test(sentence)) s += 1;
  // [CM-T2-FIX-3] score the broader failure patterns
  if (/\bbreak(?:ing|s)\b|\bfail(?:ing|ed|s)\b/i.test(sentence)) s += 2;
  if (/\bfailed to\b|\bnot (?:found|matching|detecting)\b/i.test(sentence)) s += 2;
  if (/\bHTTP [45]\d\d\b/i.test(sentence)) s += 2;
  s += Math.min(1, sentence.length / 400);
  return Math.min(10, s);
}

// ── Context threading ────────────────────────────────────────────────────────
// Prevent orphaned references — if a tail message refers to something from
// earlier, pull in up to 2 preceding messages so the reference makes sense.
const ORPHANED_REF_RE = [
  /\bthat (?:error|bug|issue|fix|problem)\b/i,
  /\bthe (?:same|previous|above|earlier) (?:error|bug|issue|approach|fix|solution)\b/i,
  /\bas (?:mentioned|discussed|noted) (?:above|before|earlier)\b/i,
  /\bsame (?:issue|problem|error|bug) as\b/i,
  /\bthis (?:same|exact) (?:error|bug|issue)\b/i,
];

function threadContextualMessages(messages: Message[], tail: Message[]): Message[] {
  const indexedSet = new Set(tail.map((m) => messages.indexOf(m)));
  const extra: Message[] = [];
  for (const msg of tail) {
    const idx = messages.indexOf(msg);
    if (idx <= 0) continue;
    if (ORPHANED_REF_RE.some((re) => re.test(msg.content))) {
      for (let back = 1; back <= 2 && idx - back >= 0; back++) {
        const prevIdx = idx - back;
        if (!indexedSet.has(prevIdx)) {
          extra.push(messages[prevIdx]);
          indexedSet.add(prevIdx);
        }
      }
    }
  }
  return [...extra, ...tail].sort(
    (a, b) => messages.indexOf(a) - messages.indexOf(b)
  );
}

// ── Tech stack extraction ─────────────────────────────────────────────────────
// Scans code block imports and language tags to surface the active tech stack.
const TECH_MAP: [RegExp, string][] = [
  [/\breact\b/i,                     "React"],
  [/\bnext[/\s]|next\.config/i,      "Next.js"],
  [/\bvite\b/i,                      "Vite"],
  [/\bvue\b/i,                       "Vue"],
  [/\bsvelte\b/i,                    "Svelte"],
  [/\bangular\b/i,                   "Angular"],
  [/\bexpress\b/i,                   "Express"],
  [/\bfastapi\b|\bflask\b|\bdjango\b/i, "Python Web"],
  [/\bprisma\b/i,                    "Prisma"],
  [/\bsupabase\b/i,                  "Supabase"],
  [/\bdrizzle\b/i,                   "Drizzle"],
  [/\btailwind\b/i,                  "TailwindCSS"],
  [/\btrpc\b/i,                      "tRPC"],
  [/\bgraphql\b/i,                   "GraphQL"],
  [/\bprisma\b/i,                    "Prisma"],
  [/\bwebpack\b/i,                   "Webpack"],
  [/\bdocker\b/i,                    "Docker"],
  [/\bkubernetes\b|\bk8s\b/i,        "Kubernetes"],
  [/\bpostgres\b|\bpg\b/i,           "PostgreSQL"],
  [/\bmongodb\b|\bmongoose\b/i,      "MongoDB"],
  [/\bredis\b/i,                     "Redis"],
  [/\btypescript\b|\.tsx?\b/i,       "TypeScript"],
  [/\bpython\b|import numpy|import pandas/i, "Python"],
  [/\brust\b|\bcargo\b/i,            "Rust"],
  [/\bgolang\b|\bgo\b/i,             "Go"],
];

function extractTechStack(messages: Message[]): string[] {
  const detected = new Set<string>();
  const codeRe = /```([\w-]*)[ \t]*\n([\s\S]*?)```/g;
  for (const msg of messages) {
    let m: RegExpExecArray | null;
    codeRe.lastIndex = 0;
    while ((m = codeRe.exec(msg.content)) !== null) {
      const lang = m[1].trim().toLowerCase();
      const body = m[2];
      if (["typescript", "tsx", "ts"].includes(lang)) detected.add("TypeScript");
      else if (["javascript", "jsx", "js"].includes(lang)) detected.add("JavaScript");
      else if (lang === "python" || lang === "py") detected.add("Python");
      else if (lang === "rust") detected.add("Rust");
      else if (lang === "go") detected.add("Go");
      else if (["css", "scss"].includes(lang)) detected.add("CSS");
      for (const [re, label] of TECH_MAP) {
        if (re.test(body)) detected.add(label);
      }
    }
  }
  return [...detected].slice(0, 12);
}

export function summarizeIntelligent(messages: Message[], task?: string): IntelligentSummary {
  if (!messages.length) throw new Error('[CM:summarizer:tier2] Empty messages array — nothing to summarize');
  const t0 = Date.now();

  // ── 1. Goal — first substantive user message, up to 600 chars ────────────────
  // Skip migration/bootstrap instructions (e.g. <context_migration> pastes)
  // and trivially short/generic messages (e.g. "say ok", "hi", "understand this").
  // [CM-T2-FIX-3] A goal must be either ≥50 chars or contain technical terms.
  const TRIVIAL_GOAL_RE = /^(?:ok|hi|hello|hey|say\s+(?:ok|hi|hello)|understand|read\s+(?:this|it|the)|look\s+at|check\s+(?:this|it)|continue|go\s+ahead)\b/i;
  const TECH_TERM_RE = /\b(?:fix|bug|error|build|deploy|implement|create|add|update|refactor|migrate|test|debug|api|function|component|route|endpoint|database|schema)\b/i;
  const userMessages = messages.filter((m) => m.role === "user");
  let goalIdx = 0;
  while (goalIdx < userMessages.length) {
    const text = userMessages[goalIdx].content.trim();
    if (MIGRATION_INSTRUCTION_RE.test(text)) { goalIdx++; continue; }
    if (text.length < 50 && !TECH_TERM_RE.test(text)) { goalIdx++; continue; }
    if (TRIVIAL_GOAL_RE.test(text) && text.length < 80) { goalIdx++; continue; }
    break;
  }
  const goal =
    goalIdx < userMessages.length
      ? userMessages[goalIdx].content.trim().slice(0, 600) || "Not specified"
      : "Not specified";

  // [CM-T2-FIX] current state — multi-window goal sampling, not last-3 blob
  const currentState = extractEvolvingGoal(messages) || "Not specified";

  // ── 2. Decisions — verbatim sentences from assistant messages only ─────────
  // [CM-T2-FIX] skip prompt-like messages so regex doesn't match on instructions
  const rawDecisions: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (isLikelyPromptMessage(msg.content)) continue;
    if (isMetaDiscussion(msg.content)) continue;
    const sentences = msg.content
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20 && s.length < 400);
    for (const s of sentences) {
      if (TIER2_DECISION_RE.some((re) => re.test(s)) && !META_FILTER_RE.test(s)) rawDecisions.push(s);
    }
  }
  const scoredDecisions = dedupe(rawDecisions)
    .map((d) => ({ d, score: scoreDecisionHierarchical(d) }))
    .sort((a, b) => b.score - a.score);
  let decisions = scoredDecisions.map((x) => x.d).slice(0, 20);

  // [CM-T2-FIX] Bugs fixed — assistant messages only + prompt filter
  const rawBugs: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (isLikelyPromptMessage(msg.content)) continue;
    if (isMetaDiscussion(msg.content)) continue;
    const sentences = msg.content
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20 && s.length < 400);
    for (const s of sentences) {
      if (TIER2_BUG_RE.some((re) => re.test(s))) rawBugs.push(s);
    }
  }
  const bugsFixed = dedupe(rawBugs)
    .map((b) => ({ b, score: scoreBugHierarchical(b) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.b)
    .slice(0, 15);

  // ── 4. Code blocks — ALL ``` fences, 100% content, language + path ────────
  let codeBlocks: { language: string; path?: string; code: string }[] = [];
  const codeRe = /```([\w-]*)[ \t]*\n([\s\S]*?)```/g;
  for (const msg of messages) {
    let match: RegExpExecArray | null;
    codeRe.lastIndex = 0;
    while ((match = codeRe.exec(msg.content)) !== null) {
      const rawLang2 = match[1].trim();
      const code = match[2]; // Never truncated.
      if (!rawLang2) {
        const lines2 = code.split('\n').filter(l => l.trim().length > 0);
        const hasSyntax2 = /[{}()[\];=<>]|=>|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\bdef\b|\bclass\b/.test(code);
        if (lines2.length < 2 || !hasSyntax2) continue;
      }
      const language = rawLang2 || 'text';
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
  // [CM-T2-FIX-3] Filter out plaintext design docs — language='text' blocks
  // over 200 chars without real programming syntax are design notes, ASCII art,
  // or prompt templates. They waste tokens and dilute actual code.
  {
    const CODE_SYNTAX_RE = /[{}()[\];=<>]|=>|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\bdef\b|\bclass\b|\bimport\b|\bexport\b|\breturn\b|\bif\b\s*\(/;
    codeBlocks = codeBlocks.filter(b => {
      if (b.language !== 'text') return true;
      if (b.path) return true;
      if (b.code.length < 200) return true;
      return CODE_SYNTAX_RE.test(b.code);
    });
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

  // ── 6a. Tech stack ────────────────────────────────────────────────────────
  const techStack = extractTechStack(messages);

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
  const rawTail = messages.slice(-tailSize);
  const tail = threadContextualMessages(messages, rawTail);

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

  // ── 8. Pending tasks — same PENDING_RE, last 40 messages ─────────────────
  // [CM-FIX] expanded pending scan window from 20 to 40 messages
  const rawPending: string[] = [];
  for (const msg of messages.slice(-40)) {
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
    originalSize > 0 ? Math.max(0, Math.round((1 - extractedSize / originalSize) * 100)) : 0;

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
    techStack,
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
      originalSize > 0 ? Math.max(0, Math.round((1 - compressedSize / originalSize) * 100)) : 0;

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

// [CM-T2-ENHANCE] Category thresholds, top-N, and minimum floors.
const T2_SCORE_THRESHOLDS: Record<string, number> = {
  goals: 0.25, decisions: 0.30, bugs: 0.32, context: 0.28, questions: 0.30,
};
const T2_TOP_N: Record<string, number> = {
  goals: 6, decisions: 10, bugs: 12, context: 8, questions: 5,
};
const T2_MIN_FLOOR: Record<string, number> = {
  goals: 2, decisions: 3, bugs: 3, context: 2, questions: 1,
};

function selectForCategory(scored: ScoredMessage[], cat: string): Message[] {
  const th = T2_SCORE_THRESHOLDS[cat] ?? 0.30;
  const topN = T2_TOP_N[cat] ?? 8;
  const floor = T2_MIN_FLOOR[cat] ?? 2;
  const filtered = scored.filter((m) => (m.scores as any)[cat] >= th);
  if (filtered.length < floor) {
    const by = [...scored].sort((a, b) => (b.scores as any)[cat] - (a.scores as any)[cat]);
    return by.slice(0, floor).sort((a, b) => a.index - b.index).map(
      (sm): Message => ({ role: sm.role, content: sm.content, timestamp: 0 }));
  }
  const w = filtered.map((m) => ({ m, w: (m.scores as any)[cat] * m.recencyBoost }));
  w.sort((a, b) => b.w - a.w);
  return w.slice(0, topN).sort((a, b) => a.m.index - b.m.index).map(
    (x) => ({ role: x.m.role, content: x.m.content, timestamp: 0 }));
}

// Helper to run Tier 2's specific decision extraction loop on a subset
// [CM-T2-FIX] role filter + prompt filter on decisions
function _extractDecisionsT2(msgs: Message[]): string[] {
  const raw: string[] = [];
  for (const msg of msgs) {
    if (msg.role !== "assistant") continue;
    if (isLikelyPromptMessage(msg.content)) continue;
    if (isMetaDiscussion(msg.content)) continue;
    const sentences = msg.content.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 20);
    for (const s of sentences) {
      if (TIER2_DECISION_RE.some((re) => re.test(s)) && !META_FILTER_RE.test(s)) raw.push(s);
    }
  }
  return dedupe(raw).map((d) => ({ d, score: scoreDecisionHierarchical(d) })).sort((a, b) => b.score - a.score).map((x) => x.d);
}

// Helper to run Tier 2's specific bug extraction loop on a subset
// [CM-T2-FIX] role filter + prompt filter on bugs
function _extractBugsT2(msgs: Message[]): string[] {
  const raw: string[] = [];
  for (const msg of msgs) {
    if (msg.role !== "assistant") continue;
    if (isLikelyPromptMessage(msg.content)) continue;
    if (isMetaDiscussion(msg.content)) continue;
    const sentences = msg.content.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 20);
    for (const s of sentences) {
      if (TIER2_BUG_RE.some((re) => re.test(s))) raw.push(s);
    }
  }
  return dedupe(raw).map((b) => ({ b, score: scoreBugHierarchical(b) })).sort((a, b) => b.score - a.score).map((x) => x.b);
}

/**
 * [CM-T2-ENHANCE] Transformer-enhanced Tier 2 summary.
 */
export async function buildTier2WithScoring(
  session: ContextSession,
  scoredMessages: ScoredMessage[],
  task?: string,
  tokenBudget = 3800,
): Promise<IntelligentSummary> {
  const t0 = Date.now();
  const hasScores = scoredMessages.some((m) => Object.values(m.scores).some((s) => s > 0));
  if (!hasScores) return summarizeIntelligent(session.messages, task);

  const base = summarizeIntelligent(session.messages, task);

  const goalMsgs = selectForCategory(scoredMessages, "goals");
  const goals: string[] = [];
  for (const m of goalMsgs) {
    const c = m.content.replace(/<context_migration>[\s\S]*?<\/context_migration>/g, "").trim();
    if (c.length < 15) continue;
    const s = c.split(/[.?!]\s+/)[0];
    if (s && s.length >= 10 && s.length <= 600) goals.push(s.trim());
  }
  const enhancedGoal = goals.length > 0 ? goals.join(" | ") : base.goal;
  const decMsgs = selectForCategory(scoredMessages, "decisions");
  const enhancedDecisions = dedupe([..._extractDecisionsT2(decMsgs), ...base.decisions]).slice(0, 20);

  const bugMsgs = selectForCategory(scoredMessages, "bugs");
  const enhancedBugs = dedupe([..._extractBugsT2(bugMsgs), ...base.bugsFixed]).slice(0, 15);

  const ctxMsgs = selectForCategory(scoredMessages, "context");
  const ctx = ctxMsgs.map((m) => m.content.slice(0, 300)).join(" | ");
  const qMsgs = selectForCategory(scoredMessages, "questions");
  const q = qMsgs.map((m) => m.content.slice(0, 200)).join(" | ");

  const goalFull = [
    enhancedGoal,
    ctx ? `[Context: ${ctx}]` : "",
    q ? `[Open: ${q}]` : "",
  ].filter(Boolean).join("\n");

  let fDec = enhancedDecisions, fBugs = enhancedBugs, fPend = base.pending, fComp = base.completed;
  const estTokens = estimateTokens(goalFull) + fDec.reduce((s, d) => s + estimateTokens(d), 0)
    + fBugs.reduce((s, b) => s + estimateTokens(b), 0) + fComp.reduce((s, c) => s + estimateTokens(c), 0)
    + fPend.reduce((s, p) => s + estimateTokens(p), 0)
    + base.codeBlocks.reduce((s, cb) => s + estimateTokens(cb.code), 0)
    + base.tail.reduce((s, t) => s + estimateTokens(t.content), 0);

  if (estTokens > tokenBudget) {
    let excess = estTokens - tokenBudget;
    const trims = [{ a: fDec, f: 3 }, { a: fBugs, f: 3 }, { a: fPend, f: 1 }, { a: fComp, f: 2 }];
    for (const t of trims) {
      while (excess > 0 && t.a.length > t.f) {
        excess -= estimateTokens(t.a.pop()!);
      }
    }
  }

  const cov = {
    messagesScored: scoredMessages.length, messagesUsed: goals.length + fDec.length + fBugs.length,
    categoryCounts: { goals: goals.length, decisions: fDec.length, bugs: fBugs.length, context: ctxMsgs.length, questions: qMsgs.length }
  };
  console.log("[CM:tier2] scored coverage:", cov);

  return {
    goal: goalFull, decisions: fDec, bugsFixed: fBugs, completed: fComp, pending: fPend,
    codeBlocks: base.codeBlocks, techStack: base.techStack, tail: base.tail, currentState: base.currentState,
    compressionRatio: base.compressionRatio, originalCount: session.messages.length,
  };
}
