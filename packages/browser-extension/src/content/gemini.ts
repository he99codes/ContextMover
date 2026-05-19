/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/content/gemini.ts
import { extractContent, injectWithRetry, runCapturePipeline, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "./shared";
import { getPlatformSelectors, type PlatformSelectors } from "@/lib/remote-config";

// Pre-warm remote selector config at load time.
let _remoteSelectors: PlatformSelectors | null = null;
getPlatformSelectors("gemini").then((s) => { _remoteSelectors = s; }).catch(() => {});

// ── DIAGNOSTIC STAGE 1 ────────────────────────────────────────────────────────
// Per-element streaming guard — skip messages still being generated.
function isStreaming(el: Element): boolean {
  return (
    el.querySelector('.loading-indicator, [aria-label="Gemini is responding"]') !== null ||
    el.closest('[class*="loading"]') !== null
  )
}

function scrapeMessages(): Message[] {
  // Remote selectors override hardcoded defaults when present.
  const userSel = _remoteSelectors?.userSelector ?? 'user-query, .user-query, [class*="user-query"]'
  const asstSel = _remoteSelectors?.assistantSelector ?? 'model-response, .model-response, [class*="model-response"]'
  const strategy = (_remoteSelectors?.userSelector || _remoteSelectors?.assistantSelector) ? 0 : 1

  const found: Array<{ el: Element; role: 'user' | 'assistant' }> = []

  // Outermost-only filter avoids double-capturing nested children with same class.
  document.querySelectorAll<HTMLElement>(userSel).forEach(el => {
    if (el.parentElement?.closest(userSel)) return
    if (isStreaming(el)) return
    found.push({ el, role: 'user' })
  })
  document.querySelectorAll<HTMLElement>(asstSel).forEach(el => {
    if (el.parentElement?.closest(asstSel)) return
    if (isStreaming(el)) return
    found.push({ el, role: 'assistant' })
  })

  found.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )

  const msgs = found.map(({ el, role }) => ({
    role,
    content: extractContent(el),
    timestamp: Date.now()
  })).filter(m => m.content.trim().length > 0)

  const u = msgs.filter(m => m.role === 'user').length
  const a = msgs.filter(m => m.role === 'assistant').length
  console.log(`[CM:diag:gemini] strategy=${strategy} user=${u} asst=${a}`)
  return msgs
}

startSessionCapture({
  platform: "gemini",
  selectorOrElement: "chat-window, main",
  scrapeMessages: () => runCapturePipeline("gemini", scrapeMessages),
  requiresScrollBack: true,
  getScrollContainerSelector: () => _remoteSelectors?.scrollContainer,
  extraCaptureDelays: [1500, 3000],
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
