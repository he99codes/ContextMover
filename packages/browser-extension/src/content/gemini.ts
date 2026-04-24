// packages/browser-extension/src/content/gemini.ts
import { extractMessageContent, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "@/lib/types";

// ── DIAGNOSTIC STAGE 1 ────────────────────────────────────────────────────────
function scrapeMessages(): Message[] {
  const messages: Message[] = [];

  document.querySelectorAll<HTMLElement>(
    "user-query .query-text, model-response .response-content"
  ).forEach((el) => {
    const role = el.closest("user-query") ? "user" : "assistant";
    const content = extractMessageContent(el);
    if (content) {
      messages.push({ role, content, timestamp: Date.now() });
    } else {
      console.warn(`[ContextForge:gemini] Stage1 — empty content for role=${role}`);
    }
  });

  const userCount = messages.filter(m => m.role === "user").length;
  const asstCount = messages.filter(m => m.role === "assistant").length;
  console.log(`[ContextForge:gemini] FINAL: ${messages.length} msgs (user=${userCount} asst=${asstCount})`);
  console.log(`[ContextForge:gemini] preview:`, messages.map(m => ({ role: m.role, preview: m.content.slice(0, 60) })));
  if (asstCount === 0 && userCount > 0) {
    console.error(`[ContextForge:gemini] ASSISTANT MESSAGES MISSING`);
  }

  return messages;
}

startSessionCapture({
  platform: "gemini",
  selectorOrElement: "chat-window, main",
  scrapeMessages,
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

  if (!setPromptInputValue(input, text)) {
    return { ok: false, error: "Gemini input did not accept the text. Try reloading the tab." };
  }

  return { ok: true };
}
