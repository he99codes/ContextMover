/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { describe, it, expect } from "vitest";
import { urlKeyFromHref, legacySessionId } from "../session-id";

// ─────────────────────────────────────────────────────────────────────────────
// urlKeyFromHref
// ─────────────────────────────────────────────────────────────────────────────

describe("urlKeyFromHref", () => {
  it("creates a key from platform and normalized URL", () => {
    const key = urlKeyFromHref("claude", "https://claude.ai/chat/abc123");
    expect(key).toBe("claude::claude.ai/chat/abc123");
  });

  it("strips trailing slash", () => {
    const key = urlKeyFromHref("chatgpt", "https://chatgpt.com/c/abc/");
    expect(key).toBe("chatgpt::chatgpt.com/c/abc");
  });

  it("preserves query params for generic platforms", () => {
    const key = urlKeyFromHref("claude", "https://claude.ai/chat/abc?foo=bar");
    expect(key).toBe("claude::claude.ai/chat/abc?foo=bar");
  });

  describe("platform-specific param stripping", () => {
    it("removes ?rid= for Grok", () => {
      const key = urlKeyFromHref(
        "grok",
        "https://grok.com/chat/abc123?rid=request-id-456"
      );
      expect(key).not.toContain("rid=");
      expect(key).toBe("grok::grok.com/chat/abc123");
    });

    it("keeps non-rid params for Grok", () => {
      const key = urlKeyFromHref(
        "grok",
        "https://grok.com/chat/abc?other=keep&rid=drop"
      );
      expect(key).toContain("other=keep");
      expect(key).not.toContain("rid=");
    });

    it("handles Grok /c/ UUID path (2026 URL format)", () => {
      const key = urlKeyFromHref(
        "grok",
        "https://grok.com/c/cc7539f3-88b4-46a4-aaeb-decbc8ddd050?rid=3f456731-f3c0-468f-895d-e8cc830d05bf"
      );
      expect(key).not.toContain("rid=");
      expect(key).toBe("grok::grok.com/c/cc7539f3-88b4-46a4-aaeb-decbc8ddd050");
    });

    it("strips model params for ChatGPT, keeping conversation ID", () => {
      const key = urlKeyFromHref(
        "chatgpt",
        "https://chatgpt.com/c/abc?model=gpt-4&c=conv123"
      );
      expect(key).toContain("c=conv123");
      expect(key).not.toContain("model=");
    });

    it("strips all params for ChatGPT when no conversation ID", () => {
      const key = urlKeyFromHref(
        "chatgpt",
        "https://chatgpt.com/c/abc?model=gpt-4"
      );
      expect(key).toBe("chatgpt::chatgpt.com/c/abc");
    });

    it("strips all query params for Perplexity", () => {
      const key = urlKeyFromHref(
        "perplexity",
        "https://www.perplexity.ai/search/abc?tracking=123"
      );
      expect(key).toBe("perplexity::www.perplexity.ai/search/abc");
    });
  });

  it("falls back to raw href on invalid URL", () => {
    const key = urlKeyFromHref("claude", "not-a-valid-url");
    expect(key).toBe("claude::not-a-valid-url");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// legacySessionId
// ─────────────────────────────────────────────────────────────────────────────

describe("legacySessionId", () => {
  it("returns platform-prefixed hash string", () => {
    const id = legacySessionId("claude", "https://claude.ai/chat/abc123");
    expect(id).toMatch(/^claude-[a-z0-9]+$/);
  });

  it("produces the same id for the same URL", () => {
    const url = "https://chatgpt.com/c/conversation-id";
    const id1 = legacySessionId("chatgpt", url);
    const id2 = legacySessionId("chatgpt", url);
    expect(id1).toBe(id2);
  });

  it("produces different ids for different URLs", () => {
    const id1 = legacySessionId("claude", "https://claude.ai/chat/aaa");
    const id2 = legacySessionId("claude", "https://claude.ai/chat/bbb");
    expect(id1).not.toBe(id2);
  });

  it("produces different ids for different platforms", () => {
    const url = "https://example.com/chat/123";
    const id1 = legacySessionId("claude", url);
    const id2 = legacySessionId("chatgpt", url);
    expect(id1).not.toBe(id2);
  });

  it("strips trailing slash before hashing", () => {
    const id1 = legacySessionId("claude", "https://claude.ai/chat/abc/");
    const id2 = legacySessionId("claude", "https://claude.ai/chat/abc");
    expect(id1).toBe(id2);
  });

  it("handles invalid URLs gracefully", () => {
    const id = legacySessionId("gemini", "not-a-url");
    expect(id).toMatch(/^gemini-[a-z0-9]+$/);
  });
});
