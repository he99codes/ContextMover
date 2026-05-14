// packages/browser-extension/src/content/chatgpt.ts
import { detectRoleFromElement, extractContent, extractMessageContent, findChatContainerFor, injectWithRetry, runCapturePipeline, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "./shared";

// ── DIAGNOSTIC STAGE 1 ────────────────────────────────────────────────────────
function scrapeMessages(): Message[] {
  const found: Array<{ el: Element; role: 'user' | 'assistant' }> = []

  document.querySelectorAll('[data-message-author-role]').forEach(el => {
    const role = el.getAttribute('data-message-author-role')
    if (role !== 'user' && role !== 'assistant') return
    if (el.getAttribute('data-is-streaming') === 'true') return
    found.push({ el, role })
  })

  found.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )

  return found.map(({ el, role }) => ({
    role,
    content: extractContent(
      el.querySelector('.markdown, .whitespace-pre-wrap') ?? el
    ),
    timestamp: Date.now()
  })).filter(m => m.content.trim().length > 0)
}

// ── Structural detection fallback ───────────────────────────────────────────
function detectByStructure(): Message[] {
  const container = findChatContainerFor('chatgpt');
  if (!container) return [];

  const messages: Message[] = [];
  for (const child of Array.from(container.querySelectorAll(
    '[data-message-author-role], article, [class*="group"]'
  ))) {
    const el = child as HTMLElement;
    if (el.getAttribute('data-is-streaming') === 'true') continue;

    const content = extractContent(
      el.querySelector('.markdown, .whitespace-pre-wrap') ?? el
    );
    if (!content || content.trim().length < 5) continue;

    const role = detectRoleFromElement(el, 'chatgpt');
    if (!role) continue;

    messages.push({ role, content, timestamp: Date.now() });
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
