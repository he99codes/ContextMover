// packages/browser-extension/src/content/gemini.ts
import { detectRoleFromElement, extractContent, extractMessageContent, findChatContainerFor, injectWithRetry, runCapturePipeline, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "./shared";

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
  const found: Array<{ el: Element; role: 'user' | 'assistant' }> = []

  document.querySelectorAll('user-query, .user-query, [class*="user-query"]')
    .forEach(el => found.push({ el, role: 'user' }))
  document.querySelectorAll('model-response, .model-response, [class*="model-response"]')
    .forEach(el => found.push({ el, role: 'assistant' }))

  found.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )

  return found.map(({ el, role }) => ({
    role,
    content: extractContent(el),
    timestamp: Date.now()
  })).filter(m => m.content.trim().length > 0)
}

// ── Structural detection fallback ───────────────────────────────────────────
// When all selectors fail, use semantic role detection rather than index parity.
function detectByStructure(): Message[] {
  const container = findChatContainerFor('gemini');
  if (!container) return [];

  const messages: Message[] = [];
  for (const child of Array.from(container.children)) {
    const el = child as HTMLElement;

    const content = extractContent(el);
    if (!content || content.trim().length < 5) continue;

    const role = detectRoleFromElement(el, 'gemini');
    if (!role) continue;

    messages.push({ role, content, timestamp: Date.now() });
  }

  return messages;
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
