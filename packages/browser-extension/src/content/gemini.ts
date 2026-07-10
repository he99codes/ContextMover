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
import { getOverridesForPlatform } from "@/lib/self-heal/selector-overrides";

// Pre-warm remote selector config at load time.
let _remoteSelectors: PlatformSelectors | null = null;
getPlatformSelectors("gemini").then((s) => { _remoteSelectors = s; }).catch(() => {});

// Pre-warm local self-heal overrides (user-confirmed via wizard).
let _localOverrides: Awaited<ReturnType<typeof getOverridesForPlatform>> = null;
getOverridesForPlatform("gemini").then((o) => { _localOverrides = o; }).catch(() => {});

// ── DIAGNOSTIC STAGE 1 ────────────────────────────────────────────────────────
// Per-element streaming guard — skip messages still being generated.
function isStreaming(el: Element): boolean {
  return el.querySelector('.loading-indicator, [aria-label="Gemini is responding"]') !== null;
}

function geminiExtractContent(el: Element): string {
  const PRIORITY = [
    '.query-text', 'user-query-content', '.query-content',
    'message-content', '.markdown',
    '.response-content', '.response-container-content',
    '[data-test-id="user-message"]', '[data-test-id="response-container"]',
  ];
  const clean = (n: Element): string => {
    const c = n.cloneNode(true) as Element;
    c.querySelectorAll('script, template').forEach((x) => x.remove());
    let t = c.textContent?.replace(/[ \t]+/g, ' ').trim() ?? '';
    t = t.replace(/^(You said|Gemini said)\s+/i, '').trim();
    return t;
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

// [MAX-SCRAPE-RATE] Rate limiter — max 1 scrape per 3s to prevent CPU saturation
let _lastScrapeAt = 0;
const _MIN_SCRAPE_INTERVAL_MS = 3000;
let _lastScrapeResult: Message[] = [];

function scrapeMessages(): Message[] {
  const now = Date.now();
  if (now - _lastScrapeAt < _MIN_SCRAPE_INTERVAL_MS) {
    // Return last successful result instead of [] — returning [] triggers
    // zero-scrape retry logic and structural fallback in runCapturePipeline,
    // wasting CPU on retries for what is just a rate limit.
    return _lastScrapeResult;
  }
  _lastScrapeAt = now;

  const __CM_DEBUG = (window as any).__CM_DEBUG === true;
  const GEMINI_ROOTS = [
    'chat-window-content',
    'infinite-scroller',
    '[data-test-id="chat-history-container"]',
    'conversation-container',
    'chat-window',
    'main',
  ] as const;
  let scope: Element | null = null;
  for (const sel of GEMINI_ROOTS) {
    const candidate = document.querySelector(sel);
    if (!candidate) continue;
    const hasContent = candidate.querySelector('user-query, model-response, [data-test-id="user-message"], .query-content') !== null;
    const hasChildren = candidate.children.length > 0;
    if (hasContent || (hasChildren && sel !== 'chat-window' && sel !== 'chat-window-content')) {
      scope = candidate;
      if (__CM_DEBUG) console.log(`[CM:gemini] root found: ${sel}`);
      break;
    }
  }
  if (!scope) { scope = document.body; }

  const userSel = _remoteSelectors?.userSelector
    ?? _localOverrides?.userSelector
    ?? ['user-query', '.query-content', '[data-test-id="user-message"]', 'user-query-content'].join(', ')
  const asstSel = _remoteSelectors?.assistantSelector
    ?? _localOverrides?.assistantSelector
    ?? ['model-response', 'response-container', '.response-content', '[data-test-id="response-container"]', 'message-content'].join(', ')

  const found: Array<{ el: Element; role: 'user' | 'assistant' }> = []

  const userOuterAnchor = 'user-query';
  const asstOuterAnchor = 'model-response';
  scope.querySelectorAll<HTMLElement>(userSel).forEach(el => {
    if (el.parentElement?.closest(userOuterAnchor)) return
    if (isStreaming(el)) return
    found.push({ el, role: 'user' })
  })
  scope.querySelectorAll<HTMLElement>(asstSel).forEach(el => {
    if (el.parentElement?.closest(asstOuterAnchor)) return
    if (isStreaming(el)) return
    found.push({ el, role: 'assistant' })
  })

  // Structural fallback
  if (found.length === 0) {
    const STRUCT_FALLBACKS: Array<[string, string]> = [
      ['.conversation-container', 'conversation-container-class'],
      ['[class*="conversation-container"]', 'conversation-container-wildcard'],
      ['response-container', 'response-container-tag'],
      ['[role="listitem"]', 'listitem-role'],
    ];
    for (const [sel, label] of STRUCT_FALLBACKS) {
      const candidates = scope.querySelectorAll<HTMLElement>(sel);
      if (candidates.length === 0) continue;
      candidates.forEach(el => {
        if (isStreaming(el)) return;
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

  const GEMINI_UI_CHROME = /^(New chat|Search chats|Images|Videos|Library|New notebook|Ctrl\+Shift)/i;
  const msgs = found.map(({ el, role }) => ({
    role,
    content: geminiExtractContent(el),
    timestamp: Date.now()
  })).filter(m => {
    const t = m.content.trim();
    if (t.length < 3) return false;
    if (GEMINI_UI_CHROME.test(t)) return false;
    return true;
  })

  const u = msgs.filter(m => m.role === 'user').length
  const a = msgs.filter(m => m.role === 'assistant').length
  if (__CM_DEBUG) console.log(`[CM:diag:gemini] user=${u} asst=${a}`)

  _lastScrapeResult = msgs;
  return msgs
}

// [SINGLE-LATE-CAPTURE] Single capture at 3000ms, longer settle window
startSessionCapture({
  platform: "gemini",
  selectorOrElement: () => _remoteSelectors?.observerTarget ?? 'chat-window, main, [class*="chat-container"], [class*="conversation"]',
  scrapeMessages: () => runCapturePipeline("gemini", scrapeMessages),
  requiresScrollBack: true,
  useVirtualScrollSweep: true,
  getScrollContainerSelector: () => _remoteSelectors?.scrollContainer,
  extraCaptureDelays: [3000], // Single late capture only
  observerSettleMs: 800, // Longer settle for Angular hydration
  watchCharacterData: false,
});

// [CLEANUP-ON-UNLOAD] Stop observer on page unload to prevent zombie captures
window.addEventListener('beforeunload', () => {
  // The shared capture pipeline will stop the MutationObserver
  console.log('[CM:gemini] page unloading — stopping capture');
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "gemini") {
    injectIntoGeminiInput(msg.prompt)
      .then((result) => {
        console.log('[CM:gemini] INJECT_CONTEXT result:', result);
        sendResponse(result);
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error('[CM:gemini] INJECT_CONTEXT error:', errMsg, err);
        sendResponse({ ok: false, error: errMsg });
      });
    return true;
  }
  if (msg.type === "INJECT_FILE_AS_UPLOAD" || msg.type === "INJECT_FILE_TO_TAB") {
    void (async () => {
      try {
        console.warn("[CM:gemini] INJECT_FILE_AS_UPLOAD: Gemini 2026 removes file inputs — routing directly to text injection");
        const textResult = await injectIntoGeminiInput(msg.fileContent as string);
        sendResponse(textResult);
        return;
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }
});

// ── Gemini Injection Strategy (2026) ─────────────────────────────────────────
// Clipboard paste FIRST for ALL sizes (fastest for large text)
// Never use execCommand for >2000 chars (causes freeze)
// document.hidden guard to prevent background injection
// findGeminiInput timeout 3000ms with fewer retries

type _QuillInstance = { setText(t: string): void; setSelection(n: number): void };

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

async function findGeminiInput(timeoutMs = 3000): Promise<HTMLElement | null> {
  const RETRY_DELAYS_MS = [0, 200, 500, 1000];
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

    const richTextareas = Array.from(document.querySelectorAll('rich-textarea'));
    for (const rt of richTextareas) {
      const sr = (rt as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
      if (sr) {
        const SHADOW_INNER = ['.ql-editor[contenteditable="true"]', '.ql-editor', '[contenteditable="true"]'];
        for (const sel of SHADOW_INNER) {
          const el = sr.querySelector<HTMLElement>(sel);
          if (el) {
            console.log(`[CM] Gemini input found via shadow root: ${sel}`);
            return el;
          }
        }
      }
    }

    for (const sel of DIRECT_SELS) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) {
        console.log(`[CM] Gemini input found via direct query: ${sel}`);
        return el;
      }
    }

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

function fireAngularEvents(el: HTMLElement, dataText: string): void {
  const rt = document.querySelector('rich-textarea');
  const targets = rt ? [el, rt as HTMLElement] : [el];
  for (const t of targets) {
    try { t.dispatchEvent(new InputEvent('input', { bubbles: true, data: dataText, inputType: 'insertText' })); } catch { /**/ }
    try { t.dispatchEvent(new Event('change', { bubbles: true })); } catch { /**/ }
  }
}

function selectAllInElement(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

async function injectIntoGeminiInput(text: string) {
  // [DOCUMENT.HIDDEN GUARD] Skip injection if tab is not visible
  if (document.hidden) {
    console.warn('[CM:gemini] Tab is hidden — skipping injection');
    return { ok: false, error: 'Tab is hidden' };
  }

  try {
    const useElement = await findGeminiInput(3000);

    if (!useElement) {
      return { ok: false, error: "Gemini input box not found. Make sure a chat is open." };
    }

    console.log('[CM:gemini] Input element found, focusing and clicking');
    useElement.focus();
    useElement.click();
    await new Promise<void>((r) => setTimeout(r, 50));

    // A. Quill JS API
    const rt = document.querySelector('rich-textarea') as (HTMLElement & { __quill?: _QuillInstance }) | null;
    if (rt?.__quill) {
      console.log('[CM:gemini] Attempting Quill API path');
      rt.__quill.setText(text);
      rt.__quill.setSelection(text.length);
      fireAngularEvents(useElement, text);
      console.log('[CM:gemini] Quill API path succeeded');
      return { ok: true };
    }
    const sr = rt?.shadowRoot ?? null;
    const quillContainer = (
      useElement.closest('.ql-container') ??
      sr?.querySelector('.ql-container')
    ) as (HTMLElement & { __quill?: _QuillInstance }) | null;
    if (quillContainer?.__quill) {
      console.log('[CM:gemini] Attempting Quill container API path');
      quillContainer.__quill.setText(text);
      quillContainer.__quill.setSelection(text.length);
      fireAngularEvents(useElement, text);
      console.log('[CM:gemini] Quill container API path succeeded');
      return { ok: true };
    }

    // B. Bulk ClipboardEvent paste — FIRST strategy for ALL sizes (fastest for large text)
    console.log(`[CM:gemini] Attempting bulk clipboard paste path (${text.length} chars)`);
    try {
      selectAllInElement(useElement);
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true,
      });
      const dispatched = useElement.dispatchEvent(pasteEvent);
      fireAngularEvents(useElement, text);
      await new Promise<void>((r) => setTimeout(r, 50));
      if ((!dispatched || (useElement.textContent?.trim().length ?? 0) > 0) &&
          (useElement.textContent?.trim().length ?? 0) > 0) {
        console.log('[CM:gemini] bulk clipboard paste path succeeded');
        return { ok: true };
      }
    } catch (e) {
      console.warn('[CM:gemini] bulk clipboard paste path failed:', e);
    }

    // C. execCommand path — ONLY for small text (≤2000 chars)
    if (text.length <= 2000) {
      console.log('[CM:gemini] Attempting execCommand path (small text)');
      selectAllInElement(useElement);
      const didInsert = document.execCommand('insertText', false, text);
      fireAngularEvents(useElement, text);
      if (didInsert && (useElement.textContent?.trim().length ?? 0) > 0) {
        console.log('[CM:gemini] execCommand path succeeded');
        return { ok: true };
      }
    }

    // D. Synthetic beforeinput event
    console.log('[CM:gemini] Attempting beforeinput event path');
    try {
      selectAllInElement(useElement);
      const beforeInput = new InputEvent('beforeinput', {
        bubbles: true, cancelable: true,
        inputType: 'insertText', data: text,
      });
      useElement.dispatchEvent(beforeInput);
      if ((useElement.textContent?.trim().length ?? 0) === 0 && text.length <= 2000) {
        document.execCommand('insertText', false, text);
      }
      fireAngularEvents(useElement, text);
      await new Promise<void>((r) => setTimeout(r, 30));
      if ((useElement.textContent?.trim().length ?? 0) > 0) {
        console.log('[CM:gemini] beforeinput event path succeeded');
        return { ok: true };
      }
    } catch (e) {
      console.error('[CM:gemini] beforeinput event path error:', e);
    }

    // E. Direct textContent assignment (last resort)
    console.log('[CM:gemini] Attempting textContent fallback');
    useElement.textContent = text;
    fireAngularEvents(useElement, text);
    await new Promise<void>((r) => setTimeout(r, 30));
    const finalLen = useElement.textContent?.trim().length ?? 0;
    console.log(`[CM:gemini] textContent fallback completed, length=${finalLen}`);
    return { ok: finalLen > 0, error: finalLen === 0 ? 'text_not_set_after_all_strategies' : undefined };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error('[CM:gemini] injectIntoGeminiInput error:', errMsg, e);
    return { ok: false, error: errMsg };
  }
}
