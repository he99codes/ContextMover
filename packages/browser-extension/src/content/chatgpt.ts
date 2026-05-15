// packages/browser-extension/src/content/chatgpt.ts
import { extractContent, injectWithRetry, runCapturePipeline, sendCapture, startSessionCapture, waitForAnyElement } from "./shared";
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

// ── Network interceptor — captures ALL messages from the ChatGPT API ──────────
function installFetchInterceptor(): void {
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      const _originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await _originalFetch.apply(this, args);
        const url = typeof args[0] === 'string'
          ? args[0]
          : args[0]?.url ?? '';
        if (url.includes('/backend-api/conversation/') &&
            !url.includes('/continue') &&
            !url.includes('/regenerate')) {
          try {
            const clone = response.clone();
            const data = await clone.json();
            if (data?.mapping) {
              window.dispatchEvent(new CustomEvent(
                '__CM_CHATGPT_CONVERSATION__',
                { detail: JSON.stringify(data) }
              ));
            }
          } catch {}
        }
        return response;
      };
    })();
  `;
  document.documentElement.appendChild(script);
  script.remove();
}

function parseChatGPTConversationMapping(
  mapping: Record<string, unknown>
): Message[] {
  const messages: Message[] = [];
  for (const node of Object.values(mapping)) {
    const msg = (node as any).message;
    if (!msg) continue;
    if (msg.status !== 'finished_successfully') continue;
    const role = msg.author?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const parts = msg.content?.parts;
    if (!Array.isArray(parts)) continue;
    const content = parts
      .filter((p: unknown) => typeof p === 'string')
      .join('\n')
      .trim();
    if (content.length < 2) continue;
    messages.push({
      role: role as 'user' | 'assistant',
      content,
      timestamp: msg.create_time
        ? Math.floor(msg.create_time * 1000)
        : Date.now(),
    });
  }
  return messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

window.addEventListener('__CM_CHATGPT_CONVERSATION__', (e: Event) => {
  try {
    const data = JSON.parse((e as CustomEvent).detail);
    const messages = parseChatGPTConversationMapping(data.mapping);
    if (messages.length > 0) {
      console.debug('[CM:capture] ChatGPT network intercept:', messages.length, 'msgs');
      void sendCapture(messages, 'chatgpt');
    }
  } catch {}
});

installFetchInterceptor();

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
