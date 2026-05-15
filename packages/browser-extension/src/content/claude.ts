// packages/browser-extension/src/content/claude.ts
import { extractContent, injectWithRetry, runCapturePipeline, sendCapture, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "./shared";

console.log("[ContextMover] Claude content script loaded");

function scrapeMessages(): Message[] {
  const found: Array<{ el: Element; role: 'user' | 'assistant' }> = []

  // Primary selectors
  document.querySelectorAll('[data-testid="human-turn"]')
    .forEach(el => found.push({ el, role: 'user' }))
  document.querySelectorAll('[data-testid="ai-turn"]')
    .forEach(el => found.push({ el, role: 'assistant' }))

  // Fallback if primary returns nothing
  if (found.length === 0) {
    document.querySelectorAll(
      '.font-claude-message, [class*="human-turn"], ' +
      '[class*="ai-turn"], [class*="HumanTurn"], [class*="AssistantTurn"]'
    ).forEach(el => {
      const cls = el.className + (el.getAttribute('class') ?? '')
      found.push({ el, role: cls.toLowerCase().includes('human') ? 'user' : 'assistant' })
    })
  }

  // Sort by DOM position
  found.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )

  return found
    .map(({ el, role }) => ({
      role,
      content: extractContent(el),
      timestamp: Date.now()
    }))
    .filter(m => m.content.trim().length > 0)
}

// ── Network interceptor — captures ALL messages from the Claude API ────────────
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
        if (url.includes('/chat_conversations/') &&
            url.includes('tree=True')) {
          try {
            const clone = response.clone();
            const data = await clone.json();
            if (data?.chat_messages) {
              window.dispatchEvent(new CustomEvent(
                '__CM_CLAUDE_CONVERSATION__',
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

window.addEventListener('__CM_CLAUDE_CONVERSATION__', (e: Event) => {
  try {
    const data = JSON.parse((e as CustomEvent).detail);
    const messages: Message[] = (data.chat_messages as any[])
      .map((m: any) => {
        const text = Array.isArray(m.content)
          ? m.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text as string)
              .join('\n')
          : typeof m.content === 'string'
            ? m.content
            : '';
        return {
          role: (m.sender === 'human' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: text.trim(),
          timestamp: new Date(m.created_at).getTime(),
        };
      })
      .filter((m: Message) => m.content.length > 0);
    if (messages.length > 0) {
      console.debug('[CM:capture] Claude network intercept:', messages.length, 'msgs');
      void sendCapture(messages, 'claude');
    }
  } catch {}
});

installFetchInterceptor();

startSessionCapture({
  platform: "claude",
  selectorOrElement: "main",
  scrapeMessages: () => runCapturePipeline("claude", scrapeMessages),
});

// Listen for injection requests from the service worker
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "claude") {
    injectIntoClaudeInput(msg.prompt)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // CRITICAL — keeps channel open for async response
  }
});

async function injectIntoClaudeInput(text: string) {
  const input = await waitForAnyElement<HTMLElement>([
    '.ProseMirror[contenteditable="true"]',       // Claude ProseMirror editor
    '[contenteditable="true"][data-placeholder]', // placeholder-based selector
    '[contenteditable="true"][role="textbox"]',
    'fieldset [contenteditable="true"]',          // Claude wraps input in fieldset
    'form [contenteditable="true"]',
    '[contenteditable="true"]',                   // last-resort
  ]);

  if (!input) return { ok: false, error: "Claude input box not found. Make sure a chat is open." };

  if (!await injectWithRetry(input, text, "claude")) {
    return { ok: false, error: "Claude input did not accept the text after 3 attempts. Context copied to clipboard — paste with Ctrl+V." };
  }

  return { ok: true };
}
