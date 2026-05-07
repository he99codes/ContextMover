// packages/browser-extension/src/testing/migration-scorer.ts
// Standalone scoring engine — READ-ONLY relative to production code.
// Zero side effects. Accepts a ContextSession + migrated string, returns MigrationScore.

import type { ContextSession } from "@/lib/types";

export type TierLabel = "tier1" | "tier2" | "attention";
export type Grade = "Excellent" | "Good" | "Degraded" | "Fail";

export interface DimensionScore {
  score: number;     // 0–100
  weight: number;    // fixed weight for this dimension
  passed: boolean;   // score >= 50
  detail: string;    // human-readable explanation
}

export interface MigrationScore {
  total: number;
  grade: Grade;
  dimensions: {
    roleFidelity: DimensionScore;
    codeIntegrity: DimensionScore;
    semanticRetention: DimensionScore;
    taskState: DimensionScore;
    compressionLoss: DimensionScore;
  };
  lostItems: string[];
  timestamp: number;
  tier: TierLabel;
}

// ── Weights (must sum to 1.0) ─────────────────────────────────────────────────
const W = {
  roleFidelity:       0.20,
  codeIntegrity:      0.25,
  semanticRetention:  0.25,
  taskState:          0.15,
  compressionLoss:    0.15,
} as const;

// ── djb2 hash — no crypto dependency ─────────────────────────────────────────
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

// ── Extract ```...``` fenced code blocks from any text ───────────────────────
function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[0].trim());
  return blocks;
}

// ── Fuzzy keyword match ───────────────────────────────────────────────────────
// Split item into words > 4 chars, require ≥ 60% to appear in target.
function fuzzyMatch(item: string, target: string): boolean {
  const keywords = item.split(/\W+/).filter((w) => w.length > 4);
  if (keywords.length === 0) return true;
  const lower = target.toLowerCase();
  const hits = keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
  return hits / keywords.length >= 0.6;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dimension scorers
// ─────────────────────────────────────────────────────────────────────────────

function scoreRoleFidelity(session: ContextSession, migrated: string): DimensionScore {
  const roleLines = migrated
    .split("\n")
    .filter((l) => l.startsWith("User:") || l.startsWith("Assistant:"));

  if (roleLines.length === 0) {
    return {
      score: 50, weight: W.roleFidelity, passed: true,
      detail: "No role markers — neutral (tier 2/attention summaries omit turn structure)",
    };
  }

  const origRoles  = session.messages.map((m) => (m.role === "user" ? "User:" : "Assistant:"));
  const migrRoles  = roleLines.map((l) => (l.startsWith("User:") ? "User:" : "Assistant:"));
  const cmpLen     = Math.min(origRoles.length, migrRoles.length);
  let correct      = 0;
  for (let i = 0; i < cmpLen; i++) if (origRoles[i] === migrRoles[i]) correct++;

  const score = Math.round((correct / Math.max(origRoles.length, 1)) * 100);
  return {
    score, weight: W.roleFidelity, passed: score >= 50,
    detail: `${correct}/${origRoles.length} roles matched`,
  };
}

function scoreCodeIntegrity(
  session: ContextSession,
  migrated: string,
  lostItems: string[],
): DimensionScore {
  const origText   = session.messages.map((m) => m.content).join("\n");
  const origBlocks = extractCodeBlocks(origText);

  if (origBlocks.length === 0) {
    return {
      score: 100, weight: W.codeIntegrity, passed: true,
      detail: "No code blocks in original — nothing to lose",
    };
  }

  const migrHashes = new Set(extractCodeBlocks(migrated).map(djb2));
  let matching     = 0;
  for (const block of origBlocks) {
    if (migrHashes.has(djb2(block))) {
      matching++;
    } else {
      lostItems.push(`[code] ${block.slice(0, 40)}…`);
    }
  }

  const score = Math.round((matching / origBlocks.length) * 100);
  return {
    score, weight: W.codeIntegrity, passed: score >= 50,
    detail: `${matching}/${origBlocks.length} code block(s) survived (hash match)`,
  };
}

function scoreSemanticRetention(
  session: ContextSession,
  migrated: string,
  lostItems: string[],
): DimensionScore {
  const allContent = session.messages.map((m) => m.content).join("\n");

  const primaryGoal = (session.messages.find((m) => m.role === "user")?.content ?? "")
    .slice(0, 600);

  const FACT_RE = /must|cannot|requires|version|api key|endpoint|port/im;
  const DEC_RE  =
    /instead of|chose|decided|trade.off|going with|opted for|let.s use|sticking with|switching to/im;

  const facts = allContent
    .split(/[.!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && FACT_RE.test(s))
    .slice(0, 8);

  const decisions = allContent
    .split(/[.!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && DEC_RE.test(s))
    .slice(0, 8);

  const items = [primaryGoal, ...facts, ...decisions].filter(Boolean);
  if (items.length === 0) {
    return {
      score: 100, weight: W.semanticRetention, passed: true,
      detail: "No semantic items to retain",
    };
  }

  let found = 0;
  for (const item of items) {
    if (fuzzyMatch(item, migrated)) {
      found++;
    } else {
      lostItems.push(`[semantic] ${item.slice(0, 60)}…`);
    }
  }

  const score = Math.round((found / items.length) * 100);
  return {
    score, weight: W.semanticRetention, passed: score >= 50,
    detail: `${found}/${items.length} semantic items retained (goal + facts + decisions)`,
  };
}

function scoreTaskState(
  session: ContextSession,
  migrated: string,
  lostItems: string[],
): DimensionScore {
  const COMP_RE = /here.s|done|created|fixed|implemented|finished/im;
  const PEND_RE = /todo|next step|remaining|still need|will need/im;

  const completed = session.messages
    .filter((m) => m.role === "assistant" && COMP_RE.test(m.content))
    .map((m) => m.content.split("\n")[0].trim())
    .filter((s) => s.length > 10)
    .slice(0, 12);

  const pending = session.messages
    .filter((m) => PEND_RE.test(m.content))
    .map((m) => m.content.split(/[.!?\n]/)[0].trim())
    .filter((s) => s.length > 10)
    .slice(0, 10);

  const items = [...completed, ...pending];
  if (items.length === 0) {
    return {
      score: 100, weight: W.taskState, passed: true,
      detail: "No task state items in original",
    };
  }

  let found = 0;
  for (const item of items) {
    if (fuzzyMatch(item, migrated)) {
      found++;
    } else {
      lostItems.push(`[task] ${item.slice(0, 60)}…`);
    }
  }

  const score = Math.round((found / items.length) * 100);
  return {
    score, weight: W.taskState, passed: score >= 50,
    detail: `${found}/${items.length} task state items retained`,
  };
}

function scoreCompressionLoss(session: ContextSession, migrated: string): DimensionScore {
  const origChars = session.messages.reduce((s, m) => s + m.content.length, 0);
  const ratio     = origChars > 0 ? migrated.length / origChars : 1;

  const score =
    ratio >= 0.4 ? 100 :
    ratio >= 0.2 ? 75  :
    ratio >= 0.1 ? 50  : 25;

  return {
    score, weight: W.compressionLoss, passed: score >= 50,
    detail: `ratio=${ratio.toFixed(3)} (${migrated.length} migrated / ${origChars} original chars)`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function scoreMigration(
  original: ContextSession,
  migrated: string,
  tier: TierLabel = "tier1",
): MigrationScore {
  const lostItems: string[] = [];

  try {
    if (!migrated || migrated.trim().length === 0) {
      throw new Error("Migrated output is empty");
    }

    const roleFidelity      = scoreRoleFidelity(original, migrated);
    const codeIntegrity     = scoreCodeIntegrity(original, migrated, lostItems);
    const semanticRetention = scoreSemanticRetention(original, migrated, lostItems);
    const taskState         = scoreTaskState(original, migrated, lostItems);
    const compressionLoss   = scoreCompressionLoss(original, migrated);

    const total = Math.round(
      roleFidelity.score      * W.roleFidelity      +
      codeIntegrity.score     * W.codeIntegrity      +
      semanticRetention.score * W.semanticRetention  +
      taskState.score         * W.taskState          +
      compressionLoss.score   * W.compressionLoss,
    );

    const grade: Grade =
      total >= 90 ? "Excellent" :
      total >= 70 ? "Good"      :
      total >= 50 ? "Degraded"  : "Fail";

    return {
      total, grade,
      dimensions: { roleFidelity, codeIntegrity, semanticRetention, taskState, compressionLoss },
      lostItems,
      timestamp: Date.now(),
      tier,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const zero = (w: number): DimensionScore => ({ score: 0, weight: w, passed: false, detail: "Error" });
    return {
      total: 0, grade: "Fail",
      dimensions: {
        roleFidelity:      zero(W.roleFidelity),
        codeIntegrity:     zero(W.codeIntegrity),
        semanticRetention: zero(W.semanticRetention),
        taskState:         zero(W.taskState),
        compressionLoss:   zero(W.compressionLoss),
      },
      lostItems: [`[error] ${msg}`],
      timestamp: Date.now(),
      tier,
    };
  }
}
