/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { scoreMigration, formatScoreReport } from "../migration-scorer";
import type { ContextSession } from "../../types";

const BT = "```";

const mockSession: ContextSession = {
  id: "calibration-test",
  title: "Calibration",
  platform: "claude",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [
    { role: "user", content: "How do I fix JWT auth?", timestamp: Date.now() },
    { role: "assistant", content: "The root cause is cookie scope mismatch. We decided to use httpOnly cookies.", timestamp: Date.now() },
    { role: "user", content: "Show me the code", timestamp: Date.now() },
    { role: "assistant", content: BT + "typescript\nconst fix = () => {\n  document.cookie = 'token; HttpOnly; Secure';\n}\n" + BT, timestamp: Date.now() },
  ],
};

interface ExpectedRange { min: number; max: number; }
interface TestCase {
  platform: string;
  tier: 1 | 2 | 3;
  prompt: string;
  expected: Record<string, ExpectedRange>;
}

function codeBlock(): string {
  return BT + "typescript" + "\nconst fix = () => {\n  document.cookie = 'token; HttpOnly; Secure';\n}\n" + BT;
}

function claudePrompt(): string {
  const lines = [
    "<context_migration>",
    "  <conversation_tail>",
    '    <message role="user">How do I fix JWT auth?</message>',
    '    <message role="assistant">The root cause is cookie scope mismatch. We decided to use httpOnly cookies.</message>',
    '    <message role="user">Show me the code</message>',
    '    <message role="assistant">' + codeBlock() + "</message>",
    "  </conversation_tail>",
    "</context_migration>",
  ];
  return lines.join("\n");
}

function chatgptPrompt(): string {
  const lines = [
    "**User:**",
    "",
    "How do I fix JWT auth?",
    "",
    "**Assistant:**",
    "",
    "The root cause is cookie scope mismatch. We decided to use httpOnly cookies.",
    "",
    "**User:**",
    "",
    "Show me the code",
    "",
    "**Assistant:**",
    "",
    codeBlock(),
  ];
  return lines.join("\n");
}

function geminiPrompt(): string {
  const lines = [
    "[CONTEXTMOVER MIGRATION]",
    "",
    "[RECENT MESSAGES]",
    "USER: How do I fix JWT auth?",
    "",
    "ASSISTANT: The root cause is cookie scope mismatch. We decided to use httpOnly cookies.",
    "",
    "USER: Show me the code",
    "",
    "ASSISTANT: " + codeBlock(),
  ];
  return lines.join("\n");
}

function grokPrompt(): string {
  const lines = [
    "**You:**",
    "",
    "How do I fix JWT auth?",
    "",
    "**Previous AI:**",
    "",
    "The root cause is cookie scope mismatch. We decided to use httpOnly cookies.",
    "",
    "**You:**",
    "",
    "Show me the code",
    "",
    "**Previous AI:**",
    "",
    codeBlock(),
  ];
  return lines.join("\n");
}

function deepseekPrompt(): string {
  const lines = [
    "**User:**",
    "",
    "How do I fix JWT auth?",
    "",
    "**Assistant:**",
    "",
    "The root cause is cookie scope mismatch. We decided to use httpOnly cookies.",
    "",
    "**User:**",
    "",
    "Show me the code",
    "",
    "**Assistant:**",
    "",
    codeBlock(),
  ];
  return lines.join("\n");
}

function perplexityPrompt(): string {
  const lines = [
    "User: How do I fix JWT auth?",
    "",
    "Perplexity: The root cause is cookie scope mismatch. We decided to use httpOnly cookies.",
    "",
    "User: Show me the code",
    "",
    "Perplexity: " + codeBlock(),
  ];
  return lines.join("\n");
}

const TEST_CASES: TestCase[] = [
  { platform: "claude", tier: 1, prompt: claudePrompt(), expected: { messageSurvival: { min: 15, max: 25 }, codeIntegrity: { min: 15, max: 20 }, keySignalRetention: { min: 8, max: 15 } } },
  { platform: "chatgpt", tier: 1, prompt: chatgptPrompt(), expected: { messageSurvival: { min: 15, max: 25 }, codeIntegrity: { min: 15, max: 20 }, keySignalRetention: { min: 8, max: 15 } } },
  { platform: "gemini", tier: 1, prompt: geminiPrompt(), expected: { messageSurvival: { min: 10, max: 25 }, keySignalRetention: { min: 8, max: 15 } } },
  { platform: "grok", tier: 1, prompt: grokPrompt(), expected: { messageSurvival: { min: 15, max: 25 }, codeIntegrity: { min: 15, max: 20 }, keySignalRetention: { min: 8, max: 15 } } },
  { platform: "deepseek", tier: 1, prompt: deepseekPrompt(), expected: { messageSurvival: { min: 15, max: 25 }, codeIntegrity: { min: 15, max: 20 }, keySignalRetention: { min: 8, max: 15 } } },
  { platform: "perplexity", tier: 1, prompt: perplexityPrompt(), expected: { messageSurvival: { min: 10, max: 25 }, codeIntegrity: { min: 15, max: 20 }, keySignalRetention: { min: 8, max: 15 } } },
];

export function runCalibration(): void {
  let passed = 0;
  let failed = 0;
  for (const tc of TEST_CASES) {
    const score = scoreMigration({ session: { ...mockSession, platform: tc.platform as any }, outputPrompt: tc.prompt, tier: tc.tier, platform: tc.platform });
    console.log("\n--- " + tc.platform + " (Tier " + tc.tier + ") ---");
    console.log(formatScoreReport(score));
    for (const [dim, range] of Object.entries(tc.expected)) {
      const actual = score.breakdown[dim as keyof typeof score.breakdown];
      if (actual < range.min || actual > range.max) {
        console.error("CALIBRATION FAIL: " + tc.platform + " " + dim + " expected " + range.min + "-" + range.max + ", got " + actual);
        failed++;
      } else {
        console.log("OK " + tc.platform + " " + dim + ": " + actual);
        passed++;
      }
    }
  }
  console.log("\n=== CALIBRATION: passed=" + passed + " failed=" + failed + " ===");
  if (failed > 0) throw new Error("Calibration failed: " + failed + " checks out of range");
}

