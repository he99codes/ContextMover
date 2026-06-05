/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { describe, it, expect, vi } from "vitest";
import { getGrade, scoreMigration, formatScoreReport } from "../migration-scorer";
import type { ScorerInput, QualityScore } from "../migration-scorer";
import type { ContextSession, Message } from "../../types";

// Silence console.warn in tests
vi.spyOn(console, "warn").mockImplementation(() => {});

const msg = (role: "user" | "assistant", content: string): Message => ({
  role,
  content,
  timestamp: Date.now(),
});

function makeSession(messages: Message[]): ContextSession {
  return {
    id: "test-session-1",
    platform: "claude",
    title: "Test Session",
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getGrade
// ─────────────────────────────────────────────────────────────────────────────

describe("getGrade", () => {
  it("returns Excellent for scores >= 90", () => {
    expect(getGrade(90)).toBe("Excellent");
    expect(getGrade(100)).toBe("Excellent");
    expect(getGrade(95)).toBe("Excellent");
  });

  it("returns Good for scores 75-89", () => {
    expect(getGrade(75)).toBe("Good");
    expect(getGrade(89)).toBe("Good");
  });

  it("returns Acceptable for scores 60-74", () => {
    expect(getGrade(60)).toBe("Acceptable");
    expect(getGrade(74)).toBe("Acceptable");
  });

  it("returns Poor for scores 40-59", () => {
    expect(getGrade(40)).toBe("Poor");
    expect(getGrade(59)).toBe("Poor");
  });

  it("returns Failed for scores < 40", () => {
    expect(getGrade(0)).toBe("Failed");
    expect(getGrade(39)).toBe("Failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreMigration
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreMigration", () => {
  it("returns a valid QualityScore for a basic migration", () => {
    const messages = [
      msg("user", "How do I implement JWT auth?"),
      msg("assistant", "Here's how to implement JWT authentication."),
      msg("user", "We decided to use RS256 for our approach."),
      msg("assistant", "The fix is to use httpOnly cookies for storage."),
    ];
    const session = makeSession(messages);
    const outputPrompt =
      '<message role="user">How do I implement JWT auth?</message>\n' +
      '<message role="assistant">Here\'s how to implement JWT authentication.</message>\n' +
      '<message role="user">We decided to use RS256 for our approach.</message>\n' +
      '<message role="assistant">The fix is to use httpOnly cookies for storage.</message>';

    const input: ScorerInput = {
      session,
      outputPrompt,
      tier: 1,
      platform: "claude",
    };

    const result = scoreMigration(input);
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
    expect(result.grade).toBeDefined();
    expect(result.breakdown).toBeDefined();
    expect(result.meta).toBeDefined();
  });

  it("never throws — returns Failed grade on bad input", () => {
    const input = {
      session: null as unknown as ContextSession,
      outputPrompt: "",
      tier: 1 as const,
      platform: "claude",
    };
    const result = scoreMigration(input);
    expect(result.grade).toBe("Failed");
    expect(result.total).toBe(0);
  });

  it("correctly computes code integrity when code blocks are preserved", () => {
    const messages = [
      msg("user", "Write a function"),
      msg("assistant", "```typescript\nfunction hello() {}\n```"),
    ];
    const session = makeSession(messages);
    const outputPrompt = "```typescript\nfunction hello() {}\n```";

    const result = scoreMigration({
      session,
      outputPrompt,
      tier: 1,
      platform: "chatgpt",
    });
    expect(result.breakdown.codeIntegrity).toBe(20);
  });

  it("penalizes truncated code blocks", () => {
    const messages = [
      msg("user", "Write code"),
      msg("assistant", "```typescript\nfunction hello() {}\n```"),
    ];
    const session = makeSession(messages);
    // Odd number of ``` fences = truncated
    const outputPrompt = "```typescript\nfunction hello() {}";

    const result = scoreMigration({
      session,
      outputPrompt,
      tier: 1,
      platform: "chatgpt",
    });
    expect(result.breakdown.codeIntegrity).toBeLessThan(20);
  });

  it("gives full code integrity when no code in source", () => {
    const messages = [
      msg("user", "What is the weather?"),
      msg("assistant", "It is sunny today."),
    ];
    const session = makeSession(messages);
    const outputPrompt = "It is sunny today.";

    const result = scoreMigration({
      session,
      outputPrompt,
      tier: 1,
      platform: "claude",
    });
    expect(result.breakdown.codeIntegrity).toBe(20);
  });

  it("scores context freshness based on tail messages", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      msg(
        i % 2 === 0 ? "user" : "assistant",
        `Message number ${i} with enough content to be unique fingerprint.`
      )
    );
    const session = makeSession(messages);
    // Include last 6 messages in output
    const outputPrompt = messages
      .slice(-6)
      .map((m) => `<message role="${m.role}">${m.content}</message>`)
      .join("\n");

    const result = scoreMigration({
      session,
      outputPrompt,
      tier: 1,
      platform: "claude",
    });
    expect(result.breakdown.contextFreshness).toBe(15);
  });

  it("tracks compression efficiency by tier", () => {
    const messages = [
      msg("user", "Question about the system design patterns we are using."),
      msg("assistant", "We decided to use a modular architecture for scalability."),
    ];
    const session = makeSession(messages);

    // Tier 1 always gets 10/10
    const r1 = scoreMigration({
      session,
      outputPrompt: "short",
      tier: 1,
      platform: "claude",
    });
    expect(r1.breakdown.compressionEfficiency).toBe(10);

    // Tier 3 with topK >= 15 → 10/10
    const r3 = scoreMigration({
      session,
      outputPrompt: "short",
      tier: 3,
      platform: "claude",
      topK: 15,
    });
    expect(r3.breakdown.compressionEfficiency).toBe(10);
  });

  it("meta contains correct platform and tier", () => {
    const messages = [
      msg("user", "Hello there friend!"),
      msg("assistant", "Hi! How can I help you today?"),
    ];
    const session = makeSession(messages);
    const result = scoreMigration({
      session,
      outputPrompt: "output",
      tier: 2,
      platform: "gemini",
    });
    expect(result.meta.platform).toBe("gemini");
    expect(result.meta.tier).toBe(2);
    expect(result.meta.sessionId).toBe("test-session-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatScoreReport
// ─────────────────────────────────────────────────────────────────────────────

describe("formatScoreReport", () => {
  it("formats a QualityScore into a readable string", () => {
    const score: QualityScore = {
      total: 85,
      grade: "Good",
      breakdown: {
        messageSurvival: 20,
        codeIntegrity: 18,
        roleAccuracy: 15,
        contextFreshness: 12,
        keySignalRetention: 12,
        compressionEfficiency: 8,
      },
      meta: {
        originalMessages: 10,
        preservedMessages: 8,
        preservedUser: 4,
        preservedAsst: 4,
        originalCodeBlocks: 3,
        preservedCodeBlocks: 3,
        originalSignals: 5,
        preservedSignals: 4,
        compressionRatio: 0.65,
        tier: 2,
        platform: "chatgpt",
        sessionId: "session-abc",
        timestamp: Date.now(),
        migrationId: "mig-12345678-abcdefgh",
      },
    };

    const report = formatScoreReport(score);
    expect(report).toContain("85/100");
    expect(report).toContain("Good");
    expect(report).toContain("chatgpt");
    expect(report).toContain("Tier 2");
    expect(report).toContain("Messages:");
    expect(report).toContain("Code:");
    expect(report).toContain("Roles:");
    expect(report).toContain("Freshness:");
    expect(report).toContain("Signals:");
    expect(report).toContain("Compression:");
  });
});
