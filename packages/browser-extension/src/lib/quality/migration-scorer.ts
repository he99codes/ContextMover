/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Migration Quality Scorer
//
// Computes a 0-100 score across 6 dimensions for every migration.  Used to
// surface migration health to the user (sidebar score card) and to drive the
// engine evaluation report (downloadable .txt).
//
// All scoring is fail-safe: scoreMigration() never throws — on any internal
// failure it returns a zeroed score with grade='Failed' so the caller can
// still proceed with injection.
// ─────────────────────────────────────────────────────────────────────────────

import type { ContextSession } from "../types";

export interface QualityScore {
  total: number;
  grade: "Excellent" | "Good" | "Acceptable" | "Poor" | "Failed";
  breakdown: {
    messageSurvival: number;       // /25
    codeIntegrity: number;         // /20
    roleAccuracy: number;          // /15
    contextFreshness: number;      // /15
    keySignalRetention: number;    // /15
    compressionEfficiency: number; // /10
  };
  meta: {
    originalMessages: number;
    preservedMessages: number;
    preservedUser: number;
    preservedAsst: number;
    originalCodeBlocks: number;
    preservedCodeBlocks: number;
    originalSignals: number;
    preservedSignals: number;
    compressionRatio: number;       // outputLen / originalLen
    tier: 1 | 2 | 3;
    platform: string;
    sessionId: string;
    timestamp: number;
    migrationId: string;
  };
}

export interface ScorerInput {
  session: ContextSession;
  outputPrompt: string;
  tier: 1 | 2 | 3;
  platform: string;
  topK?: number;                    // for tier 3 retrieval depth
  captureStats?: {
    userCount: number;
    assistantCount: number;
    total: number;
  };
}

// Patterns that signal high-value information (decisions / bugs / goals).
// Scanned in BOTH the original session (capped at first 50 messages) and the
// final output prompt — retention ratio drives the keySignalRetention score.
const SIGNAL_PATTERNS: RegExp[] = [
  // Decisions
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
  /\bthe (fix|bug|issue|problem|root cause)\b/i,
  /\broot cause\b/i,
  // Bug / fix signals
  /\bthe fix\b/i,
  /\bfixed by\b/i,
  /\bbug was\b/i,
  /\berror occurs\b/i,
  /\bissue was\b/i,
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
  // Architecture / facts
  /\bthis works because\b/i,
  /\bthe reason\b/i,
  /\bbecause of\b/i,
  /\bturns out\b/i,
  /\brealized that\b/i,
  /\barchitecture\b/i,
  // Legacy patterns (kept for compatibility)
  /\bwe chose\b/i,
  /\bwe('?re| are) going with\b/i,
  /\bdecision\b/i,
  /\bcompleted\b/i,
  /\bpending\b/i,
  /\btodo\b/i,
];

// ── Platform-aware message counting ─────────────────────────────────────────
// Each platform uses a different format for role markers in the output prompt.
// We match the ACTUAL format the translator emits per platform.

interface PlatformPatterns {
  user: RegExp[];
  assistant: RegExp[];
}

const PLATFORM_MESSAGE_PATTERNS: Record<string, PlatformPatterns> = {
  claude: {
    user: [
      /<message role="user">/gi,
      /\[HUMAN\]/gi,
    ],
    assistant: [
      /<message role="assistant">/gi,
      /\[ASSISTANT\]/gi,
    ],
  },
  chatgpt: {
    user: [
      /\*\*You:\*\*/gi,
      /\*\*User:\*\*/gi,
      /^\s*User:/gim,
    ],
    assistant: [
      /\*\*AI:\*\*/gi,
      /\*\*Assistant:\*\*/gi,
      /^\s*Assistant:/gim,
    ],
  },
  gemini: {
    user: [
      /\[USER\]/gi,
      /^\s*USER:/gim,
      /^\s*User:/gim,
    ],
    assistant: [
      /\[ASSISTANT\]/gi,
      /\[MODEL\]/gi,
      /^\s*ASSISTANT:/gim,
      /^\s*Assistant:/gim,
    ],
  },
  grok: {
    user: [
      /\*\*You:\*\*/gi,
      /\*\*User:\*\*/gi,
    ],
    assistant: [
      /\*\*Previous AI:\*\*/gi,
      /\*\*AI:\*\*/gi,
      /\*\*Assistant:\*\*/gi,
      /\*\*Grok:\*\*/gi,
    ],
  },
  deepseek: {
    user: [
      /^\s*User:/gim,
      /\*\*User:\*\*/gi,
    ],
    assistant: [
      /^\s*Assistant:/gim,
      /\*\*Assistant:\*\*/gi,
    ],
  },
  perplexity: {
    user: [
      /^\s*User:/gim,
      /\*\*User:\*\*/gi,
    ],
    assistant: [
      /^\s*AI:/gim,
      /^\s*Perplexity:/gim,
      /\*\*AI:\*\*/gi,
    ],
  },
};

// Universal fallback patterns when platform is unknown
const UNIVERSAL_MESSAGE_PATTERNS: PlatformPatterns = {
  user: [
    /<message role="user">/gi,
    /\*\*(You|User):\*\*/gi,
    /^\s*(?:You|User):/gim,
    /\[USER\]/gi,
    /role="user"/gi,
  ],
  assistant: [
    /<message role="assistant">/gi,
    /\*\*(AI|Assistant|Grok|Claude|Gemini|Previous AI):\*\*/gi,
    /^\s*(?:AI|Assistant):/gim,
    /\[ASSISTANT\]/gi,
    /role="assistant"/gi,
  ],
};

function countMessagesInOutput(
  prompt: string,
  platform: string
): { user: number; assistant: number; total: number } {
  const patterns = PLATFORM_MESSAGE_PATTERNS[platform] ?? UNIVERSAL_MESSAGE_PATTERNS;

  const countMax = (regexes: RegExp[]): number => {
    let max = 0;
    for (const re of regexes) {
      const matches = prompt.match(re);
      const count = matches?.length ?? 0;
      if (count > max) max = count;
    }
    return max;
  };

  const userCount = countMax(patterns.user);
  const assistantCount = countMax(patterns.assistant);

  return {
    user: userCount,
    assistant: assistantCount,
    total: userCount + assistantCount,
  };
}

// ── Code block counting (platform-aware) ────────────────────────────────────
function countCodeBlocks(text: string): number {
  if (!text) return 0;
  // Markdown triple-backtick blocks
  const tripleBacktick = (text.match(/```/g) ?? []).length;
  const mdBlockCount = Math.floor(tripleBacktick / 2);
  // Claude XML <code> / <file> / <snippet> tags
  const codeTags = (text.match(/<code[^>]*>/gi) ?? []).length;
  const fileTags = (text.match(/<file\s/gi) ?? []).length;
  const snippetTags = (text.match(/<snippet\s/gi) ?? []).length;
  return Math.max(mdBlockCount, codeTags + fileTags + snippetTags);
}

function hasTruncatedCodeBlock(text: string): boolean {
  // Odd number of triple-backtick fences = an unclosed/truncated block.
  if (!text) return false;
  const fences = text.match(/```/g);
  return fences ? fences.length % 2 !== 0 : false;
}

function countSignals(text: string): number {
  if (!text) return 0;
  let total = 0;
  for (const pat of SIGNAL_PATTERNS) {
    // Use a global flag manually — clone with /g to count all hits without
    // re-mutating the original (top-level RegExps are not /g).
    const re = new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : pat.flags + "g");
    const m = text.match(re);
    if (m) total += m.length;
  }
  return total;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function safeRound(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n * 10) / 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function getGrade(score: number): QualityScore["grade"] {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Good";
  if (score >= 60) return "Acceptable";
  if (score >= 40) return "Poor";
  return "Failed";
}

/**
 * Score a single migration across 6 dimensions, returning total /100.
 * NEVER throws — failure returns a zeroed score with grade='Failed'.
 */
export function scoreMigration(input: ScorerInput): QualityScore {
  const migrationId = generateMigrationId();
  const timestamp = Date.now();

  try {
    const { session, outputPrompt, tier, platform, topK, captureStats } = input;

    const originalMessages = session.messages.length;
    const originalText = session.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    const originalLen = Math.max(1, originalText.length);
    const outputLen = outputPrompt.length;

    // ── 1. Message Survival (/25) ────────────────────────────────────────────
    // Estimate how many messages survived by counting platform-specific role
    // markers in the output prompt. Cap at originalMessages.
    const { total: preservedMessages, user: preservedUser, assistant: preservedAsst } =
      countMessagesInOutput(outputPrompt, platform);
    const cappedPreserved = Math.min(originalMessages, preservedMessages);
    const survivalRatio = originalMessages > 0 ? cappedPreserved / originalMessages : 0;
    const messageSurvival = safeRound(clamp(survivalRatio * 25, 0, 25));

    // ── 2. Code Integrity (/20) ──────────────────────────────────────────────
    const originalCodeBlocks = countCodeBlocks(originalText);
    const preservedCodeBlocks = countCodeBlocks(outputPrompt);
    let codeIntegrity =
      originalCodeBlocks > 0
        ? clamp((preservedCodeBlocks / originalCodeBlocks) * 20, 0, 20)
        : 20; // No code in source → not penalised
    if (hasTruncatedCodeBlock(outputPrompt)) {
      codeIntegrity = clamp(codeIntegrity - 5, 0, 20);
    }
    codeIntegrity = safeRound(codeIntegrity);

    // ── 3. Role Accuracy (/15) ───────────────────────────────────────────────
    // If the capture validator gave us stats, use them. Otherwise infer from
    // the original session (every message has a role → assume 100%).
    let roleAccuracy: number;
    if (captureStats && captureStats.total > 0) {
      const correct = captureStats.userCount + captureStats.assistantCount;
      roleAccuracy = safeRound(clamp((correct / captureStats.total) * 15, 0, 15));
    } else {
      // Count messages whose role is one of the two valid values.
      const valid = session.messages.filter(
        (m) => m.role === "user" || m.role === "assistant"
      ).length;
      roleAccuracy =
        originalMessages > 0
          ? safeRound(clamp((valid / originalMessages) * 15, 0, 15))
          : 0;
    }

    // ── 4. Context Freshness (/15) ───────────────────────────────────────────
    // Are the last 6 messages of the session present (verbatim or substring)
    // in the output prompt? Use a 60-char head fingerprint per message — long
    // enough to be specific, short enough to survive normal compression.
    const tail = session.messages.slice(-6);
    let tailPresent = 0;
    for (const m of tail) {
      const fp = m.content.slice(0, 60).trim();
      if (fp.length === 0) {
        // Empty content — give it a pass (don't penalise the migration for
        // an upstream empty message).
        tailPresent++;
        continue;
      }
      if (outputPrompt.includes(fp)) tailPresent++;
    }
    let contextFreshness: number;
    if (tail.length === 0) contextFreshness = 0;
    else if (tailPresent >= 6) contextFreshness = 15;
    else if (tailPresent >= 4) contextFreshness = 10;
    else if (tailPresent >= 2) contextFreshness = 5;
    else contextFreshness = 0;

    // ── 5. Key Signal Retention (/15) ────────────────────────────────────────
    // Cap original scan at first 50 messages (per spec) to avoid skewing the
    // ratio on extremely long sessions where most signals live in the early
    // discovery phase.
    const scanWindow = session.messages
      .slice(0, 50)
      .map((m) => m.content)
      .join("\n");
    const originalSignals = countSignals(scanWindow);
    const preservedSignals = Math.min(originalSignals, countSignals(outputPrompt));
    const keySignalRetention =
      originalSignals > 0
        ? safeRound(clamp((preservedSignals / originalSignals) * 15, 0, 15))
        : 15; // No signals in source → not penalised

    // ── 6. Compression Efficiency (/10) ──────────────────────────────────────
    const compressionRatio = outputLen / originalLen;
    let compressionEfficiency = 0;
    if (tier === 1) {
      // Full context — no compression expected
      compressionEfficiency = 10;
    } else if (tier === 2) {
      // Smart Summary: score by message preservation ratio
      // 70-90% preserved → 10/10 (good compression, still useful)
      // 90-100% preserved → 8/10 (light compression)
      // 50-70% preserved → 6/10 (heavy compression)
      // < 50% preserved → 3/10 (over-compressed)
      const msgRatio = originalMessages > 0 ? preservedMessages / originalMessages : 0;
      const pct = msgRatio * 100;
      if (pct >= 70 && pct < 90) compressionEfficiency = 10;
      else if (pct >= 90) compressionEfficiency = 8;
      else if (pct >= 50) compressionEfficiency = 6;
      else compressionEfficiency = 3;
    } else {
      // Tier 3 — score by retrieval depth (topK).
      const k = topK ?? 0;
      if (k >= 15) compressionEfficiency = 10;
      else if (k >= 10) compressionEfficiency = 7;
      else compressionEfficiency = 4;
    }
    compressionEfficiency = safeRound(compressionEfficiency);

    // ── Total + grade ────────────────────────────────────────────────────────
    const total = Math.round(
      messageSurvival +
        codeIntegrity +
        roleAccuracy +
        contextFreshness +
        keySignalRetention +
        compressionEfficiency
    );
    const grade = getGrade(total);

    return {
      total,
      grade,
      breakdown: {
        messageSurvival,
        codeIntegrity,
        roleAccuracy,
        contextFreshness,
        keySignalRetention,
        compressionEfficiency,
      },
      meta: {
        originalMessages,
        preservedMessages: cappedPreserved,
        preservedUser,
        preservedAsst,
        originalCodeBlocks,
        preservedCodeBlocks,
        originalSignals,
        preservedSignals,
        compressionRatio: Math.round(compressionRatio * 1000) / 1000,
        tier,
        platform,
        sessionId: session.id,
        timestamp,
        migrationId,
      },
    };
  } catch (err) {
    // Scoring must never break a migration. Return a zeroed Failed score
    // and let the caller log the error.
    console.warn("[CM:quality] scoreMigration failed (non-fatal):", err);
    return {
      total: 0,
      grade: "Failed",
      breakdown: {
        messageSurvival: 0,
        codeIntegrity: 0,
        roleAccuracy: 0,
        contextFreshness: 0,
        keySignalRetention: 0,
        compressionEfficiency: 0,
      },
      meta: {
        originalMessages: input.session?.messages?.length ?? 0,
        preservedMessages: 0,
        preservedUser: 0,
        preservedAsst: 0,
        originalCodeBlocks: 0,
        preservedCodeBlocks: 0,
        originalSignals: 0,
        preservedSignals: 0,
        compressionRatio: 0,
        tier: input.tier,
        platform: input.platform,
        sessionId: input.session?.id ?? "unknown",
        timestamp,
        migrationId,
      },
    };
  }
}

/**
 * Format a single QualityScore as a human-readable plain-text block.
 * Used both for console logging and for the per-migration section of the
 * downloadable engine evaluation report.
 */
export function formatScoreReport(score: QualityScore): string {
  const grade = `${score.total}/100 · ${score.grade}`;
  const b = score.breakdown;
  const m = score.meta;
  const ratio = `${(m.compressionRatio * 100).toFixed(1)}%`;

  const lines = [
    `Migration ${m.migrationId.slice(0, 8)} · ${m.platform} · Tier ${m.tier}`,
    `  Score:        ${grade}`,
    `  Messages:     ${b.messageSurvival.toFixed(1)}/25  (${m.preservedMessages}/${m.originalMessages} preserved)`,
    `  Code:         ${b.codeIntegrity.toFixed(1)}/20  (${m.preservedCodeBlocks}/${m.originalCodeBlocks} blocks)`,
    `  Roles:        ${b.roleAccuracy.toFixed(1)}/15`,
    `  Freshness:    ${b.contextFreshness.toFixed(1)}/15  (last-6 tail)`,
    `  Signals:      ${b.keySignalRetention.toFixed(1)}/15  (${m.preservedSignals}/${m.originalSignals})`,
    `  Compression:  ${b.compressionEfficiency.toFixed(1)}/10  (output/source = ${ratio})`,
  ];
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateMigrationId(): string {
  // Service workers expose crypto.randomUUID() in MV3 / modern Chrome. Fall
  // back to a timestamped pseudo-random string if it's missing (unit tests).
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `mig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
