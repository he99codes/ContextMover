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
  // Gemini 2026: user-query-container, response-container-content, model-response-text, markdown
  const userSel = _remoteSelectors?.userSelector ?? '[class*="user-query-container"], [class*="user-query-bubble"], user-query, .user-query, [class*="user-query"]'
  const asstSel = _remoteSelectors?.assistantSelector ?? '[class*="response-container-content"], [class*="model-response-text"], model-response, .model-response, [class*="model-response"]'
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
  if (msg.type === "INJECT_FILE_AS_UPLOAD") {
    void (async () => {
      try {
        const file = new File([msg.fileContent as string], msg.fileName as string, { type: "text/xml" });
        const dt = new DataTransfer();
        dt.items.add(file);
        let input = document.querySelector<HTMLInputElement>("input[type='file']");
        // Gemini hides the file input until the attach/upload button is clicked.
        // Try clicking the upload trigger, then wait for the input to materialize.
        if (!input) {
          const uploadBtn = document.querySelector<HTMLElement>(
            '[aria-label*="Upload"], [aria-label*="upload"], [aria-label*="Attach"], ' +
            'button[data-testid="file-upload"], [data-testid="attach-file-button"], ' +
            '.upload-button, [class*="upload"], [class*="attach"]'
          );
          if (uploadBtn) {
            uploadBtn.click();
            // Wait up to 2s for the file input to appear in the DOM
            for (let i = 0; i < 20; i++) {
              await new Promise((r) => setTimeout(r, 100));
              input = document.querySelector<HTMLInputElement>("input[type='file']");
              if (input) break;
            }
          }
        }
        if (!input) { sendResponse({ ok: false, error: "File input not found on Gemini page" }); return; }
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true; // keep channel open for async sendResponse
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
