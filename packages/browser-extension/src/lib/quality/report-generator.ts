// ─────────────────────────────────────────────────────────────────────────────
// Quality Report Generator
//
// Reads MigrationQualityRecord rows from IndexedDB and emits a plain-text
// report for engine evaluation.  The output is designed to be:
//   1) human-readable in the console / a text editor
//   2) easy to diff between releases
//   3) shareable as a single .txt file (no binary, no markdown rendering)
// ─────────────────────────────────────────────────────────────────────────────

import { dexieDb, type MigrationQualityRecord } from "../db";
import { getGrade } from "./migration-scorer";

// Friendly platform / tier labels for the report.
const TIER_LABEL: Record<1 | 2 | 3, string> = {
  1: "Full Context",
  2: "Smart Summary",
  3: "Attention Engine",
};

const PLATFORM_LABEL: Record<string, string> = {
  claude:     "Claude",
  chatgpt:    "ChatGPT",
  gemini:     "Gemini",
  grok:       "Grok",
  deepseek:   "DeepSeek",
  perplexity: "Perplexity",
};

const SEP = "═".repeat(50);
const SUB = "─".repeat(50);

interface DimAvg {
  messageSurvival: number;
  codeIntegrity: number;
  roleAccuracy: number;
  contextFreshness: number;
  keySignalRetention: number;
  compressionEfficiency: number;
}

const DIM_LABELS: Array<[keyof DimAvg, string, number]> = [
  ["messageSurvival",       "Message Survival",       25],
  ["codeIntegrity",         "Code Integrity",         20],
  ["roleAccuracy",          "Role Accuracy",          15],
  ["contextFreshness",      "Context Freshness",      15],
  ["keySignalRetention",    "Key Signal Retention",   15],
  ["compressionEfficiency", "Compression Efficiency", 10],
];

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmtAvg(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function fmtPlatform(p: string): string {
  return PLATFORM_LABEL[p] ?? (p.charAt(0).toUpperCase() + p.slice(1));
}

function fmtTier(t: 1 | 2 | 3): string {
  return TIER_LABEL[t];
}

/**
 * Generate the engine-evaluation report from stored MigrationQualityRecord rows.
 * If sessionId is provided, scope the report to that session; otherwise include
 * every recorded migration in the database.
 *
 * NEVER throws — on any internal failure returns a short error report so the
 * caller can still deliver a downloadable file with diagnostic info.
 */
export async function generateQualityReport(sessionId?: string): Promise<string> {
  try {
    const rows: MigrationQualityRecord[] = sessionId
      ? await dexieDb.migrationQuality.where("sessionId").equals(sessionId).toArray()
      : await dexieDb.migrationQuality.toArray();

    if (rows.length === 0) {
      return [
        SEP,
        "CONTEXTMOVER MIGRATION QUALITY REPORT",
        `Generated: ${new Date().toISOString()}`,
        SEP,
        "",
        "No migrations have been recorded yet.",
        "Run a migration from the sidebar to populate this report.",
        "",
        SEP,
      ].join("\n");
    }

    // Sort newest first for the per-migration tail of the report.
    rows.sort((a, b) => b.createdAt - a.createdAt);

    // ── Aggregates ────────────────────────────────────────────────────────────
    const total = rows.length;
    const scores = rows.map((r) => r.score);
    const avgScore = avg(scores);
    const best = rows.reduce((a, b) => (a.score >= b.score ? a : b));
    const worst = rows.reduce((a, b) => (a.score <= b.score ? a : b));

    // Score distribution
    const dist = { Excellent: 0, Good: 0, Acceptable: 0, Poor: 0, Failed: 0 };
    for (const s of scores) dist[getGrade(s)]++;

    // By tier
    const byTier = new Map<1 | 2 | 3, number[]>();
    for (const r of rows) {
      const arr = byTier.get(r.tier) ?? [];
      arr.push(r.score);
      byTier.set(r.tier, arr);
    }

    // By platform
    const byPlatform = new Map<string, number[]>();
    for (const r of rows) {
      const arr = byPlatform.get(r.platform) ?? [];
      arr.push(r.score);
      byPlatform.set(r.platform, arr);
    }

    // Dimension averages
    const dimAvgs: DimAvg = {
      messageSurvival:       avg(rows.map((r) => r.breakdown.messageSurvival)),
      codeIntegrity:         avg(rows.map((r) => r.breakdown.codeIntegrity)),
      roleAccuracy:          avg(rows.map((r) => r.breakdown.roleAccuracy)),
      contextFreshness:      avg(rows.map((r) => r.breakdown.contextFreshness)),
      keySignalRetention:    avg(rows.map((r) => r.breakdown.keySignalRetention)),
      compressionEfficiency: avg(rows.map((r) => r.breakdown.compressionEfficiency)),
    };

    // Identify weakest dimension by % of max.
    const weakestEntry = DIM_LABELS.reduce<[keyof DimAvg, string, number, number]>(
      (acc, [key, label, max]) => {
        const pct = dimAvgs[key] / max;
        return pct < acc[3] ? [key, label, max, pct] : acc;
      },
      [DIM_LABELS[0][0], DIM_LABELS[0][1], DIM_LABELS[0][2], 1]
    );

    // ── Build report ──────────────────────────────────────────────────────────
    const lines: string[] = [];

    lines.push(SEP);
    lines.push("CONTEXTMOVER MIGRATION QUALITY REPORT");
    lines.push(`Generated: ${new Date().toISOString()}`);
    if (sessionId) lines.push(`Scope: session ${sessionId}`);
    lines.push(SEP);
    lines.push("");

    // SUMMARY
    lines.push("SUMMARY");
    lines.push(SUB);
    lines.push(`Total migrations analyzed: ${total}`);
    lines.push(`Average score: ${fmtAvg(avgScore, 0)}/100`);
    lines.push(
      `Best score:    ${best.score}/100  (${fmtPlatform(best.platform)} · ${fmtTier(best.tier)})`
    );
    lines.push(
      `Worst score:   ${worst.score}/100  (${fmtPlatform(worst.platform)} · ${fmtTier(worst.tier)})`
    );
    lines.push("");

    // DISTRIBUTION
    lines.push("SCORE DISTRIBUTION");
    lines.push(SUB);
    lines.push(`Excellent (90-100): ${dist.Excellent} migration${dist.Excellent === 1 ? "" : "s"}`);
    lines.push(`Good      (75-89):  ${dist.Good} migration${dist.Good === 1 ? "" : "s"}`);
    lines.push(`Acceptable(60-74):  ${dist.Acceptable} migration${dist.Acceptable === 1 ? "" : "s"}`);
    lines.push(`Poor      (40-59):  ${dist.Poor} migration${dist.Poor === 1 ? "" : "s"}`);
    lines.push(`Failed    (< 40):   ${dist.Failed} migration${dist.Failed === 1 ? "" : "s"}`);
    lines.push("");

    // BY MIGRATION MODE
    lines.push("BY MIGRATION MODE");
    lines.push(SUB);
    for (const tier of [1, 2, 3] as const) {
      const arr = byTier.get(tier);
      if (arr && arr.length > 0) {
        lines.push(`${fmtTier(tier).padEnd(18)} avg ${fmtAvg(avg(arr), 0)}/100  (${arr.length} run${arr.length === 1 ? "" : "s"})`);
      }
    }
    lines.push("");

    // BY PLATFORM
    lines.push("BY TARGET PLATFORM");
    lines.push(SUB);
    const platformsSorted = Array.from(byPlatform.entries()).sort(
      ([, a], [, b]) => avg(b) - avg(a)
    );
    for (const [plat, arr] of platformsSorted) {
      lines.push(
        `${fmtPlatform(plat).padEnd(12)} avg ${fmtAvg(avg(arr), 0)}/100  (${arr.length} run${arr.length === 1 ? "" : "s"})`
      );
    }
    lines.push("");

    // DIMENSION BREAKDOWN
    lines.push("DIMENSION BREAKDOWN (averages)");
    lines.push(SUB);
    for (const [key, label, max] of DIM_LABELS) {
      const tag = key === weakestEntry[0] ? "  ← weakest" : "";
      lines.push(
        `${label.padEnd(22)} ${fmtAvg(dimAvgs[key])}/${max}${tag}`
      );
    }
    lines.push("");
    lines.push(`WEAKEST DIMENSION: ${weakestEntry[1]}`);
    lines.push(...weakestRecommendation(weakestEntry[0]));
    lines.push("");

    // INDIVIDUAL MIGRATIONS
    lines.push("INDIVIDUAL MIGRATIONS");
    lines.push(SUB);
    for (const r of rows) {
      const ts = new Date(r.createdAt).toISOString().replace("T", " ").slice(0, 16);
      lines.push(
        `[${r.id.slice(0, 8)}] ${fmtPlatform(r.platform)} · Tier ${r.tier} · ${r.score}/100 · ${r.grade} · ${ts}`
      );
      lines.push(
        `  Messages: ${r.breakdown.messageSurvival.toFixed(1)}/25 · ` +
          `Code: ${r.breakdown.codeIntegrity.toFixed(1)}/20 · ` +
          `Roles: ${r.breakdown.roleAccuracy.toFixed(1)}/15 · ` +
          `Fresh: ${r.breakdown.contextFreshness.toFixed(1)}/15 · ` +
          `Signals: ${r.breakdown.keySignalRetention.toFixed(1)}/15 · ` +
          `Compress: ${r.breakdown.compressionEfficiency.toFixed(1)}/10`
      );
      const warnings = perRowWarnings(r);
      for (const w of warnings) lines.push(`  WARNING: ${w}`);
      lines.push("");
    }

    // RECOMMENDATIONS
    const recs = aggregateRecommendations(rows, dimAvgs, byPlatform);
    if (recs.length > 0) {
      lines.push("RECOMMENDATIONS");
      lines.push(SUB);
      recs.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.title}`);
        for (const sub of r.actions) lines.push(`   → ${sub}`);
      });
      lines.push("");
    }

    lines.push(SEP);

    return lines.join("\n");
  } catch (err) {
    return [
      SEP,
      "CONTEXTMOVER MIGRATION QUALITY REPORT",
      `Generated: ${new Date().toISOString()}`,
      SEP,
      "",
      "Error generating report — falling back to diagnostic output.",
      `Reason: ${err instanceof Error ? err.message : String(err)}`,
      "",
      SEP,
    ].join("\n");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Recommendation helpers
// ─────────────────────────────────────────────────────────────────────────────

function weakestRecommendation(dim: keyof DimAvg): string[] {
  switch (dim) {
    case "messageSurvival":
      return [
        "→ Messages being dropped during compression",
        "→ Inspect tier 1/2 hard-limit logic in summarizer.ts",
      ];
    case "codeIntegrity":
      return [
        "→ Code blocks missing or truncated in output",
        "→ Verify INJECT_HARD_CAP and PLATFORM_MAX_CHARS are not clipping mid-block",
      ];
    case "roleAccuracy":
      return [
        "→ Capture validator producing unclassified messages",
        "→ Audit content/<platform>.ts message extraction selectors",
      ];
    case "contextFreshness":
      return [
        "→ Last 6 messages not surviving into the prompt",
        "→ Confirm conversationTail is included by buildMigrationPrompt for this tier",
      ];
    case "keySignalRetention":
      return [
        "→ Decisions / goals being dropped during compression",
        "→ Expand decision patterns in summarizer.ts (add: 'going with', 'opted for', \"we'll use\")",
      ];
    case "compressionEfficiency":
      return [
        "→ Compression ratio out of healthy range",
        "→ Consider tier-2 over-compression: tune token budget in summarizeIntelligent()",
      ];
  }
}

interface Recommendation {
  title: string;
  actions: string[];
}

function aggregateRecommendations(
  rows: MigrationQualityRecord[],
  dimAvgs: DimAvg,
  byPlatform: Map<string, number[]>
): Recommendation[] {
  const recs: Recommendation[] = [];

  // 1. Weak signal retention
  if (dimAvgs.keySignalRetention < 12) {
    recs.push({
      title: `Key Signal Retention averaging ${dimAvgs.keySignalRetention.toFixed(1)}/15`,
      actions: [
        "Expand decision patterns in summarizer.ts",
        "Add patterns: \"going with\", \"opted for\", \"we'll use\"",
      ],
    });
  }

  // 2. Underperforming platforms
  for (const [plat, arr] of byPlatform.entries()) {
    if (arr.length >= 2 && avg(arr) < 75) {
      recs.push({
        title: `${fmtPlatform(plat)} migrations averaging ${fmtAvg(avg(arr), 0)} (below 75)`,
        actions: [
          `Review translator.ts ${fmtPlatform(plat)} format`,
          "Check [SECTION] delimiter handling for this target",
        ],
      });
    }
  }

  // 3. Code integrity issues across multiple migrations
  const codeWeak = rows.filter((r) => r.breakdown.codeIntegrity < 18).length;
  if (codeWeak >= 3) {
    recs.push({
      title: `Code Integrity < 18/20 in ${codeWeak} migrations`,
      actions: [
        "Code blocks may be truncated by the platform char cap",
        "Inspect PLATFORM_MAX_CHARS rebuild loop in service-worker.ts",
      ],
    });
  }

  // 4. Compression over-aggressive
  if (dimAvgs.compressionEfficiency < 7) {
    recs.push({
      title: `Compression efficiency averaging ${dimAvgs.compressionEfficiency.toFixed(1)}/10`,
      actions: [
        "Tier 2 may be over-compressing for the target platform",
        "Tune token budget in summarizeIntelligent() or prefer Tier 1 for code-heavy sessions",
      ],
    });
  }

  return recs;
}

function perRowWarnings(r: MigrationQualityRecord): string[] {
  const w: string[] = [];
  if (r.breakdown.messageSurvival < 15) w.push("Low message survival — check compression");
  if (r.breakdown.codeIntegrity < 12)   w.push("Code blocks lost or truncated");
  if (r.breakdown.contextFreshness < 10) w.push("Recent messages not preserved");
  if (r.breakdown.keySignalRetention < 8) w.push("Key decisions / signals dropped");
  return w;
}
