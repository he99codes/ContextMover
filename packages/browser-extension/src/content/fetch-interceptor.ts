// packages/browser-extension/src/content/fetch-interceptor.ts
//
// MAIN-world content script. Runs in the page's JavaScript context so it can
// override window.fetch.  Captures AI conversation API responses, parses the
// platform-specific stream/JSON formats into a normalized Message[], and
// dispatches a CustomEvent that the ISOLATED-world bridge picks up.
//
// HARD RULES:
//   • Never throw out of the override — must never break the page.
//   • Never mutate or block the original response object.
//   • No ES-module imports — this file is bundled as a self-contained IIFE
//     (CRXJS bundles it with `world: "MAIN"`).
//   • All parsers wrapped in try/catch and return [] on any failure.

(() => {
  type Role = "user" | "assistant";
  type CapturedMessage = {
    role: Role;
    content: string;
    timestamp: number;
    codeBlocks?: { language: string; code: string }[];
  };
  type Platform = "chatgpt" | "claude" | "gemini" | "grok";

  const TAG = "[ContextForge:fetch]";

  // Idempotency guard — avoid double-installing if the script is injected twice.
  const w = window as unknown as { __contextForgeFetchInstalled?: boolean };
  if (w.__contextForgeFetchInstalled) {
    console.log(`${TAG} already installed, skipping`);
    return;
  }
  w.__contextForgeFetchInstalled = true;

  // Save the genuine fetch BEFORE override so we always have a fallback even
  // if some other script later replaces window.fetch.
  const _originalFetch = window.fetch.bind(window);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function urlOf(input: RequestInfo | URL): string {
    try {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.toString();
      if (input instanceof Request) return input.url;
    } catch { /* fall through */ }
    return "";
  }

  function detectPlatform(url: string): Platform | null {
    if (!url) return null;
    if (url.includes("chatgpt.com/backend-api/conversation") ||
        url.includes("chat.openai.com/backend-api/conversation")) return "chatgpt";
    if (url.includes("claude.ai/api") && /completion|append_message|chat_conversations/.test(url)) return "claude";
    if (url.includes("gemini.google.com") && /GenerateContent|StreamGenerate|BardChatUi|assistant\.lamda/i.test(url)) return "gemini";
    if (url.includes("grok.com/api") && /chat|conversation|completion/i.test(url)) return "grok";
    return null;
  }

  function isAIApiCall(url: string): boolean {
    return detectPlatform(url) !== null;
  }

  function extractCodeBlocks(content: string): { language: string; code: string }[] {
    const blocks: { language: string; code: string }[] = [];
    if (!content) return blocks;
    const re = /```([\w+\-./]*)\n?([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const language = (m[1] ?? "").trim();
      const code = (m[2] ?? "").replace(/\n+$/, "");
      if (code) blocks.push({ language, code });
    }
    return blocks;
  }

  function finalize(role: Role, content: string, ts?: number): CapturedMessage | null {
    const trimmed = (content ?? "").trim();
    if (!trimmed) return null;
    const codeBlocks = extractCodeBlocks(trimmed);
    return {
      role,
      content: trimmed,
      timestamp: ts ?? Date.now(),
      ...(codeBlocks.length > 0 ? { codeBlocks } : {}),
    };
  }

  function dispatchCaptured(platform: Platform, messages: CapturedMessage[]): void {
    if (!messages.length) return;
    try {
      window.dispatchEvent(
        new CustomEvent("contextforge:captured", {
          detail: { platform, messages },
        })
      );
    } catch (err) {
      console.warn(`${TAG} dispatch failed`, err);
    }
  }

  // ── Stream parsers ─────────────────────────────────────────────────────────
  // Each parser receives the FULL response body text (already concatenated) and
  // returns a normalized Message[]. They MUST never throw — wrap everything.

  function parseChatGPT(text: string): CapturedMessage[] {
    try {
      // ChatGPT response is SSE with `data: {json}` lines per token.  Each line
      // contains a `message` object whose `author.role` is the speaker and
      // `content.parts[]` accumulates the text.  We collapse all chunks for the
      // same message id into a single string.
      const byMsgId = new Map<string, { role: Role; content: string; ts: number }>();
      const lines = text.split(/\r?\n/);

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let j: unknown;
        try { j = JSON.parse(payload); } catch { continue; }
        if (!j || typeof j !== "object") continue;
        const obj = j as Record<string, unknown>;

        // Modern ChatGPT format: { message: { id, author: { role }, content: { parts: [...] } } }
        const msg = (obj.message ?? obj.v ?? null) as Record<string, unknown> | null;
        if (msg && typeof msg === "object") {
          const id = String((msg.id as string) ?? "_");
          const author = (msg.author as Record<string, unknown> | undefined) ?? {};
          const role = String((author.role as string) ?? "");
          if (role !== "user" && role !== "assistant") continue;
          const c = (msg.content as Record<string, unknown> | undefined) ?? {};
          let chunk = "";
          if (Array.isArray(c.parts)) {
            chunk = (c.parts as unknown[])
              .map((p) => (typeof p === "string" ? p : ""))
              .join("");
          } else if (typeof c.text === "string") {
            chunk = c.text;
          }
          const cur = byMsgId.get(id) ?? { role: role as Role, content: "", ts: Date.now() };
          // Streaming chunks REPLACE the parts array (full content each delta)
          // so we take the latest, longest version.
          if (chunk.length >= cur.content.length) cur.content = chunk;
          cur.role = role as Role;
          byMsgId.set(id, cur);
        }

        // Legacy/openai-spec fallback: { choices: [{ delta: {role, content} }] }
        if (Array.isArray(obj.choices)) {
          const ch = obj.choices[0] as Record<string, unknown> | undefined;
          const delta = (ch?.delta as Record<string, unknown> | undefined) ?? {};
          const role = String((delta.role as string) ?? "assistant") as Role;
          const piece = String((delta.content as string) ?? "");
          if (piece) {
            const id = String((obj.id as string) ?? "legacy");
            const cur = byMsgId.get(id) ?? { role, content: "", ts: Date.now() };
            cur.content += piece;
            byMsgId.set(id, cur);
          }
        }
      }

      const out: CapturedMessage[] = [];
      byMsgId.forEach((v) => {
        const fin = finalize(v.role, v.content, v.ts);
        if (fin) out.push(fin);
      });
      return out;
    } catch (err) {
      console.warn(`${TAG} parseChatGPT failed`, err);
      return [];
    }
  }

  function parseClaude(text: string): CapturedMessage[] {
    try {
      // Anthropic SSE: events alternate `event: name\ndata: {json}`. We track
      // a single in-flight assistant message (Claude streams one reply at a
      // time per request).  The matching user prompt is included in the request
      // body, not the response, so this parser only emits assistant turns.
      const lines = text.split(/\r?\n/);
      let curEvent = "";
      let acc = "";
      let role: Role = "assistant";

      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith("event:")) {
          curEvent = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let j: unknown;
        try { j = JSON.parse(payload); } catch { continue; }
        if (!j || typeof j !== "object") continue;
        const obj = j as Record<string, unknown>;

        // message_start → grab role
        if (curEvent === "message_start" || obj.type === "message_start") {
          const m = obj.message as Record<string, unknown> | undefined;
          const r = String((m?.role as string) ?? "assistant");
          if (r === "user" || r === "assistant") role = r;
          continue;
        }

        // content_block_delta → accumulate text
        if (curEvent === "content_block_delta" || obj.type === "content_block_delta") {
          const delta = obj.delta as Record<string, unknown> | undefined;
          const t = String((delta?.text as string) ?? "");
          acc += t;
          continue;
        }

        // Newer Claude format: { completion: "..." } per chunk
        if (typeof obj.completion === "string") {
          acc += obj.completion;
        }
      }

      const fin = finalize(role, acc);
      return fin ? [fin] : [];
    } catch (err) {
      console.warn(`${TAG} parseClaude failed`, err);
      return [];
    }
  }

  function parseGemini(text: string): CapturedMessage[] {
    try {
      // Gemini's frontend uses Google's "batchexecute" RPC which returns a
      // pseudo-JSON envelope: `)]}'` prefix, then array-of-arrays per call.
      // The actual model output is buried in nested arrays. We use a tolerant
      // approach: try strict JSON first; otherwise scan for likely text bodies.
      const cleaned = text.replace(/^\)\]\}'\s*/, "").trim();
      const messages: CapturedMessage[] = [];

      // Try strict JSON
      try {
        const j = JSON.parse(cleaned);
        const harvested = harvestGeminiText(j);
        if (harvested) {
          const fin = finalize("assistant", harvested);
          if (fin) messages.push(fin);
          return messages;
        }
      } catch { /* fall through to streaming fallback */ }

      // Streaming JSON-array format (newline-separated chunks)
      const chunks = cleaned.split(/\n\d+\n/).filter(Boolean);
      let acc = "";
      for (const chunk of chunks) {
        try {
          const j = JSON.parse(chunk);
          const t = harvestGeminiText(j);
          if (t) acc += t;
        } catch { /* skip malformed chunk */ }
      }
      const fin = finalize("assistant", acc);
      if (fin) messages.push(fin);
      return messages;
    } catch (err) {
      console.warn(`${TAG} parseGemini failed`, err);
      return [];
    }
  }

  // Recursively walk Gemini's nested array response and collect any string
  // that looks like model output (>= 10 chars, contains a space).
  function harvestGeminiText(node: unknown, depth = 0): string {
    if (depth > 12 || node == null) return "";
    if (typeof node === "string") {
      // Filter obvious non-content (IDs, timestamps, base64).
      if (node.length < 10) return "";
      if (/^[a-zA-Z0-9_-]+$/.test(node)) return "";
      if (/^[\d.eE+-]+$/.test(node)) return "";
      return node.includes(" ") ? node : "";
    }
    if (Array.isArray(node)) {
      let best = "";
      for (const child of node) {
        const t = harvestGeminiText(child, depth + 1);
        if (t.length > best.length) best = t;
      }
      return best;
    }
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      // Fast-path: candidates[].content.parts[].text
      const candidates = obj.candidates as unknown[] | undefined;
      if (Array.isArray(candidates) && candidates.length > 0) {
        const first = candidates[0] as Record<string, unknown> | undefined;
        const content = first?.content as Record<string, unknown> | undefined;
        const parts = content?.parts as unknown[] | undefined;
        if (Array.isArray(parts)) {
          const joined = parts
            .map((p) => (p && typeof p === "object" ? String((p as Record<string, unknown>).text ?? "") : ""))
            .join("");
          if (joined.trim()) return joined;
        }
      }
      let best = "";
      for (const v of Object.values(obj)) {
        const t = harvestGeminiText(v, depth + 1);
        if (t.length > best.length) best = t;
      }
      return best;
    }
    return "";
  }

  function parseGrok(text: string): CapturedMessage[] {
    try {
      // Grok responses are SSE-style newline-delimited JSON with a `token`
      // (or `content` / `result.response`) field per chunk.
      const lines = text.split(/\r?\n/);
      let acc = "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
        if (!payload || payload === "[DONE]") continue;

        let j: unknown;
        try { j = JSON.parse(payload); } catch { continue; }
        if (!j || typeof j !== "object") continue;
        const obj = j as Record<string, unknown>;

        const result = (obj.result as Record<string, unknown> | undefined) ?? {};
        const response = (result.response as Record<string, unknown> | undefined) ?? {};

        const piece =
          (typeof obj.token === "string" && obj.token) ||
          (typeof obj.content === "string" && obj.content) ||
          (typeof response.token === "string" && response.token) ||
          (typeof response.message === "string" && response.message) ||
          (typeof result.token === "string" && result.token) ||
          "";
        if (piece) acc += piece;
      }
      const fin = finalize("assistant", acc);
      return fin ? [fin] : [];
    } catch (err) {
      console.warn(`${TAG} parseGrok failed`, err);
      return [];
    }
  }

  // ── Response handler ───────────────────────────────────────────────────────
  async function handleAIResponse(platform: Platform, response: Response): Promise<void> {
    try {
      // .text() consumes the body — only safe on a clone (caller guarantees).
      const text = await response.text();
      if (!text) return;

      let messages: CapturedMessage[] = [];
      switch (platform) {
        case "chatgpt": messages = parseChatGPT(text); break;
        case "claude":  messages = parseClaude(text);  break;
        case "gemini":  messages = parseGemini(text);  break;
        case "grok":    messages = parseGrok(text);    break;
      }

      if (messages.length === 0) {
        console.log(`${TAG} ${platform}: no messages parsed (body length=${text.length})`);
        return;
      }

      // Filter empty / no-role
      messages = messages.filter((m) => m.role && m.content && m.content.length > 0);
      if (messages.length === 0) return;

      console.log(`${TAG} ${platform}: parsed ${messages.length} msg(s)`);
      dispatchCaptured(platform, messages);
    } catch (err) {
      console.warn(`${TAG} handleAIResponse failed`, err);
    }
  }

  // ── Override window.fetch ──────────────────────────────────────────────────
  try {
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
      const response = await _originalFetch(input as RequestInfo, init);
      try {
        const url = urlOf(input);
        const platform = detectPlatform(url);
        if (platform) {
          // Clone NOW so the caller still gets an unread body. Parsing happens
          // fully async — we never await it from inside the override.
          const clone = response.clone();
          // Use queueMicrotask so we never extend the original fetch's promise
          // chain (defensive — also avoids any chance of throwing into the call site).
          queueMicrotask(() => { void handleAIResponse(platform, clone); });
        }
      } catch (err) {
        console.warn(`${TAG} intercept side-effect failed (response unaffected)`, err);
      }
      return response;
    } as typeof window.fetch;
    console.log(`${TAG} window.fetch override installed`);
  } catch (err) {
    // If override itself failed, restore the original and bail.
    console.error(`${TAG} CRITICAL: failed to install fetch override; restoring original`, err);
    try { window.fetch = _originalFetch as typeof window.fetch; } catch { /* nothing more we can do */ }
  }
})();
