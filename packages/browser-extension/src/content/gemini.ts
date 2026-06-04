/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/content/gemini.ts
import { runCapturePipeline, startSessionCapture } from "./shared";
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
  const PRIORITY = ['user-query-content', 'message-content', '.response-content', '.query-text', '.markdown'];
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
  // Root container search (priority order)
  const GEMINI_ROOTS = ['chat-window', 'infinite-scroller', '[data-test-id="chat-history-container"]', 'conversation-container', 'main'] as const;
  let scope: Element | null = null;
  for (const sel of GEMINI_ROOTS) { scope = document.querySelector(sel); if (scope) { console.log(`[CM:gemini] root found: ${sel}`); break; } }
  if (!scope) { console.warn('[CM:gemini] no root found — falling back to document.body'); scope = document.body; }
  
  // Message selector strategy (Option A: custom elements + comprehensive fallbacks)
  // Primary: user-query (custom element) | Fallback: .query-content (class) | Last resort: [data-test-id="user-message"]
  // Primary: model-response (custom element) | Fallback: response-container (custom element) | Last resort: .response-content (class)
  const userSel = _remoteSelectors?.userSelector ?? ['user-query', '.query-content', '[data-test-id="user-message"]', 'user-query-content'].join(', ')
  const asstSel = _remoteSelectors?.assistantSelector ?? ['model-response', 'response-container', '.response-content', '[data-test-id="response-container"]', 'message-content'].join(', ')
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
  scope.querySelectorAll<HTMLElement>(userSel).forEach(el => {
    if (el.parentElement?.closest(userSel)) return
    if (isStreaming(el)) return
    found.push({ el, role: 'user' })
  })
  scope.querySelectorAll<HTMLElement>(asstSel).forEach(el => {
    if (el.parentElement?.closest(asstSel)) return
    if (isStreaming(el)) return
    found.push({ el, role: 'assistant' })
  })

  // ── Structural fallback: activates when all primary selectors find nothing ──
  if (found.length === 0) {
    const STRUCT_FALLBACKS: Array<[string, string]> = [
      // Container-based detection (look for message containers with role indicators inside)
      ['.conversation-container',           'conversation-container-class'],
      ['[class*="conversation-container"]', 'conversation-container-wildcard'],
      ['[class*="message-actions-h"]',      'message-actions-container'],
      ['[id*="c69da77b"], [id*="09f34cab"]', 'conversation-id-pattern'],
      // Direct element fallback
      ['response-container',                'response-container-tag'],
      ['[role="listitem"]',                 'listitem-role'],
      ['[class*="ng-tns"]',                 'angular-tns-class'],
    ];
    for (const [sel, label] of STRUCT_FALLBACKS) {
      const candidates = scope.querySelectorAll<HTMLElement>(sel);
      if (candidates.length === 0) continue;
      candidates.forEach(el => {
        if (isStreaming(el)) return;
        // Enhanced detection: look for message indicators in multiple ways
        const hasUserQuery = !!el.querySelector('user-query, user-query-content, [class*="user-query"]');
        const hasModelResponse = !!el.querySelector('model-response, response-container, [class*="model-response"], [class*="response-content"]');
        const hasMessageContent = !!el.querySelector('message-content, [class*="message-content"]');
        
        if (hasUserQuery) {
          found.push({ el, role: 'user' });
        } else if (hasModelResponse || hasMessageContent) {
          found.push({ el, role: 'assistant' });
        }
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
        const snap = scope?.firstElementChild?.outerHTML.slice(0, 500)
          ?? document.body?.firstElementChild?.outerHTML.slice(0, 500)
          ?? '(no scope/body element found)';
        console.warn('[CM:Debug] DOM snippet (first 500 chars):\n', snap);
        const kids = Array.from(scope?.children ?? document.body?.children ?? [])
          .map(c => `<${c.tagName.toLowerCase()} class="${c.getAttribute('class') ?? ''}">`);
        console.warn('[CM:Debug] scope> direct children:', kids);

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

// ── Gemini Injection Strategy (2026) ─────────────────────────────────────────
//
// Gemini uses Angular with ViewEncapsulation.ShadowDom on <rich-textarea>.
// This means the Quill editor (.ql-editor [contenteditable]) lives INSIDE a
// shadow root — document.querySelector("rich-textarea .ql-editor") silently
// returns null and has always been the root cause of Gemini injection failing.
//
// Selector priority (each attempt tries all three strategies in order):
//   1. Shadow root pierce — document.querySelector("rich-textarea").shadowRoot
//      .querySelector(".ql-editor") — works for Angular ShadowDom encapsulation
//   2. Direct document query — catches non-shadow layouts or future DOM changes
//   3. Deep recursive shadow walk — last resort for nested custom elements
//
// After finding the element we try (in order):
//   A. Quill JS API (__quill on the shadow host or a nearby container)
//   B. document.execCommand("selectAll" + "insertText") — fast and framework-aware
//   C. synthetic beforeinput + InputEvent — Angular change detection fallback
//   D. direct textContent assignment + InputEvent — absolute last resort
// ─────────────────────────────────────────────────────────────────────────────

type _QuillInstance = { setText(t: string): void; setSelection(n: number): void };

// Walks into open shadow roots to find the Gemini editor.
function deepQueryGeminiInput(root: Element | ShadowRoot): HTMLElement | null {
  const INNER_SELS = [
    '.ql-editor[contenteditable="true"]',
    '.ql-editor',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
  ];
  for (const sel of INNER_SELS) {
    const el = root.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  for (const child of Array.from(root.querySelectorAll('*'))) {
    const sr = (child as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
    if (sr) {
      const found = deepQueryGeminiInput(sr);
      if (found) return found;
    }
  }
  return null;
}

// Returns the Gemini text-input element, piercing shadow roots.
// Logs each attempt so devs can trace failures in DevTools.
async function findGeminiInput(timeoutMs = 6000): Promise<HTMLElement | null> {
  const RETRY_DELAYS_MS = [0, 100, 300, 800, 1500, 2000];
  const DIRECT_SELS = [
    'rich-textarea .ql-editor[contenteditable="true"]',
    'rich-textarea .ql-editor',
    'rich-textarea [contenteditable]',
    '.ql-editor[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
  ];

  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < timeoutMs) {
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay));

    console.log(`[CM] Gemini inject attempt ${attempt + 1} (delay=${delay}ms elapsed=${Date.now() - start}ms)`);

    // Strategy 1: pierce rich-textarea shadow root (primary path for Angular ShadowDom)
    const richTextareas = Array.from(document.querySelectorAll('rich-textarea'));
    for (const rt of richTextareas) {
      const sr = (rt as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
      if (sr) {
        const SHADOW_INNER = [
          '.ql-editor[contenteditable="true"]',
          '.ql-editor',
          '[contenteditable="true"]',
        ];
        for (const sel of SHADOW_INNER) {
          const el = sr.querySelector<HTMLElement>(sel);
          if (el) {
            console.log(`[CM] Gemini input found via shadow root: rich-textarea > #shadow > ${sel}`);
            return el;
          }
        }
      }
    }

    // Strategy 2: direct document.querySelector (non-shadow layout or future DOM change)
    for (const sel of DIRECT_SELS) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) {
        console.log(`[CM] Gemini input found via direct query: ${sel}`);
        return el;
      }
    }

    // Strategy 3: deep recursive shadow walk across entire page (last resort)
    const deep = deepQueryGeminiInput(document.body);
    if (deep) {
      console.log('[CM] Gemini input found via deep shadow walk');
      return deep;
    }

    attempt++;
    if (Date.now() - start >= timeoutMs) break;
  }

  console.warn(`[CM] Gemini inject: input not found after ${attempt} attempts (${Date.now() - start}ms)`);
  return null;
}

async function injectIntoGeminiInput(text: string) {
  const useElement = await findGeminiInput(6000);

  if (!useElement) {
    return { ok: false, error: "Gemini input box not found. Make sure a chat is open." };
  }

  useElement.focus();
  useElement.click();
  await new Promise<void>((r) => setTimeout(r, 80));

  // A. Try Quill JS API — check on shadow host and surrounding containers.
  //    rich-textarea.__quill or the nearest .ql-container.__quill.
  const rt = document.querySelector('rich-textarea') as (HTMLElement & { __quill?: _QuillInstance }) | null;
  if (rt?.__quill) {
    rt.__quill.setText(text);
    rt.__quill.setSelection(text.length);
    useElement.dispatchEvent(new Event('input', { bubbles: true }));
    console.log('[CM] Gemini inject: Quill API path');
    return { ok: true };
  }
  // Also check nearest .ql-container (may be in shadow root)
  const sr = rt?.shadowRoot ?? null;
  const quillContainer = (
    useElement.closest('.ql-container') ??
    sr?.querySelector('.ql-container')
  ) as (HTMLElement & { __quill?: _QuillInstance }) | null;
  if (quillContainer?.__quill) {
    quillContainer.__quill.setText(text);
    quillContainer.__quill.setSelection(text.length);
    useElement.dispatchEvent(new Event('input', { bubbles: true }));
    console.log('[CM] Gemini inject: Quill container API path');
    return { ok: true };
  }

  // B. execCommand path (framework-aware: triggers Angular/React beforeinput listeners).
  document.execCommand('selectAll', false, undefined);
  const didInsert = document.execCommand('insertText', false, text);
  useElement.dispatchEvent(new Event('input', { bubbles: true }));
  useElement.dispatchEvent(new Event('change', { bubbles: true }));
  if (didInsert && (useElement.textContent?.trim().length ?? 0) > 0) {
    console.log('[CM] Gemini inject: execCommand path succeeded');
    return { ok: true };
  }

  // C. Synthetic beforeinput + InputEvent — Angular listens on (beforeinput) host events.
  try {
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true, cancelable: true,
      inputType: 'insertText', data: text,
    });
    useElement.dispatchEvent(beforeInput);
    if (!beforeInput.defaultPrevented) {
      useElement.textContent = text;
    }
    useElement.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    if ((useElement.textContent?.trim().length ?? 0) > 0) {
      console.log('[CM] Gemini inject: beforeinput event path succeeded');
      return { ok: true };
    }
  } catch { /* fall through */ }

  // D. Direct textContent assignment (last resort).
  useElement.textContent = text;
  useElement.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  useElement.dispatchEvent(new Event('change', { bubbles: true }));
  const finalLen = useElement.textContent?.trim().length ?? 0;
  console.log(`[CM] Gemini inject: textContent fallback, length=${finalLen}`);
  return { ok: finalLen > 0 };
}
