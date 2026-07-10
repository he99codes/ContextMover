/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { describe, it, expect } from "vitest";
import { chunkMessages } from "../chunker";
import type { Message } from "../../types";

const msg = (role: "user" | "assistant", content: string): Message => ({
  role,
  content,
  timestamp: Date.now(),
});

// ─────────────────────────────────────────────────────────────────────────────
// chunkMessages
// ─────────────────────────────────────────────────────────────────────────────

describe("chunkMessages", () => {
  describe("basic behavior", () => {
    it("returns empty array for empty input", () => {
      expect(chunkMessages([])).toEqual([]);
    });

    it("skips messages with empty content", () => {
      const messages = [msg("user", ""), msg("assistant", "")];
      expect(chunkMessages(messages)).toEqual([]);
    });

    it("skips messages with very short content (<20 chars after cleaning)", () => {
      const messages = [msg("user", "Hi"), msg("assistant", "Ok")];
      expect(chunkMessages(messages)).toEqual([]);
    });

    it("creates chunks from substantial messages", () => {
      const messages = [
        msg("user", "Can you explain how React hooks work in detail and provide examples?"),
        msg("assistant", "React hooks are functions that let you use state and lifecycle features in functional components. The most common hooks are useState and useEffect."),
      ];
      const chunks = chunkMessages(messages);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].role).toBe("user");
    });
  });

  describe("code block handling", () => {
    it("keeps code blocks as atomic chunks", () => {
      const content = "Here's the code:\n```typescript\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```\nThat's the implementation.";
      const messages = [msg("assistant", content)];
      const chunks = chunkMessages(messages);
      const codeChunks = chunks.filter((c) => c.isCodeChunk);
      expect(codeChunks.length).toBeGreaterThan(0);
      expect(codeChunks[0].hasCode).toBe(true);
      expect(codeChunks[0].language).toBe("typescript");
      expect(codeChunks[0].text).toContain("function add");
    });

    it("preserves code block language tag", () => {
      const content = "```python\ndef hello():\n    print('world')\n```";
      const messages = [msg("assistant", content)];
      const chunks = chunkMessages(messages);
      const codeChunk = chunks.find((c) => c.isCodeChunk);
      expect(codeChunk?.language).toBe("python");
    });

    it("handles code blocks without language tag", () => {
      const content = "```\nsome code here\nmore lines\n```";
      const messages = [msg("assistant", content)];
      const chunks = chunkMessages(messages);
      const codeChunk = chunks.find((c) => c.isCodeChunk);
      expect(codeChunk?.language).toBeUndefined();
      expect(codeChunk?.isCodeChunk).toBe(true);
    });
  });

  describe("prose splitting", () => {
    it("splits long prose into multiple chunks", () => {
      const longText = Array(50)
        .fill("This is a moderately long sentence about software engineering principles. ")
        .join("");
      const messages = [msg("assistant", longText)];
      const chunks = chunkMessages(messages);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("each chunk has a reasonable token count", () => {
      const longText = Array(50)
        .fill("Explaining the detailed architecture of distributed systems. ")
        .join("");
      const messages = [msg("assistant", longText)];
      const chunks = chunkMessages(messages);
      for (const chunk of chunks) {
        expect(chunk.tokenCount).toBeGreaterThan(0);
      }
    });
  });

  describe("chunk metadata", () => {
    it("assigns correct messageIndex", () => {
      const messages = [
        msg("user", "First message that is long enough to pass the minimum threshold checks."),
        msg("assistant", "Second message that is also long enough to pass minimum threshold."),
      ];
      const chunks = chunkMessages(messages);
      const indices = chunks.map((c) => c.messageIndex);
      expect(indices).toContain(0);
      expect(indices).toContain(1);
    });

    it("assigns correct role from source message", () => {
      const messages = [
        msg("user", "This user message discusses the architecture of the system in detail."),
        msg("assistant", "This assistant response provides a detailed explanation of the solution."),
      ];
      const chunks = chunkMessages(messages);
      const userChunks = chunks.filter((c) => c.role === "user");
      const asstChunks = chunks.filter((c) => c.role === "assistant");
      expect(userChunks.length).toBeGreaterThan(0);
      expect(asstChunks.length).toBeGreaterThan(0);
    });
  });

  describe("max chunks cap", () => {
    it("caps output at MAX_CHUNKS_PER_SESSION (2000)", () => {
      // Generate enough messages to exceed 2000 chunks
      const messages = Array.from({ length: 500 }, (_, i) =>
        msg(
          i % 2 === 0 ? "user" : "assistant",
          Array(20)
            .fill(`Sentence ${i} about distributed systems architecture and design patterns. `)
            .join("")
        )
      );
      const chunks = chunkMessages(messages);
      expect(chunks.length).toBeLessThanOrEqual(2000);
    });
  });
});
