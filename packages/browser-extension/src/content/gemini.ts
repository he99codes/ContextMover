// packages/browser-extension/src/content/gemini.ts
import { extractMessageContent, injectWithRetry, runCapturePipeline, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "@/lib/types";

const GEMINI_SELECTORS = {
  user: [
    'user-query .query-text',
    'user-query',
    '[class*="userQuery"]',
    '[data-role="user"]',
    '.query-content',
    '[class*="UserMessage"]',
  ],
  assistant: [
    'model-response .response-content',
    'model-response',
    '[class*="modelResponse"]',
    '[data-role="model"]',
    '[class*="AssistantMessage"]',
    '.response-content',
    '[class*="response-text"]',
  ],
  streaming: [
    '[aria-busy="true"]',
    '.loading-indicator',
    '[class*="generating"]',
    '[class*="streaming"]',
  ],
};

function isStreaming(el: HTMLElement): boolean {
  return (
    el.classList.contains("result-streaming") ||
    el.querySelector(".result-streaming") !== null ||
    el.closest("[data-is-streaming]") !== null ||
    el.closest(".loading") !== null ||
    GEMINI_SELECTORS.streaming.some((sel) => {
      try { return el.matches(sel) || el.querySelector(sel) !== null; } catch { return false; }
    })
  );
}

function findElements(selectors: string[]): Element[] {
  for (const selector of selectors) {
    try {
      const els = document.querySelectorAll(selector);
      if (els.length > 0) {
        console.log(`[CM:gemini] matched: ${selector} (${els.length})`);
        return Array.from(els);
      }
    } catch { /* invalid selector, continue */ }
  }
  return [];
}

// ── DIAGNOSTIC STAGE 1 ────────────────────────────────────────────────────────
function scrapeMessages(): Message[] {
  const messages: Message[] = [];

  // Strategy 1: Custom elements (user-query / model-response)
  document.querySelectorAll<HTMLElement>("user-query").forEach((container) => {
    if (isStreaming(container)) return;
    const el = container.querySelector<HTMLElement>(".query-text");
    if (!el) return;
    const content = extractMessageContent(el);
    if (content) messages.push({ role: "user", content, timestamp: Date.now() });
  });
  document.querySelectorAll<HTMLElement>("model-response").forEach((container) => {
    if (isStreaming(container)) return;
    const el = container.querySelector<HTMLElement>(".response-content");
    if (!el) return;
    const content = extractMessageContent(el);
    if (content) messages.push({ role: "assistant", content, timestamp: Date.now() });
  });

  // Strategy 2: Selector cascade fallback for user
  const userCountS1 = messages.filter(m => m.role === "user").length;
  if (userCountS1 === 0) {
    const userEls = findElements(GEMINI_SELECTORS.user);
    for (const el of userEls) {
      if (isStreaming(el as HTMLElement)) continue;
      const content = extractMessageContent(el as HTMLElement);
      if (content) messages.push({ role: "user", content, timestamp: Date.now() });
    }
  }

  // Strategy 3: Selector cascade fallback for assistant
  const asstCountS1 = messages.filter(m => m.role === "assistant").length;
  if (asstCountS1 === 0) {
    const asstEls = findElements(GEMINI_SELECTORS.assistant);
    for (const el of asstEls) {
      if (isStreaming(el as HTMLElement)) continue;
      const content = extractMessageContent(el as HTMLElement);
      if (content) messages.push({ role: "assistant", content, timestamp: Date.now() });
    }
  }

  const userCount = messages.filter(m => m.role === "user").length;
  const asstCount = messages.filter(m => m.role === "assistant").length;
  console.log('[CM:capture]', 'gemini', {
    total: messages.length,
    user: userCount,
    assistant: asstCount,
    preview: messages.map(m => ({ role: m.role, len: m.content.length }))
  });
  if (asstCount === 0 && userCount > 0) {
    console.error(`[ContextMover:gemini] ASSISTANT MESSAGES MISSING — trying structural fallback`);
    const structural = detectByStructure();
    if (structural.length > 0 && structural.some(m => m.role === "assistant")) {
      console.log(`[CM:gemini] structural fallback recovered ${structural.length} messages`);
      return structural;
    }
  }

  return messages;
}

// ── Structural detection fallback ───────────────────────────────────────────
function detectByStructure(): Message[] {
  const container = findChatContainer();
  if (!container) return [];

  const children = Array.from(container.children).filter(
    (el) => (el.textContent?.trim().length ?? 0) > 10
  );

  const messages: Message[] = [];
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as HTMLElement;
    if (isStreaming(el)) continue;
    const content = extractMessageContent(el);
    if (!content) continue;
    // Even indices = user, odd = assistant (typical chat layout)
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content,
      timestamp: Date.now(),
    });
  }

  return messages;
}

function findChatContainer(): Element | null {
  const selectors = [
    'chat-window',
    'main',
    '[role="main"]',
    '.conversation',
    '[class*="conversation"]',
    '[class*="messages"]',
    '[class*="chat"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.children.length > 2) return el;
  }
  return null;
}

startSessionCapture({
  platform: "gemini",
  selectorOrElement: "chat-window, main",
  scrapeMessages: () => runCapturePipeline("gemini", scrapeMessages),
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "gemini") {
    injectIntoGeminiInput(msg.prompt)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // CRITICAL — keeps channel open for async response
  }
});

async function injectIntoGeminiInput(text: string) {
  const input = await waitForAnyElement<HTMLElement>([
    "rich-textarea [contenteditable='true']",     // Gemini Angular component
    "rich-textarea p",                            // inner paragraph element
    "[contenteditable='true'][role='textbox']",
    "[contenteditable='true'][aria-label]",       // labelled contenteditable
    "textarea:not([readonly])",
    "[contenteditable='true']",                   // last-resort
  ]);

  if (!input) return { ok: false, error: "Gemini input box not found. Make sure a chat is open." };

  if (!await injectWithRetry(input, text, "gemini")) {
    return { ok: false, error: "Gemini input did not accept the text after 3 attempts. Context copied to clipboard — paste with Ctrl+V." };
  }

  return { ok: true };
}
