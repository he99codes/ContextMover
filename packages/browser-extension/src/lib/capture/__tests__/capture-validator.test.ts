/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { describe, it, expect, vi } from "vitest";
import { validateCapture } from "../capture-validator";
import type { Message } from "@/lib/types";

// Silence console.log in tests
vi.spyOn(console, "log").mockImplementation(() => {});

const msg = (role: "user" | "assistant", content: string): Message => ({
  role,
  content,
  timestamp: Date.now(),
});

describe("validateCapture", () => {
  describe("valid captures", () => {
    it("accepts a balanced conversation", () => {
      const messages = [
        msg("user", "Hello, how are you?"),
        msg("assistant", "I'm doing great, thanks for asking!"),
        msg("user", "Can you help with a task?"),
        msg("assistant", "Of course! What do you need help with?"),
      ];
      const result = validateCapture(messages, "claude");
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("returns correct stats", () => {
      const messages = [
        msg("user", "Question one about code"),
        msg("assistant", "Answer one with ```typescript\ncode\n```"),
        msg("user", "Question two"),
        msg("assistant", "Answer two"),
      ];
      const result = validateCapture(messages, "chatgpt");
      expect(result.stats.total).toBe(4);
      expect(result.stats.user).toBe(2);
      expect(result.stats.assistant).toBe(2);
      expect(result.stats.hasCode).toBe(true);
      expect(result.stats.detectionMethod).toBe("registry");
    });
  });

  describe("invalid captures", () => {
    it("rejects empty messages array", () => {
      const result = validateCapture([], "claude");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("No messages captured");
    });

    it("rejects 0 assistant messages", () => {
      const messages = [
        msg("user", "Hello there!"),
        msg("user", "Anyone there?"),
      ];
      const result = validateCapture(messages, "gemini");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("0 assistant messages");
    });

    it("rejects 0 user messages", () => {
      const messages = [
        msg("assistant", "Hello! How can I help?"),
        msg("assistant", "Still here if you need me."),
      ];
      const result = validateCapture(messages, "grok");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("0 user messages");
    });
  });

  describe("warnings", () => {
    it("warns on role imbalance", () => {
      const messages = [
        msg("user", "Question 1 for testing"),
        msg("user", "Question 2 for testing"),
        msg("user", "Question 3 for testing"),
        msg("assistant", "Only one answer here"),
      ];
      const result = validateCapture(messages, "chatgpt");
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("Role imbalance"))).toBe(true);
    });

    it("warns on near-empty messages", () => {
      const messages = [
        msg("user", "Hi"),
        msg("assistant", "A proper response to your question"),
      ];
      const result = validateCapture(messages, "claude");
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("near-empty"))).toBe(true);
    });

    it("warns on many consecutive same-role messages", () => {
      const messages = [
        msg("user", "First question about the topic"),
        msg("assistant", "Response one to your question"),
        msg("assistant", "Response two to your question"),
        msg("assistant", "Response three to your question"),
        msg("assistant", "Response four to your question"),
        msg("assistant", "Response five to your question"),
      ];
      const result = validateCapture(messages, "deepseek");
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("consecutive same-role"))).toBe(
        true
      );
    });
  });

  describe("detection method", () => {
    it("uses provided detection method in stats", () => {
      const messages = [
        msg("user", "Hello there friend!"),
        msg("assistant", "Hi! How can I help you today?"),
      ];
      const result = validateCapture(messages, "claude", "structural");
      expect(result.stats.detectionMethod).toBe("structural");
    });

    it("defaults to registry detection method", () => {
      const messages = [
        msg("user", "Hello there friend!"),
        msg("assistant", "Hi! How can I help you today?"),
      ];
      const result = validateCapture(messages, "claude");
      expect(result.stats.detectionMethod).toBe("registry");
    });
  });

  describe("code detection", () => {
    it("detects code blocks in messages", () => {
      const messages = [
        msg("user", "Write a function"),
        msg("assistant", "```python\ndef hello():\n  pass\n```"),
      ];
      const result = validateCapture(messages, "claude");
      expect(result.stats.hasCode).toBe(true);
    });

    it("reports no code when none present", () => {
      const messages = [
        msg("user", "What is the weather?"),
        msg("assistant", "It's sunny today!"),
      ];
      const result = validateCapture(messages, "claude");
      expect(result.stats.hasCode).toBe(false);
    });
  });
});
