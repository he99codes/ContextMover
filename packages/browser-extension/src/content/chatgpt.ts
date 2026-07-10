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
import { getOverridesForPlatform } from "@/lib/self-heal/selector-overrides";

// Pre-warm remote selector config at load time.
let _remoteSelectors: PlatformSelectors | null = null;
getPlatformSelectors("chatgpt").then((s) => { _remoteSelectors = s; }).catch(() => {});

// Pre-warm local self-heal overrides (user-confirmed via wizard).
let _localOverrides: Awaited<ReturnType<typeof getOverridesForPlatform>> = null;
getOverridesForPlatform("chatgpt").then((o) => { _localOverrides = o; }).catch(() => {});

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

  // Strategy 0b (local self-heal override): user-confirmed selectors from wizard.
  if (!_remoteSelectors?.messageSelector &&
      (_localOverrides?.userSelector || _localOverrides?.assistantSelector)) {
    if (_localOverrides.userSelector) {
      document.querySelectorAll<HTMLElement>(_localOverrides.userSelector)
        .forEach(el => { found.push({ el, role: 'user' }) })
    }
    if (_localOverrides.assistantSelector) {
      document.querySelectorAll<HTMLElement>(_localOverrides.assistantSelector)
        .forEach(el => { found.push({ el, role: 'assistant' }) })
    }
    if (found.length > 0) {
      found.sort((a, b) =>
        a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      )
      const msgs = found.map(({ el, role }) => ({
        role, content: extractContent(el as HTMLElement), timestamp: Date.now()
      })).filter(m => m.content.trim().length > 0)
      console.log(`[CM:chatgpt] local override selectors matched: ${msgs.length} turns`)
      return msgs
    }
    console.debug('[CM:chatgpt] local override selectors returned 0 — falling through to hardcoded')
  }

  // Guard: on the ChatGPT homepage (no conversation loaded) there are no messages.
  // Return early to avoid the structural fallback capturing script-tag content.
  const path = location.pathname;
  const isHomePage = path === '/' || path === '' || (!path.startsWith('/c/') && !path.startsWith('/g/') && !path.startsWith('/share/'));
  if (isHomePage) {
    console.debug('[CM:chatgpt] homepage — no conversation, skipping scrape');
    return [];
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

  const msgs = found.map(({ el, role }) => {
    const content = extractContent(el as HTMLElement);
    return { role, content, timestamp: Date.now() };
  }).filter(m => m.content.length > 0)

  const u = msgs.filter(m => m.role === 'user').length
  const a = msgs.filter(m => m.role === 'assistant').length
  console.log(`[CM:diag:chatgpt] strategy=1 user=${u} asst=${a}`)
  return msgs
}

// ── Network interceptor removed — handled by global fetch-interceptor.ts ──────────
// The global fetch-interceptor.ts (MAIN world, document_start) already handles
// ChatGPT API responses including both streaming SSE and full conversation JSON.
// This file now only does DOM scraping + injection.

startSessionCapture({
  platform: "chatgpt",
  selectorOrElement: () => _remoteSelectors?.observerTarget ?? 'main, [role="main"], #main',
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
        const txtName = (msg.fileName as string).replace(/\.xml$/, '.txt');
        const file = new File([msg.fileContent as string], txtName, { type: "text/plain" });
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
        const nativeFilesSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype, 'files'
        )?.set;
        if (nativeFilesSetter) {
          nativeFilesSetter.call(input, dt.files);
        } else {
          input.files = dt.files;
        }
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
