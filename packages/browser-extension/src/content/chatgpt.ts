// packages/browser-extension/src/content/chatgpt.ts
import { extractMessageContent, injectWithRetry, runCapturePipeline, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "@/lib/types";

// ── DIAGNOSTIC STAGE 1 ────────────────────────────────────────────────────────
function scrapeMessages(): Message[] {
  const messages: Message[] = [];

  document.querySelectorAll<HTMLElement>("[data-message-author-role]").forEach((el) => {
    // Outermost only — use el.closest on the parent to handle all nesting depths
    if (el.parentElement?.closest("[data-message-author-role]")) return;

    // Skip messages still being streamed
    if (
      el.classList.contains("result-streaming") ||
      el.querySelector(".result-streaming") ||
      el.closest("[data-is-streaming]")
    ) return;

    const role = el.dataset.messageAuthorRole as "user" | "assistant";
    if (role !== "user" && role !== "assistant") {
      console.warn(`[ContextForge:chatgpt] Stage1 — unexpected role="${role}", skipping`);
      return;
    }
    const content = extractMessageContent(el);
    if (content) {
      messages.push({ role, content, timestamp: Date.now() });
    } else {
      console.warn(`[ContextForge:chatgpt] Stage1 — empty content for role=${role}`);
    }
  });

  const userCount = messages.filter(m => m.role === "user").length;
  const asstCount = messages.filter(m => m.role === "assistant").length;
  console.log('[CF:capture]', 'chatgpt', {
    total: messages.length,
    user: userCount,
    assistant: asstCount,
    preview: messages.map(m => ({ role: m.role, len: m.content.length }))
  });
  if (asstCount === 0 && userCount > 0) {
    console.error(`[ContextForge:chatgpt] ASSISTANT MESSAGES MISSING`);
  }

  return messages;
}

startSessionCapture({
  platform: "chatgpt",
  selectorOrElement: "main",
  scrapeMessages: () => runCapturePipeline("chatgpt", scrapeMessages),
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "chatgpt") {
    injectIntoChatGPTInput(msg.prompt)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // CRITICAL — keeps channel open for async response
  }
});

async function injectIntoChatGPTInput(text: string) {
  const input = await waitForAnyElement<HTMLElement>([
    "#prompt-textarea",                          // ChatGPT primary contenteditable
    "[data-testid='text-input']",                // alternate testid
    "[contenteditable='true'][role='textbox']",
    "form [contenteditable='true']",
    "textarea:not([readonly])",                  // broad textarea fallback
    "[contenteditable='true']",                  // last-resort contenteditable
  ]);

  if (!input) return { ok: false, error: "ChatGPT input box not found. Make sure a chat is open." };

  if (!await injectWithRetry(input, text, "chatgpt")) {
    return { ok: false, error: "ChatGPT input did not accept the text after 3 attempts. Context copied to clipboard — paste with Ctrl+V." };
  }

  return { ok: true };
}
