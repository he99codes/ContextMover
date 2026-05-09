// packages/browser-extension/src/content/gemini.ts
import { extractMessageContent, injectWithRetry, runCapturePipeline, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "@/lib/types";

function isStreaming(el: HTMLElement): boolean {
  return (
    el.classList.contains("result-streaming") ||
    el.querySelector(".result-streaming") !== null ||
    el.closest("[data-is-streaming]") !== null ||
    el.closest(".loading") !== null
  );
}

// ── DIAGNOSTIC STAGE 1 ────────────────────────────────────────────────────────
function scrapeMessages(): Message[] {
  const messages: Message[] = [];

  // User queries — outermost only to avoid double-counting nested .query-text
  document.querySelectorAll<HTMLElement>("user-query").forEach((container) => {
    if (isStreaming(container)) return;
    const el = container.querySelector<HTMLElement>(".query-text");
    if (!el) return;
    const content = extractMessageContent(el);
    if (content) messages.push({ role: "user", content, timestamp: Date.now() });
  });

  // Model responses — outermost only to avoid double-counting nested .response-content
  document.querySelectorAll<HTMLElement>("model-response").forEach((container) => {
    if (isStreaming(container)) return;
    const el = container.querySelector<HTMLElement>(".response-content");
    if (!el) return;
    const content = extractMessageContent(el);
    if (content) messages.push({ role: "assistant", content, timestamp: Date.now() });
  });

  const userCount = messages.filter(m => m.role === "user").length;
  const asstCount = messages.filter(m => m.role === "assistant").length;
  console.log('[CF:capture]', 'gemini', {
    total: messages.length,
    user: userCount,
    assistant: asstCount,
    preview: messages.map(m => ({ role: m.role, len: m.content.length }))
  });
  if (asstCount === 0 && userCount > 0) {
    console.error(`[ContextForge:gemini] ASSISTANT MESSAGES MISSING`);
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
    void injectIntoGeminiInput(msg.prompt).then(sendResponse);
    return true;
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
