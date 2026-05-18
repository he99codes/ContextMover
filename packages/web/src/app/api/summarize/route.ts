/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/summarize/route.ts
//
// Server-side Tier 2 intelligent summarization.
// The extraction patterns (decisions, goals, bugs, code blocks) live here —
// they are not shipped in the extension bundle.
//
// Auth:  Supabase JWT Bearer token
// Limit: 60 req / hour per user
//
// Input:  { messages: Message[], task?: string, maxChars?: number }
// Output: IntelligentSummary

import { NextRequest, NextResponse } from "next/server";
import { getAuthUserFromRequest } from "@/lib/usage/helpers";
import { checkRateLimit } from "@/lib/rate-limiter";

export const runtime = "nodejs";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

interface CodeBlock {
  language: string;
  path?: string;
  code: string;
}

interface IntelligentSummary {
  goal: string;
  currentState: string;
  decisions: string[];
  bugsFixed: string[];
  completed: string[];
  pending: string[];
  codeBlocks: CodeBlock[];
  tail: Message[];
  originalCount: number;
  compressionRatio: number;
}

// ── Extraction patterns ───────────────────────────────────────────────────────
// [IP] These regex sets define what ContextMover extracts from conversations.
// They are NOT present in the extension bundle.

const DECISION_MARKERS = [
  /(?:^|[\n.!?]\s{0,3})(?:we(?:'re|'ll|(?:\s+are)|(?:\s+will))?\s+(?:decided|going|using|switched|migrated|moved)\b)/i,
  /(?:^|[\n.!?]\s{0,3})(?:the\s+(?:approach|solution|plan|fix|decision)\s+(?:is|was)\b)/i,
  /(?:^|[\n.!?]\s{0,3})(?:(?:opted|chose|going)\s+(?:for|with|to)\b)/i,
  /(?:^|[\n.!?]\s{0,3})(?:(?:this|that)\s+(?:means|requires|ensures)\b)/i,
  /(?:^|[\n.!?]\s{0,3})(?:instead\s+of\b)/i,
  /(?:^|[\n.!?]\s{0,3})(?:the\s+(?:reason|rationale)\b)/i,
  /(?:^|[\n.!?]\s{0,3})(?:architecture[:\s])/i,
];

const BUG_MARKERS = [
  /\b(?:Traceback|TypeError|ValueError|AttributeError|KeyError|IndexError|ImportError|ModuleNotFoundError|RuntimeError|NameError|AssertionError|ZeroDivisionError)\b/,
  /\bat\s+[\w.<>]+\s+\([^)]+:\d+:\d+\)/,
  /\bError:\s+\S/,
  /\bException\s+in\s+thread\b/,
  /\b(?:the\s+(?:issue|bug|problem|cause)\s+(?:was|is)\b)/i,
  /\b(?:fixed\s+by|caused\s+by|turned\s+out\s+(?:to\s+be|that))\b/i,
  /\b(?:race\s+condition|deadlock|memory\s+leak|off[- ]by[- ]one|null\s+pointer)\b/i,
  /\b(?:regression|infinite\s+loop|stack\s+overflow)\b/i,
  /\b(?:segfault|SIGSEGV|SIGABRT|core\s+dump)\b/i,
  /\bcannot\s+read\s+propert(?:y|ies)\s+of\s+(?:undefined|null)\b/i,
  /\bis\s+not\s+(?:a\s+function|defined)\b/i,
  /\bfailed\s+to\s+(?:compile|build|start|connect|resolve)\b/i,
  /\b(?:ECONNREFUSED|ENOENT|ETIMEDOUT|EPERM|EACCES)\b/,
  /\b(?:404|500|502|503)\s+(?:error|response|status)\b/i,
  /\bCSP\s+(?:violation|block|error)\b/i,
];

const GOAL_SIGNALS = [
  /\bthe\s+(?:goal|aim|objective|purpose)\s+(?:is|was)\b/i,
  /\bwe(?:'re|\s+are)\s+(?:building|implementing|creating|designing)\b/i,
  /\bwe\s+(?:want|need|have)\s+to\b/i,
  /\bthe\s+(?:main\s+)?(?:task|feature|requirement)\s+(?:is|was)\b/i,
  /\bthis\s+should\b/i,
];

const COMPLETED_SIGNALS = [
  /\b(?:done|completed?|finished|implemented|added|created|fixed|resolved|merged|shipped)\b/i,
  /\bworking\s+(?:now|correctly|as\s+expected)\b/i,
  /\bpasses?\s+(?:all\s+)?tests?\b/i,
];

const PENDING_SIGNALS = [
  /\b(?:TODO|FIXME|HACK|next\s+step|still\s+need|need\s+to|remaining|not\s+yet|will\s+need)\b/i,
  /\bshould\s+(?:still|also|then)\b/i,
  /\bafter\s+(?:this|that)\b/i,
];

const CODE_FENCE_RE = /```(\w*)\n?([\s\S]*?)```/g;
const FILE_PATH_IN_FENCE = /^(?:\/|\.\.?\/|(?:[a-zA-Z]:[\\/])?)[\w/\\.\-]+\.\w{1,8}$/m;

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractDecisions(msg: Message, maxPerMsg = 3): string[] {
  const results: string[] = [];
  const sents = msg.content
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12 && s.length < 200);

  for (const sent of sents) {
    if (DECISION_MARKERS.some((re) => re.test(sent))) {
      const clean = sent.replace(/^[-*•]\s*/, "").trim();
      if (clean.length > 10) results.push(clean);
      if (results.length >= maxPerMsg) break;
    }
  }
  return results;
}

function extractBugs(msg: Message, maxPerMsg = 3): string[] {
  const results: string[] = [];
  const sents = msg.content
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && s.length < 220);

  for (const sent of sents) {
    if (BUG_MARKERS.some((re) => re.test(sent))) {
      const clean = sent.replace(/^[-*•]\s*/, "").trim();
      if (clean.length > 6) results.push(clean);
      if (results.length >= maxPerMsg) break;
    }
  }
  return results;
}

function extractGoal(messages: Message[]): string {
  // Scan first third of the conversation for a goal signal.
  const scanCount = Math.ceil(messages.length / 3);
  for (const msg of messages.slice(0, scanCount)) {
    const sents = msg.content.split(/(?<=[.!?\n])\s+/).map((s) => s.trim());
    for (const sent of sents) {
      if (GOAL_SIGNALS.some((re) => re.test(sent)) && sent.length > 15 && sent.length < 200) {
        return sent.replace(/^[-*•]\s*/, "").trim();
      }
    }
  }
  // Fallback: first user message truncated.
  const first = messages.find((m) => m.role === "user");
  return first ? first.content.slice(0, 160).trim() : "";
}

function extractCompleted(messages: Message[]): string[] {
  const out: string[] = [];
  for (const msg of messages.slice(-Math.floor(messages.length / 2))) {
    const sents = msg.content.split(/(?<=[.!?\n])\s+/).map((s) => s.trim());
    for (const sent of sents) {
      if (COMPLETED_SIGNALS.some((re) => re.test(sent)) && sent.length > 10 && sent.length < 180) {
        out.push(sent.replace(/^[-*•✅✓]\s*/, "").trim());
        if (out.length >= 8) return out;
      }
    }
  }
  return out;
}

function extractPending(messages: Message[]): string[] {
  const out: string[] = [];
  for (const msg of messages.slice(-Math.ceil(messages.length * 0.4))) {
    const sents = msg.content.split(/(?<=[.!?\n])\s+/).map((s) => s.trim());
    for (const sent of sents) {
      if (PENDING_SIGNALS.some((re) => re.test(sent)) && sent.length > 10 && sent.length < 180) {
        out.push(sent.replace(/^[-*•⬜□]\s*/, "").trim());
        if (out.length >= 6) return out;
      }
    }
  }
  return out;
}

function extractCodeBlocks(messages: Message[]): CodeBlock[] {
  const seen = new Set<string>();
  const out: CodeBlock[] = [];

  for (const msg of messages.slice().reverse()) {
    let match: RegExpExecArray | null;
    CODE_FENCE_RE.lastIndex = 0;
    while ((match = CODE_FENCE_RE.exec(msg.content)) !== null) {
      const language = match[1]?.trim() || "plaintext";
      const code = match[2]?.trim() ?? "";
      if (code.length < 20) continue;
      const key = code.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);

      const pathMatch = code.match(FILE_PATH_IN_FENCE);
      out.push({ language, code, path: pathMatch?.[0]?.trim() });

      if (out.length >= 12) break;
    }
    if (out.length >= 12) break;
  }

  return out.reverse();
}

function selectTail(messages: Message[], tailN = 10): Message[] {
  const asst = messages.filter((m) => m.role === "assistant");
  const tailStart = Math.max(0, asst.length - tailN);
  const tailIds = new Set(asst.slice(tailStart).map((m) => messages.indexOf(m)));

  return messages.filter((_, i) => {
    const surroundIdx = messages.slice(Math.max(0, i - 1), Math.min(messages.length, i + 2));
    return surroundIdx.some((_, j) => tailIds.has(i + j - 1));
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await checkRateLimit(req, user.id, 60);
  if (!rl.ok) return rl.response;

  let body: { messages: Message[]; task?: string; maxChars?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { messages, task } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "messages must be a non-empty array" }, { status: 400 });
  }

  const goal = extractGoal(messages);

  const decisions: string[] = [];
  const bugsFixed: string[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      decisions.push(...extractDecisions(msg));
      bugsFixed.push(...extractBugs(msg));
    }
  }

  // Deduplicate, cap
  const uniqueDecisions = Array.from(new Set(decisions)).slice(0, 20);
  const uniqueBugs = Array.from(new Set(bugsFixed)).slice(0, 15);

  const codeBlocks = extractCodeBlocks(messages);
  const tail = selectTail(messages, 10);
  const completed = extractCompleted(messages);
  const pending = extractPending(messages);

  const currentState = (() => {
    const lastAsst = [...messages].reverse().find((m) => m.role === "assistant");
    return lastAsst ? lastAsst.content.slice(0, 300).trim() : "";
  })();

  // Compression ratio = how much was trimmed vs original
  const originalChars = messages.reduce((s, m) => s + m.content.length, 0);
  const summaryChars =
    goal.length +
    currentState.length +
    uniqueDecisions.join("").length +
    uniqueBugs.join("").length +
    completed.join("").length +
    pending.join("").length +
    codeBlocks.reduce((s, c) => s + c.code.length, 0) +
    tail.reduce((s, m) => s + m.content.length, 0);

  const compressionRatio = Math.max(
    0,
    Math.round((1 - summaryChars / Math.max(1, originalChars)) * 100)
  );

  const summary: IntelligentSummary = {
    goal: task ? `${goal} [focus: ${task}]` : goal,
    currentState,
    decisions: uniqueDecisions,
    bugsFixed: uniqueBugs,
    completed,
    pending,
    codeBlocks,
    tail,
    originalCount: messages.length,
    compressionRatio,
  };

  return NextResponse.json(summary);
}
