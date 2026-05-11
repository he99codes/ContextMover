/**
 * ContextMover — Pipeline Integration Tests
 *
 * Sections:
 *   1. Summarizer      (summarize, caveman compression, code extraction)
 *   2. Translator      (all 6 platform builders + caveman flag)
 *   3. Fetch interceptor parsers  (inline mirrors — see NOTE below)
 *   4. End-to-end      (summarize → buildMigrationPrompt for all platforms)
 *
 * NOTE — fetch-interceptor.ts is a MAIN-world IIFE and cannot be imported.
 * Parser logic is mirrored here as pure functions for regression testing.
 * If you change a parser in fetch-interceptor.ts, update its mirror below.
 *
 * HOW TO ADD NEW TESTS
 *   • New pipeline feature → add describe block in the relevant section.
 *   • New platform        → duplicate any platform block and update strings.
 *   • New fixture         → add to FIXTURES section and reuse across tests.
 *   • Run:   pnpm --filter browser-extension test
 *   • Watch: pnpm --filter browser-extension test:watch
 */

import { describe, it, expect } from "vitest";
import summarize from "../lib/summarizer";
import buildMigrationPrompt from "../lib/translator";
import type { ContextSession, Message, MigrationPayload } from "../lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

const msg = (role: "user" | "assistant", content: string): Message => ({
  role, content, timestamp: Date.now(),
});

const SHORT: Message[] = [
  msg("user",      "What is the capital of France?"),
  msg("assistant", "The capital of France is Paris."),
];

const LONG: Message[] = Array.from({ length: 40 }, (_, i) =>
  i % 2 === 0
    ? msg(
        "user",
        `I need help with task ${i + 1}. Specifically, I am trying to implement feature ${i + 1} ` +
        `in a way that is maintainable, testable, and performant. The current implementation has ` +
        `several issues including performance bottlenecks, lack of error handling, and missing type ` +
        `annotations. Could you please walk me through the best approach step by step?`
      )
    : msg(
        "assistant",
        `For task ${i}, I decided to use approach X instead of approach Y because approach X provides ` +
        `better performance characteristics under high load and is more consistent with the existing ` +
        `codebase patterns. The implementation is now complete. I chose to implement strict error ` +
        `handling using Result types and added full TypeScript annotations throughout. The solution ` +
        `is now working correctly and all edge cases have been handled.`
      )
);

const CODE: Message[] = [
  msg("user", "Write a TypeScript add function."),
  msg("assistant", `Here it is:\n\`\`\`typescript\n// src/utils/add.ts\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n\`\`\`\nCompleted successfully.`),
  msg("user", "Add a test."),
  msg("assistant", `\`\`\`typescript\nimport { add } from "./add";\ntest("add", () => expect(add(1, 2)).toBe(3));\n\`\`\`\nChose vitest instead of jest for better Vite integration.`),
];

const CAVEMAN_LONG: Message[] = [
  ...Array.from({ length: 8 }, (_, i) =>
    i % 2 === 0
      ? msg("user",      `Hi! Can you please help me? I was wondering if you could do task ${i + 1}.`)
      : msg("assistant", `Sure! I decided to use pattern Z rather than W due to performance. Task ${i} done.`)
  ),
  msg("user",      "Final question here."),
  msg("assistant", "Final answer here."),
];

const BASE_SESSION: ContextSession = {
  id: "test-1",
  platform: "claude",
  title: "Test Session",
  messages: SHORT,
  createdAt: 1000,
  updatedAt: 2000,
};

const RICH_EXTRACTED: MigrationPayload["extracted"] = {
  primaryGoal: "Implement JWT authentication",
  currentFocus: "Refresh token rotation",
  completed: ["Login endpoint", "JWT signing"],
  pending:   ["Refresh token endpoint", "Tests"],
  decisions: "- Chose RS256 over HS256 for asymmetric key support",
  facts:     "- Must use httpOnly cookies",
  codeBlocks: [{
    language: "typescript",
    path:     "src/auth.ts",
    content:  `export function signJWT(payload: object): string {\n  return "token";\n}`,
    context:  "JWT signing helper",
  }],
  conversationTail: [
    msg("user",      "How do I rotate refresh tokens?"),
    msg("assistant", "Store a token family ID and invalidate the whole family on reuse."),
  ],
  messageCount: 12,
};

const PLATFORMS = ["claude", "chatgpt", "gemini", "grok", "perplexity", "deepseek"] as const;

function payload(
  targetPlatform: (typeof PLATFORMS)[number],
  opts: { caveman?: boolean; ide?: string } = {}
): MigrationPayload {
  return {
    summary:       "Test summary",
    extracted:     RICH_EXTRACTED,
    ideContext:    opts.ide,
    targetPlatform,
    sourceSession: { ...BASE_SESSION, messages: CODE, platform: "claude" },
    caveman:       opts.caveman ?? false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SUMMARIZER PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

describe("1 · Summarizer pipeline", () => {
  describe("empty input", () => {
    it("verbatim mode, zero estimates", async () => {
      const r = await summarize([]);
      expect(r.mode).toBe("verbatim");
      expect(r.originalTokenEstimate).toBe(0);
      expect(r.content).toBe("(no conversation history)");
    });

    it("extracted defaults are sensible", async () => {
      const { extracted: ex } = await summarize([]);
      expect(ex.primaryGoal).toBe("Not specified");
      expect(ex.codeBlocks).toHaveLength(0);
      expect(ex.messageCount).toBe(0);
    });
  });

  describe("short session (verbatim)", () => {
    it("mode === verbatim", async () => expect((await summarize(SHORT)).mode).toBe("verbatim"));

    it("content contains both roles", async () => {
      const { content } = await summarize(SHORT);
      expect(content).toContain("USER:");
      expect(content).toContain("ASSISTANT:");
    });

    it("primaryGoal = first user message", async () => {
      const { extracted } = await summarize(SHORT);
      expect(extracted.primaryGoal).toContain("capital of France");
    });

    it("conversationTail = full session when ≤ 6 msgs", async () => {
      const { extracted } = await summarize(SHORT);
      expect(extracted.conversationTail).toHaveLength(SHORT.length);
    });

    it("messageCount matches input", async () => {
      const { extracted } = await summarize(SHORT);
      expect(extracted.messageCount).toBe(SHORT.length);
    });
  });

  describe("long session (summarised)", () => {
    it("mode === summarized", async () => expect((await summarize(LONG)).mode).toBe("summarized"));

    it("summary is shorter than original", async () => {
      const r = await summarize(LONG);
      expect(r.summaryTokenEstimate).toBeLessThan(r.originalTokenEstimate);
    });

    it("conversationTail capped at 6", async () => {
      const { extracted } = await summarize(LONG);
      expect(extracted.conversationTail).toHaveLength(6);
    });

    it("tail contains the LAST 6 messages", async () => {
      const { extracted } = await summarize(LONG);
      const last6 = LONG.slice(-6);
      extracted.conversationTail.forEach((m, i) =>
        expect(m.content).toBe(last6[i].content)
      );
    });

    it("decisions extracted", async () => {
      const { extracted } = await summarize(LONG);
      expect(extracted.decisions.length).toBeGreaterThan(0);
    });
  });

  describe("code block extraction", () => {
    it("extracts ≥ 2 blocks from CODE fixture", async () => {
      const { extracted } = await summarize(CODE);
      expect(extracted.codeBlocks.length).toBeGreaterThanOrEqual(2);
    });

    it("block content never truncated", async () => {
      const { extracted } = await summarize(CODE);
      const b = extracted.codeBlocks.find((b) => b.path === "src/utils/add.ts");
      expect(b).toBeDefined();
      expect(b!.content).toContain("export function add");
    });

    it("path detected from first-line comment", async () => {
      const { extracted } = await summarize(CODE);
      expect(extracted.codeBlocks.some((b) => b.path === "src/utils/add.ts")).toBe(true);
    });

    it("code appears in plain-text summary", async () => {
      const { content } = await summarize(CODE);
      expect(content).toContain("```typescript");
    });
  });

  describe("caveman mode — aggressive compression", () => {
    it("last 6 messages verbatim — unchanged by compression", async () => {
      const { extracted } = await summarize(CAVEMAN_LONG, { caveman: true });
      const last6 = CAVEMAN_LONG.slice(-6);
      extracted.conversationTail.forEach((m, i) =>
        expect(m.content).toBe(last6[i].content)
      );
    });

    it("code blocks always from original (not compressed)", async () => {
      const msgs = [...CAVEMAN_LONG, msg("assistant", "Code:\n```ts\nconst x = 42;\n```")];
      const { extracted } = await summarize(msgs, { caveman: true });
      expect(extracted.codeBlocks.some((b) => b.content.includes("const x = 42"))).toBe(true);
    });

    it("primaryGoal uses original messages, not compressed", async () => {
      const { extracted: norm }    = await summarize(CAVEMAN_LONG);
      const { extracted: caveRes } = await summarize(CAVEMAN_LONG, { caveman: true });
      expect(caveRes.primaryGoal).toBe(norm.primaryGoal);
    });

    it("mode unchanged by caveman flag", async () => {
      const norm = await summarize(CAVEMAN_LONG);
      const cave = await summarize(CAVEMAN_LONG, { caveman: true });
      expect(cave.mode).toBe(norm.mode);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TRANSLATOR PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

// Claude uses a multi-line XML block; all other platforms use a single-line markdown sentence.
const CAVEMAN_CLAUDE = "Response style: Caveman mode.";
const CAVEMAN_MD     = "Caveman mode. No filler. No pleasantries. No hedging.";
// Universal absence-check: this substring never appears in any platform when caveman=false.
const CAVEMAN_OFF    = "No filler. No pleasantries. No hedging.";

describe("2 · Translator pipeline", () => {
  describe("universal requirements (all 6 platforms)", () => {
    for (const p of PLATFORMS) {
      it(`${p}: non-empty output (> 500 chars)`, () =>
        expect(buildMigrationPrompt(payload(p)).length).toBeGreaterThan(500));

      it(`${p}: contains source platform`, () =>
        expect(buildMigrationPrompt(payload(p)).toLowerCase()).toContain("claude"));

      it(`${p}: contains code block content`, () =>
        expect(buildMigrationPrompt(payload(p))).toContain("signJWT"));

      it(`${p}: contains conversation tail`, () =>
        expect(buildMigrationPrompt(payload(p))).toContain("rotate refresh tokens"));

      it(`${p}: contains key decision`, () =>
        expect(buildMigrationPrompt(payload(p))).toContain("RS256"));

      it(`${p}: caveman=true → caveman line present`, () => {
        const prompt = buildMigrationPrompt(payload(p, { caveman: true }));
        expect(prompt).toContain(p === "claude" ? CAVEMAN_CLAUDE : CAVEMAN_MD);
      });

      it(`${p}: caveman=false → caveman line absent`, () =>
        expect(buildMigrationPrompt(payload(p, { caveman: false }))).not.toContain(CAVEMAN_OFF));
    }
  });

  describe("platform-specific format markers", () => {
    it("claude: XML wrapper", () => {
      const p = buildMigrationPrompt(payload("claude"));
      expect(p).toContain("<context_migration>");
      expect(p).toContain("</context_migration>");
      expect(p).toContain("<instructions>");
    });

    it("chatgpt: ## Markdown headings", () => {
      const p = buildMigrationPrompt(payload("chatgpt"));
      expect(p).toContain("## Migrated Session");
      expect(p).toContain("## Instructions");
    });

    it("gemini: [SECTION] plain-text delimiters", () => {
      const p = buildMigrationPrompt(payload("gemini"));
      expect(p).toContain("[CONTEXTMOVER MIGRATION]");
      expect(p).toContain("[GOAL]");
      expect(p).toContain("[TASK]");
    });

    it("grok: casual ContextMover header", () =>
      expect(buildMigrationPrompt(payload("grok"))).toContain("ContextMover — Session Import (Grok)"));

    it("perplexity: Perplexity header", () =>
      expect(buildMigrationPrompt(payload("perplexity"))).toContain("Migrated Context — Perplexity"));

    it("deepseek: # h1 technical header", () =>
      expect(buildMigrationPrompt(payload("deepseek"))).toContain("# ContextMover Migration → DeepSeek"));
  });

  describe("progress sections", () => {
    it("completed items present", () =>
      expect(buildMigrationPrompt(payload("chatgpt"))).toContain("Login endpoint"));

    it("pending items present", () =>
      expect(buildMigrationPrompt(payload("chatgpt"))).toContain("Refresh token endpoint"));
  });

  describe("IDE context", () => {
    it("ide content injected when provided", () => {
      const p = buildMigrationPrompt(payload("claude", { ide: "JWT_SECRET=env" }));
      expect(p).toContain("JWT_SECRET");
    });

    it("no ide block when not provided", () => {
      const p = buildMigrationPrompt(payload("claude"));
      expect(p).not.toContain("ide_context");
    });
  });

  describe("fallback without extracted context", () => {
    for (const p of PLATFORMS) {
      it(`${p}: works with extracted=undefined`, () => {
        const prompt = buildMigrationPrompt({
          summary:       "Fallback summary",
          extracted:     undefined,
          targetPlatform: p,
          sourceSession: BASE_SESSION,
        });
        expect(prompt.length).toBeGreaterThan(50);
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. FETCH INTERCEPTOR PARSERS  (inline mirrors of fetch-interceptor.ts)
// ─────────────────────────────────────────────────────────────────────────────

type Role2 = "user" | "assistant";
interface CM { role: Role2; content: string; timestamp: number; }

const fin2 = (role: Role2, text: string): CM | null => {
  const t = text.trim();
  return t ? { role, content: t, timestamp: 0 } : null;
};

// MIRROR: detectPlatform
function detectPlatform(url: string): string | null {
  if (!url) return null;
  if (/chatgpt\.com\/backend-api\/conversation|chat\.openai\.com\/backend-api\/conversation/.test(url)) return "chatgpt";
  if ((url.includes("claude.ai/api") && /completion|append_message|chat_conversations/.test(url)) ||
      ((url.includes("a-api.anthropic.com") || url.includes("api.anthropic.com")) && /\/v1\//.test(url))) return "claude";
  if (url.includes("gemini.google.com") && /GenerateContent|StreamGenerate|BardChatUi|assistant\.lamda/i.test(url)) return "gemini";
  if (url.includes("grok.com/api") && /chat|conversation|completion/i.test(url)) return "grok";
  if (url.includes("chat.deepseek.com/api") && /chat|completion|message/i.test(url)) return "deepseek";
  if (url.includes("perplexity.ai") && /\/api\/|search|ask|completions/i.test(url)) return "perplexity";
  return null;
}

// MIRROR: extractOpenAIUserPrompt
function extractOpenAIUserPrompt(body: string | null): CM | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const msgs = parsed.messages as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(msgs)) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m?.role !== "user") continue;
        let text = typeof m.content === "string" ? m.content : "";
        if (Array.isArray(m.content))
          text = (m.content as Array<Record<string, unknown>>)
            .filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("\n");
        const r = fin2("user", text);
        if (r) return r;
      }
    }
    const single = (typeof parsed.message === "string" && parsed.message) ||
                   (typeof parsed.query   === "string" && parsed.query)   ||
                   (typeof parsed.q       === "string" && parsed.q) || "";
    return single ? fin2("user", single) : null;
  } catch { return null; }
}

// MIRROR: parseClaude (Anthropic SSE)
function parseClaude(text: string, requestBody?: string | null): CM[] {
  const lines = text.split(/\r?\n/);
  let curEvent = "";
  let acc = "";
  let role: Role2 = "assistant";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("event:")) { curEvent = line.slice(6).trim(); continue; }
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let j: unknown;
    try { j = JSON.parse(payload); } catch { continue; }
    const obj = j as Record<string, unknown>;
    if (curEvent === "message_start" || obj.type === "message_start") {
      const m = obj.message as Record<string, unknown> | undefined;
      const r = String(m?.role ?? "assistant");
      if (r === "user" || r === "assistant") role = r as Role2;
      continue;
    }
    if (curEvent === "content_block_delta" || obj.type === "content_block_delta") {
      const delta = obj.delta as Record<string, unknown> | undefined;
      acc += String(delta?.text ?? "");
      continue;
    }
    if (typeof obj.completion === "string") acc += obj.completion;
  }
  const results: CM[] = [];
  const user = extractOpenAIUserPrompt(requestBody ?? null);
  if (user) results.push(user);
  const asst = fin2(role, acc);
  if (asst) results.push(asst);
  return results;
}

// MIRROR: parseChatGPT (OpenAI SSE delta)
function parseChatGPT(text: string): CM[] {
  const lines = text.split(/\r?\n/);
  let acc = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      if (Array.isArray(obj.choices)) {
        const delta = ((obj.choices as Array<Record<string, unknown>>)[0]?.delta as Record<string, unknown>) ?? {};
        if (typeof delta.content === "string") acc += delta.content;
      }
    } catch { /* skip */ }
  }
  const r = fin2("assistant", acc);
  return r ? [r] : [];
}

// MIRROR: parsePerplexitySocketIO
function parsePerplexityWS(data: string): CM[] {
  if (!data.startsWith("42")) return [];
  try {
    let jsonStr = data.slice(2);
    if (jsonStr.startsWith("/")) {
      const comma = jsonStr.indexOf(",");
      if (comma === -1) return [];
      jsonStr = jsonStr.slice(comma + 1);
    }
    const arr = JSON.parse(jsonStr) as unknown;
    if (!Array.isArray(arr) || arr.length < 2) return [];
    const eventName = String(arr[0]);
    const p = arr[1] as Record<string, unknown>;
    if (!p || typeof p !== "object") return [];
    const status = String(p.status ?? "");
    const isFinal = ["completed", "done", "final"].includes(status) || /complet|finish/i.test(eventName);
    if (!isFinal) return [];
    const asstText = (typeof p.text   === "string" && p.text)   ||
                     (typeof p.answer === "string" && p.answer) || "";
    const userText = (typeof p.query_str === "string" && p.query_str) ||
                     (typeof p.query     === "string" && p.query)     || "";
    const results: CM[] = [];
    const u = fin2("user", userText);
    if (u) results.push(u);
    const a = fin2("assistant", asstText);
    if (a) results.push(a);
    return results;
  } catch { return []; }
}

describe("3 · Fetch interceptor parsers (inline mirrors)", () => {
  describe("detectPlatform", () => {
    const cases: [string, string | null][] = [
      ["https://chatgpt.com/backend-api/conversation",          "chatgpt"],
      ["https://chat.openai.com/backend-api/conversation",      "chatgpt"],
      ["https://claude.ai/api/completion",                      "claude"],
      ["https://a-api.anthropic.com/v1/messages",               "claude"],
      ["https://api.anthropic.com/v1/messages",                 "claude"],
      ["https://gemini.google.com/GenerateContent",             "gemini"],
      ["https://grok.com/api/chat",                             "grok"],
      ["https://chat.deepseek.com/api/chat/completions",        "deepseek"],
      ["https://www.perplexity.ai/api/search",                  "perplexity"],
      ["https://example.com/random",                            null],
      ["",                                                       null],
    ];
    for (const [url, expected] of cases) {
      it(`"${url.slice(0, 50)}" → ${expected}`, () =>
        expect(detectPlatform(url)).toBe(expected));
    }
  });

  describe("extractOpenAIUserPrompt", () => {
    it("returns null for null input", () =>
      expect(extractOpenAIUserPrompt(null)).toBeNull());

    it("extracts last user message from messages array", () => {
      const body = JSON.stringify({
        messages: [
          { role: "user",      content: "First question" },
          { role: "assistant", content: "First answer" },
          { role: "user",      content: "Second question" },
        ],
      });
      const r = extractOpenAIUserPrompt(body);
      expect(r?.content).toBe("Second question");
      expect(r?.role).toBe("user");
    });

    it("extracts text from content array (multimodal format)", () => {
      const body = JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello from array" }] }],
      });
      expect(extractOpenAIUserPrompt(body)?.content).toBe("Hello from array");
    });

    it("falls back to top-level message field (Grok format)", () => {
      const body = JSON.stringify({ message: "Grok user query" });
      expect(extractOpenAIUserPrompt(body)?.content).toBe("Grok user query");
    });

    it("falls back to query field (Perplexity REST format)", () => {
      const body = JSON.stringify({ query: "Perplexity question" });
      expect(extractOpenAIUserPrompt(body)?.content).toBe("Perplexity question");
    });

    it("returns null for non-JSON", () =>
      expect(extractOpenAIUserPrompt("not-json")).toBeNull());
  });

  describe("parseClaude (Anthropic SSE)", () => {
    const SSE = [
      `event: message_start`,
      `data: {"type":"message_start","message":{"role":"assistant"}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","delta":{"text":"Hello "}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","delta":{"text":"world!"}}`,
    ].join("\n");

    it("accumulates delta text into assistant message", () => {
      const msgs = parseClaude(SSE);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe("assistant");
      expect(msgs[0].content).toBe("Hello world!");
    });

    it("prepends user message from request body", () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "My question" }] });
      const msgs = parseClaude(SSE, body);
      expect(msgs[0].role).toBe("user");
      expect(msgs[0].content).toBe("My question");
      expect(msgs[1].role).toBe("assistant");
    });

    it("returns empty array for empty SSE", () =>
      expect(parseClaude("")).toHaveLength(0));

    it("handles legacy completion field", () => {
      const legacy = `data: {"completion":"Legacy response"}`;
      const msgs = parseClaude(legacy);
      expect(msgs[0].content).toBe("Legacy response");
    });
  });

  describe("parseChatGPT (OpenAI SSE delta)", () => {
    const SSE = [
      `data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}`,
      `data: {"choices":[{"delta":{"content":"ChatGPT!"},"finish_reason":null}]}`,
      `data: [DONE]`,
    ].join("\n");

    it("accumulates delta content", () => {
      const msgs = parseChatGPT(SSE);
      expect(msgs[0].content).toBe("Hello ChatGPT!");
      expect(msgs[0].role).toBe("assistant");
    });

    it("returns empty for DONE-only stream", () =>
      expect(parseChatGPT("data: [DONE]")).toHaveLength(0));
  });

  describe("parsePerplexitySocketIO (WebSocket mirror)", () => {
    it("ignores non-42 packets", () =>
      expect(parsePerplexityWS("40")).toHaveLength(0));

    it("ignores in-progress events (status=generating)", () => {
      const pkt = `42["query_progress",{"status":"generating","text":"partial","query_str":"q"}]`;
      expect(parsePerplexityWS(pkt)).toHaveLength(0);
    });

    it("emits user+assistant on status=completed", () => {
      const pkt = `42["query_progress",{"status":"completed","text":"Full answer","query_str":"User question"}]`;
      const msgs = parsePerplexityWS(pkt);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]).toMatchObject({ role: "user",      content: "User question" });
      expect(msgs[1]).toMatchObject({ role: "assistant", content: "Full answer" });
    });

    it("handles namespace prefix (42/ns,[...])", () => {
      const pkt = `42/chat,["query_progress",{"status":"completed","text":"Answer","query_str":"Q"}]`;
      const msgs = parsePerplexityWS(pkt);
      expect(msgs.some((m) => m.role === "assistant")).toBe(true);
    });

    it("returns empty for malformed JSON", () =>
      expect(parsePerplexityWS("42[broken}")).toHaveLength(0));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. END-TO-END PIPELINE  (summarize → buildMigrationPrompt)
// ─────────────────────────────────────────────────────────────────────────────

describe("4 · End-to-end pipeline", () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: summarize → prompt contains code and tail`, async () => {
      const result = await summarize(CODE);
      const prompt = buildMigrationPrompt({
        summary:       result.content,
        extracted:     result.extracted,
        targetPlatform: platform,
        sourceSession: { ...BASE_SESSION, messages: CODE, platform: "claude" },
      });
      expect(prompt).toContain("add");
      expect(prompt.length).toBeGreaterThan(200);
    });
  }

  it("caveman=true: shorter decisions in body + caveman instruction in prompt", async () => {
    const result   = await summarize(CAVEMAN_LONG, { caveman: true });
    const prompt   = buildMigrationPrompt({
      summary:       result.content,
      extracted:     result.extracted,
      targetPlatform: "chatgpt",
      sourceSession: { ...BASE_SESSION, messages: CAVEMAN_LONG },
      caveman:       true,
    });
    expect(prompt).toContain(CAVEMAN_MD);
  });

  it("empty session: produces short but valid prompt", async () => {
    const result = await summarize([]);
    const prompt = buildMigrationPrompt({
      summary:       result.content,
      extracted:     result.extracted,
      targetPlatform: "claude",
      sourceSession: { ...BASE_SESSION, messages: [] },
    });
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. FUTURE FEATURE STUBS
// Add new describe blocks here as features are introduced.
// ─────────────────────────────────────────────────────────────────────────────

describe("5 · Future features (stubs — add tests as features ship)", () => {
  it.todo("WebSocket interceptor — Perplexity live capture in browser");
  it.todo("Gemini user message extraction from batchexecute request body");
  it.todo("Session deduplication — same content captured twice should merge");
  it.todo("Supabase sync — session upsert idempotency");
  it.todo("IDE bridge — context injection round-trip");
  it.todo("Popup caveman toggle — persisted across extension restarts");
});
