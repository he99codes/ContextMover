// packages/browser-extension/src/content/grok.ts
import { extractContent, extractMessageContent, injectWithRetry, runCapturePipeline, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "./shared";

console.log("[ContextMover] Grok content script loaded");

function isStreaming(el: HTMLElement): boolean {
  return (
    el.classList.contains("result-streaming") ||
    el.querySelector(".result-streaming") !== null ||
    el.closest("[data-is-streaming]") !== null ||
    el.closest("[class*='streaming']") !== null
  );
}

function scrapeMessages(): Message[] {
  const found: Array<{ el: Element; role: 'user' | 'assistant' }> = []

  document.querySelectorAll('*').forEach(el => {
    const cls = (el.getAttribute('class') ?? '').toLowerCase()
    if (cls.includes('usermessage') || cls.includes('user-message'))
      found.push({ el, role: 'user' })
    else if (cls.includes('assistantmessage') || cls.includes('assistant-message'))
      found.push({ el, role: 'assistant' })
  })

  found.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )

  return found.map(({ el, role }) => ({
    role,
    content: extractContent(el),
    timestamp: Date.now()
  })).filter(m => m.content.trim().length > 0)
}

startSessionCapture({
  platform: "grok",
  selectorOrElement: "main",
  scrapeMessages: () => runCapturePipeline("grok", scrapeMessages),
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "grok") {
    injectIntoGrokInput(msg.prompt)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // CRITICAL — keeps channel open for async response
  }
});

const GROK_INJECT_SELECTORS = [
  // Current Grok composer (confirmed 2026-04) — [data-testid="chat-input"]
  // is a WRAPPER div; the real editor is a nested contenteditable ProseMirror.
  // We MUST target the inner contenteditable, not the wrapper.
  '[data-testid="chat-input"] [contenteditable="true"]',
  '[data-testid="chat-input"] .ProseMirror',
  '[data-testid="composer-text-input"] [contenteditable="true"]',
  '[data-testid="composer-text-input"]',       // legacy
  'textarea[placeholder*="Ask"]',              // Grok "Ask anything" placeholder
  'textarea[placeholder*="message"]',
  '[contenteditable="true"][role="textbox"]',
  '.ProseMirror[contenteditable="true"]',      // TipTap / ProseMirror editor
  '[class*="composer"] textarea',
  '[class*="input"] textarea',
  'form textarea',
  'textarea:not([readonly])',                  // broad textarea fallback
  '[contenteditable="true"]',                  // last-resort contenteditable
];

async function injectIntoGrokInput(text: string) {
  // Try each selector individually so we can log which one matched — this is
  // critical when Grok's DOM changes and we need to see which strategy worked.
  let input: HTMLElement | null = null;
  let matchedSelector = "";
  for (const sel of GROK_INJECT_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) {
      input = el;
      matchedSelector = sel;
      break;
    }
  }

  // If nothing yet, give the page up to 4s to render the composer (SPA route).
  if (!input) {
    input = await waitForAnyElement<HTMLElement>(GROK_INJECT_SELECTORS);
    matchedSelector = input
      ? GROK_INJECT_SELECTORS.find(s => document.querySelector(s) === input) ?? "(late)"
      : "";
  }

  if (!input) {
    console.warn("[ContextMover:grok] injection failed — no composer element matched any selector");
    return {
      ok: false,
      error: "Grok input box not found. Make sure a Grok chat tab is open and the page has finished loading.",
    };
  }

  console.log(`[ContextMover:grok] injecting via selector: ${matchedSelector}, tag=${input.tagName}, contentEditable=${input.isContentEditable}`);

  if (!await injectWithRetry(input, text, "grok")) {
    return {
      ok: false,
      error: `Grok input (${input.tagName.toLowerCase()}) did not accept the text after 3 attempts. Context copied to clipboard — paste with Ctrl+V.`,
    };
  }

  console.log("[ContextMover:grok] injection succeeded");
  return { ok: true };
}
