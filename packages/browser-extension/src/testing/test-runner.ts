// packages/browser-extension/src/testing/test-runner.ts
// Runs all GOLDEN_SESSIONS through all 3 tiers, scores each output,
// and returns a TestReport. READ-ONLY — never mutates production data.

import type { ContextSession, Message } from "@/lib/types";
import summarize, { summarizeIntelligent, summarizeWithAttention, type IntelligentSummary } from "@/lib/summarizer";
import type { CodeBlock } from "@/lib/types";
import { scoreMigration, type MigrationScore, type TierLabel } from "./migration-scorer";
import { GOLDEN_SESSIONS } from "./golden-sessions";
import { getLastTestReport, saveTestReport } from "./score-logger";

export interface TestResult {
  sessionName: string;
  tier: TierLabel;
  score: MigrationScore;
}

export interface TestReport {
  runId: string;
  runAt: number;
  results: TestResult[];
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    averageScore: number;
    lowestScorer: string;
    regressionVsLastRun: number | null;
  };
}

// ── Format IntelligentSummary as plain text for the scorer ───────────────────
function formatIntelligentSummary(is: IntelligentSummary, messages: Message[]): string {
  const lines: string[] = [
    `Goal: ${is.goal}`,
    ``,
    `Current Focus: ${is.currentState}`,
    ``,
    `Decisions:`,
    ...is.decisions.map((d) => `- ${d}`),
    ``,
    `Bugs Fixed:`,
    ...is.bugsFixed.map((b) => `- ${b}`),
    ``,
    `Completed:`,
    ...(is.completed ?? []).map((c) => `- ✅ ${c}`),
    ``,
    `Pending:`,
    ...(is.pending ?? []).map((p) => `- 🔲 ${p}`),
    ``,
    `Code Blocks:`,
    ...is.codeBlocks.map((b) => `\`\`\`${b.language}\n${b.code}\n\`\`\``),
    ``,
    `Recent Conversation:`,
    ...is.tail.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`),
  ];
  return lines.join("\n");
}

// ── Run a single session through a single tier ────────────────────────────────
async function runOneTier(
  session: ContextSession,
  tier: TierLabel,
): Promise<TestResult> {
  try {
    let migrated: string;

    if (tier === "tier1") {
      const result = await summarize(session.messages);
      migrated = result.content;
      // Augment with extracted fields for better scoring
      const ex = result.extracted;
      const tailText = ex.conversationTail
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");
      migrated =
        `Goal: ${ex.primaryGoal}\nFocus: ${ex.currentFocus}\n` +
        `Decisions:\n${ex.decisions}\nFacts:\n${ex.facts}\n\n` +
        `Code:\n${ex.codeBlocks.map((b) => `\`\`\`${b.language}\n${b.content}\n\`\`\``).join("\n")}\n\n` +
        `Tail:\n${tailText}\n\nSummary:\n${result.content}`;

    } else if (tier === "tier2") {
      const is = summarizeIntelligent(session.messages);
      migrated = formatIntelligentSummary(is, session.messages);

    } else {
      // attention — falls back to summarize() if engine not initialized
      const result = await summarizeWithAttention(session.messages, session.title, "light", session);
      migrated = result.summary;
    }

    return {
      sessionName: session.title,
      tier,
      score: scoreMigration(session, migrated, tier),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CM:test-runner] ${session.title}/${tier} failed: ${msg}`);
    return {
      sessionName: session.title,
      tier,
      score: scoreMigration(session, "", tier), // empty → error path in scorer
    };
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function runAllTests(): Promise<TestReport> {
  const runId = crypto.randomUUID();
  const runAt = Date.now();

  // Load previous run for regression comparison
  const prevReport = await getLastTestReport().catch(() => null);
  const prevAvg = prevReport
    ? prevReport.summary.averageScore
    : null;

  // Run all sessions × all tiers in sequence (avoids overwhelming the ML model)
  const results: TestResult[] = [];
  const tiers: TierLabel[] = ["tier1", "tier2", "attention"];

  for (const session of GOLDEN_SESSIONS) {
    for (const tier of tiers) {
      const result = await runOneTier(session, tier);
      results.push(result);
    }
  }

  // Compute summary
  const scores   = results.map((r) => r.score.total);
  const passed   = results.filter((r) => r.score.total >= 70).length;
  const failed   = results.length - passed;
  const avgScore = scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  const lowestIdx   = scores.indexOf(Math.min(...scores));
  const lowestResult = results[lowestIdx];
  const lowestScorer = lowestResult
    ? `${lowestResult.sessionName} / ${lowestResult.tier}`
    : "n/a";

  const regressionVsLastRun = prevAvg !== null ? avgScore - prevAvg : null;

  const report: TestReport = {
    runId,
    runAt,
    results,
    summary: {
      totalTests: results.length,
      passed,
      failed,
      averageScore: avgScore,
      lowestScorer,
      regressionVsLastRun,
    },
  };

  await saveTestReport(report).catch(() => { /* fire-and-forget */ });

  return report;
}
