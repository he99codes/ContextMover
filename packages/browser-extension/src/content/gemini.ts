/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/content/gemini.ts
import { runCapturePipeline, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "./shared";
import { getPlatformSelectors, type PlatformSelectors } from "@/lib/remote-config";

// Pre-warm remote selector config at load time.
let _remoteSelectors: PlatformSelectors | null = null;
getPlatformSelectors("gemini").then((s) => { _remoteSelectors = s; }).catch(() => {});

// ── DIAGNOSTIC STAGE 1 ────────────────────────────────────────────────────────
// Per-element streaming guard — skip messages still being generated.
function isStreaming(el: Element): boolean {
  // Only flag elements that explicitly contain a streaming indicator inside them.
  // The previous el.closest('[class*="loading"]') ancestor check over-rejected in
  // Gemini 2026 because Angular state classes containing "loading" sit high in the
  // tree, causing every captured message to be dropped (selectorHits>0, msgs=0).
  return el.querySelector('.loading-indicator, [aria-label="Gemini is responding"]') !== null;
}

function geminiExtractContent(el: Element): string {
  // Prefer narrowly-scoped inner content nodes to avoid Angular wrapper boilerplate
  // (action buttons, file carousels, source lists, regenerate, copy, etc.).
  //   .query-text                  — user message text (Gemini 2026 user-query)
  //   message-content .markdown    — assistant rendered markdown
  //   .markdown                    — assistant markdown (looser)
  //   message-content              — assistant container fallback
  const PRIORITY = ['.query-text', 'message-content .markdown', '.markdown', 'message-content'];
  const clean = (n: Element): string => {
    const c = n.cloneNode(true) as Element;
    c.querySelectorAll('script, template').forEach((x) => x.remove());
    return c.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  };
  for (const sel of PRIORITY) {
    const node = el.querySelector(sel);
    if (node) {
      const txt = clean(node);
      if (txt.length > 0) return txt;
    }
  }
  return clean(el);
}

function scrapeMessages(): Message[] {
  // Remote selectors override hardcoded defaults when present.
  // Gemini 2026: user-query-container, response-container-content, model-response-text, markdown
  const userSel = _remoteSelectors?.userSelector ?? [
    'user-query',
    '[class*="user-query-container"]',
    '[class*="user-query-bubble"]',
    '.user-query',
    'user-chunk',
    '[class*="user-chunk"]',
    'user-message',
  ].join(', ')
  const asstSel = _remoteSelectors?.assistantSelector ?? [
    'model-response',
    'ms-chat-turn[type="model"]',
    '[class*="model-response-text"]',
    '[class*="response-container"]',
    'response-element',
    '[class*="response-element"]',
    '.model-response',
    'message-content',
  ].join(', ')
  const strategy = (_remoteSelectors?.userSelector || _remoteSelectors?.assistantSelector) ? 0 : 1

  let _uHits = 0, _aHits = 0;
  console.groupCollapsed('[CM:Debug] Scraper Search');
  console.log('[CM:Debug] readyState:', document.readyState, '| strategy:', strategy === 0 ? '0 (remote)' : '1 (hardcoded)');
  console.log('[CM:Debug] URL:', location.href.slice(0, 100));
  console.groupCollapsed('[CM:Debug] User selectors');
  for (const sel of userSel.split(',').map(s => s.trim()).filter(Boolean)) {
    const n = document.querySelectorAll(sel).length; _uHits += n;
    console.log((n > 0 ? '  \u2713' : '  \u2717') + ` [${n}]  ${sel}`);
  }
  console.groupEnd();
  console.groupCollapsed('[CM:Debug] Assistant selectors');
  for (const sel of asstSel.split(',').map(s => s.trim()).filter(Boolean)) {
    const n = document.querySelectorAll(sel).length; _aHits += n;
    console.log((n > 0 ? '  \u2713' : '  \u2717') + ` [${n}]  ${sel}`);
  }
  console.groupEnd();
  console.groupEnd();

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

  // ── Structural fallback: activates when all primary selectors find nothing ──
  if (found.length === 0) {
    const STRUCT_FALLBACKS: Array<[string, string]> = [
      ['.conversation-container',           'conversation-container'],
      ['[class*="conversation-container"]', 'conversation-container-class'],
      ['response-container',                'response-container-tag'],
      ['[role="listitem"]',                 'listitem'],
    ];
    for (const [sel, label] of STRUCT_FALLBACKS) {
      const candidates = document.querySelectorAll<HTMLElement>(sel);
      if (candidates.length === 0) continue;
      candidates.forEach(el => {
        if (isStreaming(el)) return;
        const isUser = !!el.querySelector('user-query, [class*="user-query"]');
        const isAsst = !!el.querySelector('model-response, [class*="model-response"]');
        if (isUser) found.push({ el, role: 'user' });
        else if (isAsst) found.push({ el, role: 'assistant' });
      });
      if (found.length > 0) {
        console.log(`[CM:gemini] fallback found ${found.length} messages via ${label}`);
        break;
      }
    }
  }

  found.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )

  const msgs = found.map(({ el, role }) => ({
    role,
    content: geminiExtractContent(el),
    timestamp: Date.now()
  })).filter(m => m.content.trim().length > 0)

  const u = msgs.filter(m => m.role === 'user').length
  const a = msgs.filter(m => m.role === 'assistant').length
  console.log(`[CM:diag:gemini] strategy=${strategy} user=${u} asst=${a} selectorHits(u=${_uHits} a=${_aHits})`)

  if (u === 0 && a === 0) {
    if (_uHits === 0 && _aHits === 0) {
      console.warn('[CM:Debug] ZERO-SCRAPE: no selectors matched any nodes.');
      try {
        const mainEl = document.querySelector('main');
        const snap = mainEl?.firstElementChild?.outerHTML.slice(0, 500)
          ?? document.body?.firstElementChild?.outerHTML.slice(0, 500)
          ?? '(no main/body element found)';
        console.warn('[CM:Debug] DOM snippet (first 500 chars):\n', snap);
        const kids = Array.from(mainEl?.children ?? document.body?.children ?? [])
          .map(c => `<${c.tagName.toLowerCase()} class="${c.getAttribute('class') ?? ''}">`);
        console.warn('[CM:Debug] main> direct children:', kids);
      } catch (e) { console.warn('[CM:Debug] snapshot error:', e); }
    } else {
      console.warn('[CM:Debug] ZERO-SCRAPE: selectors hit nodes but all were filtered (isStreaming or empty extractContent).');
    }
  }

  return msgs
}

startSessionCapture({
  platform: "gemini",
  selectorOrElement: () => _remoteSelectors?.observerTarget ?? 'chat-window, main, [class*="chat-container"], [class*="conversation"]',
  scrapeMessages: () => runCapturePipeline("gemini", scrapeMessages),
  requiresScrollBack: true,
  scrollBackStrategy: 'step',
  getScrollContainerSelector: () => _remoteSelectors?.scrollContainer,
  // Angular renders message shells first, then hydrates text content async.
  // Extra 2 s / 4 s captures catch sessions that load after the initial mount.
  extraCaptureDelays: [1500, 2000, 3000, 4000],
  observerSettleMs: 150,
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "gemini") {
    injectIntoGeminiInput(msg.prompt)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // CRITICAL — keeps channel open for async response
  }
  if (msg.type === "INJECT_FILE_AS_UPLOAD" || msg.type === "INJECT_FILE_TO_TAB") {
    void (async () => {
      try {
        // Gemini 2026 has removed <input type="file"> from both light and shadow DOM.
        // Skip the entire file-input search and route straight to text injection.
        console.warn("[CM:gemini] INJECT_FILE_AS_UPLOAD: Gemini 2026 removes file inputs — routing directly to text injection");
        const textResult = await injectIntoGeminiInput(msg.fileContent as string);
        sendResponse(textResult);
        return;
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true; // keep channel open for async sendResponse
  }
});

type _QuillInstance = { setText(t: string): void; setSelection(n: number): void };

async function injectIntoGeminiInput(text: string) {
  const found = await waitForAnyElement<HTMLElement>([
    "rich-textarea .ql-editor",           // Quill editor inside rich-textarea
    "rich-textarea [contenteditable]",    // any contenteditable in rich-textarea
    "rich-textarea p",                    // paragraph inside Quill
    "[contenteditable='true'][role='textbox']",
    "rich-textarea",                      // component itself as fallback
    "[contenteditable='true']",
  ]);

  if (!found) return { ok: false, error: "Gemini input box not found. Make sure a chat is open." };

  // Unwrap to inner editable if we landed on the container element.
  let useElement: HTMLElement = found;
  if (found.tagName === 'RICH-TEXTAREA' || found.classList.contains('ql-container')) {
    const inner = found.querySelector('.ql-editor') ?? found.querySelector('[contenteditable]');
    if (inner) useElement = inner as HTMLElement;
  }

  useElement.focus();
  useElement.click();
  await new Promise<void>((r) => setTimeout(r, 100));

  // 1. Try Quill API first.
  const quillContainer = useElement.closest('.ql-container') as (HTMLElement & { __quill?: _QuillInstance }) | null;
  if (quillContainer?.__quill) {
    quillContainer.__quill.setText(text);
    quillContainer.__quill.setSelection(text.length);
    useElement.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  // 2. execCommand path.
  document.execCommand('selectAll', false, undefined);
  const didInsert = document.execCommand('insertText', false, text);

  // 3. Direct textContent fallback if execCommand failed.
  if (!didInsert) {
    useElement.textContent = text;
    useElement.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  }
  useElement.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}
