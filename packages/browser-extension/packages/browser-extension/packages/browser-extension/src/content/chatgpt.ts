/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/content/chatgpt.ts
import { extractContent, injectWithRetry, runCapturePipeline, sendCapture, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "./shared";
import { getPlatformSelectors, type PlatformSelectors } from "@/lib/remote-config";

// Pre-warm remote selector config at load time.
let _remoteSelectors: PlatformSelectors | null = null;
getPlatformSelectors("chatgpt").then((s) => { _remoteSelectors = s; }).catch(() => {});

// ── DIAGNOSTIC STAGE 1 ────────────────────────────────────────────────────────
function scrapeMessages(): Message[] {
  const found: Array<{ el: Element; role: 'user' | 'assistant' }> = []

  // Strategy 0 (remote override): messageSelector replaces the attribute query;
  // contentSelector replaces the inner content element selector.
  // Falls through to hardcoded strategy if 0 results.
  if (_remoteSelectors?.messageSelector) {
    document.querySelectorAll(_remoteSelectors.messageSelector).forEach(el => {
      const role = el.getAttribute('data-message-author-role')
      if (role !== 'user' && role !== 'assistant') return
      if (el.getAttribute('data-is-streaming') === 'true') return
      found.push({ el, role })
    })
    if (found.length > 0) {
      const contentSel = _remoteSelectors.contentSelector ?? '.markdown, .whitespace-pre-wrap'
      const msgs = found.map(({ el, role }) => ({
        role,
        content: extractContent(el.querySelector<HTMLElement>(contentSel) ?? el as HTMLElement),
        timestamp: Date.now()
      })).filter(m => m.content.trim().length > 0)
      const u = msgs.filter(m => m.role === 'user').length
      const a = msgs.filter(m => m.role === 'assistant').length
      console.log(`[CM:diag:chatgpt] strategy=0 user=${u} asst=${a}`)
      return msgs
    }
    console.debug('[CM:chatgpt] remote selectors returned 0 — falling through to hardcoded')
  }

  // Strategy 1 (primary): [data-message-author-role] — stable across all 2026 ChatGPT builds.
  document.querySelectorAll('[data-message-author-role]').forEach(el => {
    const role = el.getAttribute('data-message-author-role')
    if (role !== 'user' && role !== 'assistant') return
    if (el.getAttribute('data-is-streaming') === 'true') return
    found.push({ el, role })
  })

  found.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )

  const msgs = found.map(({ el, role }) => ({
    role,
    content: extractContent(
      el.querySelector('.markdown, .whitespace-pre-wrap') ?? el
    ),
    timestamp: Date.now()
  })).filter(m => m.content.trim().length > 0)

  const u = msgs.filter(m => m.role === 'user').length
  const a = msgs.filter(m => m.role === 'assistant').length
  console.log(`[CM:diag:chatgpt] strategy=1 user=${u} asst=${a}`)
  return msgs
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
  requiresScrollBack: true,
  getScrollContainerSelector: () => _remoteSelectors?.scrollContainer,
  extraCaptureDelays: [1500, 3000],
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "chatgpt") {
    injectIntoChatGPTInput(msg.prompt)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // CRITICAL — keeps channel open for async response
  }
  if (msg.type === "INJECT_FILE_AS_UPLOAD") {
    void (async () => {
      try {
        const file = new File([msg.fileContent as string], msg.fileName as string, { type: "text/xml" });
        const dt = new DataTransfer();
        dt.items.add(file);
        let input = document.querySelector<HTMLInputElement>("input[type='file']");
        if (!input) {
          const attachBtn = document.querySelector<HTMLElement>(
            '[aria-label*="Attach"], [aria-label*="attach"], ' +
            'button[data-testid*="file-upload"], button[data-testid*="attach"], ' +
            '[aria-label*="File"], [aria-label*="file"], [class*="attach-btn"]'
          );
          if (attachBtn) {
            attachBtn.click();
            for (let i = 0; i < 20; i++) {
              await new Promise((r) => setTimeout(r, 100));
              input = document.querySelector<HTMLInputElement>("input[type='file']");
              if (input) break;
            }
          }
        }
        if (!input) { sendResponse({ ok: false, error: "File input not found on ChatGPT page" }); return; }
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
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
