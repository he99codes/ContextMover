/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/content/grok.ts
import { extractContent, injectWithRetry, runCapturePipeline, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "./shared";
import { getPlatformSelectors, type PlatformSelectors } from "@/lib/remote-config";
import { getOverridesForPlatform } from "@/lib/self-heal/selector-overrides";

console.log("[ContextMover] Grok content script loaded");

// Pre-warm remote selector config at load time.
let _remoteSelectors: PlatformSelectors | null = null;
getPlatformSelectors("grok").then((s) => { _remoteSelectors = s; }).catch(() => {});

// Pre-warm local self-heal overrides (user-confirmed via wizard).
let _localOverrides: Awaited<ReturnType<typeof getOverridesForPlatform>> = null;
getOverridesForPlatform("grok").then((o) => { _localOverrides = o; }).catch(() => {});

// Per-element streaming guard — skips messages still being generated so we
// don't persist half-complete assistant output.
function isStreaming(el: Element): boolean {
  // [PHASE-4-FIX] Removed bare .loading class check — Grok's skeleton/composer
  // loaders carry .loading on ancestor containers, which was incorrectly marking
  // completed adjacent messages as streaming and filtering them out.
  // Only check data-streaming attr, .streaming class, and CHILD indicator elements.
  const hasMarker = (
    el.getAttribute('data-streaming') === 'true' ||
    el.classList.contains('streaming') ||
    el.querySelector('[data-streaming="true"], .streaming-indicator, .loading-indicator') !== null
  )
  if (!hasMarker) return false
  return !hasTerminalPunctuation(el as HTMLElement)
}

function hasTerminalPunctuation(el: HTMLElement): boolean {
  const text = (el.textContent ?? '').replace(/\s+$/, '')
  if (!text) return false
  return '.!?…`。！？'.includes(text.slice(-1))
}

function queryOutermost<T extends HTMLElement>(sel: string): T[] {
  return [...document.querySelectorAll<T>(sel)]
    .filter(el => !el.parentElement?.closest(sel) && !isStreaming(el))
}

function scrapeMessages(): Message[] {
  const found: Array<{ el: Element; role: 'user' | 'assistant' }> = []
  const hasUser = () => found.some(e => e.role === 'user')
  const hasAsst = () => found.some(e => e.role === 'assistant')

  // ── Remote override ──────────────────────────────────────────
  if (_remoteSelectors?.userSelector) {
    const uS = _remoteSelectors.userSelector
    const aS = _remoteSelectors.assistantSelector ?? ''
    queryOutermost(uS).forEach(el => found.push({ el, role: 'user' }))
    if (aS) queryOutermost(aS).forEach(el => found.push({ el, role: 'assistant' }))
    if (found.length > 0) {
      console.log(`[CM:diag:grok] remote: user=${found.filter(e=>e.role==='user').length} asst=${found.filter(e=>e.role==='assistant').length}`)
    } else {
      console.debug('[CM:diag:grok] remote selectors returned 0 — falling through')
    }
  }

  // ── Local self-heal override (wizard-confirmed selectors) ────
  // Only runs when remote config didn't supply selectors AND found is still empty.
  if (found.length === 0 && !_remoteSelectors?.userSelector &&
      (_localOverrides?.userSelector || _localOverrides?.assistantSelector)) {
    if (_localOverrides.userSelector) queryOutermost(_localOverrides.userSelector).forEach(el => found.push({ el, role: 'user' }))
    if (_localOverrides.assistantSelector) queryOutermost(_localOverrides.assistantSelector).forEach(el => found.push({ el, role: 'assistant' }))
    if (found.length > 0) {
      console.log(`[CM:diag:grok] local override: user=${found.filter(e=>e.role==='user').length} asst=${found.filter(e=>e.role==='assistant').length}`)
    }
  }

  // ── Strategy 0: Direct structural layout (Grok 2026) ───────────────────
  if (!hasUser() || found.length < 2) {
    const scrollContainer = document.querySelector('main div.overflow-y-auto');
    if (scrollContainer) {
      const chatWrapper = scrollContainer.firstElementChild;
      if (chatWrapper) {
        const tempFound: Array<{ el: Element; role: 'user' | 'assistant' }> = [];
        for (const row of Array.from(chatWrapper.children)) {
          // Skip non-message chrome (composer, suggestions, banners).
          const rowText = (row.textContent || '').trim();
          if (rowText.length === 0 || row.querySelector('form, input, textarea')) continue;

          // [GROK-MERGE-FIX] A Grok chat row is a flex container that holds ONE
          // message bubble. But during capture the DOM can transiently contain a
          // row that wraps BOTH a user bubble and an assistant reply (e.g. a
          // streaming exchange that hasn't been split into separate rows yet).
          // Treating such a row as a single message merges the two roles' text.
          //
          // Heuristic: count direct children whose own textContent is substantial
          // (>20 chars). A clean single-message row has exactly one such child
          // (the bubble). A merged row has >=2. Skip merged rows — Strategy 5/6
          // will pick up the individual bubbles via [class*="message-bubble"].
          const substantiveChildren = Array.from(row.children).filter(child => {
            const t = (child.textContent || '').trim();
            return t.length > 20;
          });
          if (substantiveChildren.length > 1) {
            continue; // merged row — let later strategies handle the bubbles
          }

          // Classify by alignment. User messages in Grok are right-aligned
          // (Tailwind items-end / justify-end / self-end); assistant is left.
          const target = substantiveChildren[0] ?? row;
          const cls = target.className.toString();
          let isUser = /items-end|justify-end|self-end/.test(cls);
          if (!isUser) {
            const cs = window.getComputedStyle(target as HTMLElement);
            isUser = cs.alignItems === 'flex-end' || cs.justifyContent === 'flex-end' || cs.alignSelf === 'flex-end';
          }
          // [ROLE-CONFIRM] Guard: if alignment says "user" but the element
          // contains assistant-only markers (prose, copy/regenerate buttons,
          // action rows), reclassify as assistant. This prevents merged rows
          // where a user bubble and an adjacent action bar share one container.
          if (isUser) {
            const hasAssistantMarkers =
              target.querySelector('.prose, [class*="prose"], [class*="markdown"]') !== null ||
              target.querySelector(
                '[aria-label*="copy" i], [aria-label*="regenerate" i], ' +
                '[aria-label*="like" i], [aria-label*="dislike" i], ' +
                '[aria-label*="retry" i]'
              ) !== null;
            if (hasAssistantMarkers) isUser = false;
          }
          tempFound.push({ el: target, role: isUser ? 'user' : 'assistant' });
        }
        if (tempFound.length > 0) {
          tempFound.forEach(c => found.push(c));
          console.log(`[CM:diag:grok] S0 structural: user=${tempFound.filter(e=>e.role==='user').length} asst=${tempFound.filter(e=>e.role==='assistant').length}`);
        }
      }
    }
  }

  // ── Strategy 1: data-testid role attributes — primary 2026 Grok pattern ─
  if (!hasUser()) {
    // Probe confirmed these exact selectors work: data-testid="user-message" and "assistant-message"
    const uS1 = '[data-testid="user-message"]'
    const aS1 = '[data-testid="assistant-message"]'
    const uEls = queryOutermost(uS1)
    const aEls = queryOutermost(aS1)
    uEls.forEach(el => found.push({ el, role: 'user' }))
    // [PHASE-4-FIX] Replaced broad !hasAsst() guard with element-level dedup.
    // Old guard silently dropped all S1 assistant elements if ANY assistant was
    // already found from a previous strategy, causing under-counting when strategies
    // partially overlap. Now we only skip elements already in the found set.
    const foundEls1 = new Set(found.map(f => f.el))
    aEls.filter(el => !foundEls1.has(el)).forEach(el => found.push({ el, role: 'assistant' }))
    console.log(`[CM:diag:grok] S1 testid: user=${uEls.length} asst=${aEls.length}`)
  }

  // ── Strategy 2: class substrings — human-turn / HumanTurn (2025-2026) ───
  if (!hasUser()) {
    const uS2 = '[class*="human-turn"], [class*="HumanTurn"], [class*="human_turn"]'
    const aS2 = '[class*="response-content-markdown"], [class*="grok-response"], [class*="GrokResponse"]'
    const uEls = queryOutermost(uS2)
    const aEls = queryOutermost(aS2)
    uEls.forEach(el => found.push({ el, role: 'user' }))
    if (!hasAsst()) aEls.forEach(el => found.push({ el, role: 'assistant' }))
    console.log(`[CM:diag:grok] S2 human-turn class: user=${uEls.length} asst=${aEls.length}`)
  }

  // ── Strategy 3: legacy patterns + role / data-role attribute ────────────
  if (!hasUser()) {
    const uS3 = '[class*="usermessage"], [class*="user-message"], [class*="UserMessage"], [data-role="user"], [role="user"]'
    const aS3 = '[class*="assistantmessage"], [class*="assistant-message"], [class*="AssistantMessage"], [data-role="assistant"]'
    const uEls = queryOutermost(uS3)
    const aEls = queryOutermost(aS3)
    uEls.forEach(el => found.push({ el, role: 'user' }))
    if (!hasAsst()) aEls.forEach(el => found.push({ el, role: 'assistant' }))
    console.log(`[CM:diag:grok] S3 legacy+role: user=${uEls.length} asst=${aEls.length}`)
  }

  // ── Strategy 4: ARIA labels + structural message containers ────────────────
  // Grok wraps messages in elements with aria-label attributes that survive
  // class-name obfuscation across deployments.
  if (!hasUser()) {
    const uS4 = '[aria-label*="your message" i], [aria-label*="You said" i], [aria-label*="user" i]:not(nav):not(header)'
    const aS4 = '[aria-label*="Grok" i]:not(nav):not(header):not(button), [aria-label*="response" i]:not(button)'
    const uEls = queryOutermost(uS4)
    const aEls = queryOutermost(aS4)
    uEls.forEach(el => found.push({ el, role: 'user' }))
    if (!hasAsst()) aEls.forEach(el => found.push({ el, role: 'assistant' }))
    console.log(`[CM:diag:grok] S4 aria+structural: user=${uEls.length} asst=${aEls.length}`)
  }

  // ── Strategy 5: message-bubble class — structural classification ────────
  // Grok 2026+ removed data-testid attributes from message elements.
  // Classify bubbles by structural cues instead:
  //   assistant = has prose/markdown/code-blocks/action-buttons/assistant-aria
  //   user = plain text, no markdown, no action buttons, typically shorter
  // If structural classification yields 0 user, fall back to alternating position.
  if (!hasUser() || found.length < 2) {
    const bubbles = [...document.querySelectorAll('[class*="message-bubble"]')]
      // [PHASE-4-FIX] Lowered min-length from 10 → 3 so short user messages
      // like "ok", "yes", "sure", "go" are not silently filtered out.
      .filter(el => !isStreaming(el) && (el.textContent?.trim().length ?? 0) > 3)
    const foundEls = new Set(found.map(f => f.el))
    const newFound: Array<{ el: Element; role: 'user' | 'assistant' }> = []

    for (const el of bubbles) {
      if (foundEls.has(el)) continue
      const hasProse = el.querySelector('.prose, [class*="prose"]') !== null
      const hasCode = el.querySelector('pre code, pre') !== null
      const hasActions = el.querySelector(
        '[aria-label*="copy" i], [aria-label*="regenerate" i], ' +
        '[aria-label*="like" i], [aria-label*="dislike" i], ' +
        '[aria-label*="share" i], [aria-label*="retry" i]'
      ) !== null
      const aria = el.getAttribute('aria-label') ?? ''
      const hasAssistantAria = /grok|response|assistant/i.test(aria)
      const hasUserAria = /\b(user|you|your|message)\b/i.test(aria)
      const text = (el.textContent ?? '').trim()
      const isShort = text.length < 500
      const hasMarkdown = /^#{1,3}\s|\*\*[^*]|```/m.test(text)
      // Right-aligned (Tailwind justify-end / self-end) → likely user
      const cls = el.className.toString()
      const isRightAligned = /justify-end|self-end|items-end|ml-auto|ms-auto/.test(cls)

      if (hasUserAria && !hasProse && !hasCode) {
        newFound.push({ el, role: 'user' })
      } else if (isRightAligned && !hasProse && !hasCode && !hasActions) {
        newFound.push({ el, role: 'user' })
      } else if (hasProse || hasCode || hasActions || hasAssistantAria || hasMarkdown) {
        newFound.push({ el, role: 'assistant' })
      } else if (isShort) {
        // [ROLE-ALT-FIX] Short text with no structural cues — use DOM-order
        // alternation instead of blindly defaulting to 'user'. A short
        // assistant message like "Done." or "Yes." was previously misclassified
        // as user. Track the last classified role; if the previously classified
        // bubble (in DOM order) was assistant, this is likely user (and vice versa).
        // This maintains the chat turn alternation invariant.
        const prevRole = newFound.length > 0
          ? newFound[newFound.length - 1].role
          : (hasUser() ? 'assistant' : 'user');
        newFound.push({ el, role: prevRole === 'assistant' ? 'user' : 'assistant' })
      } else {
        newFound.push({ el, role: 'assistant' })
      }
    }

    // If structural classification yielded 0 user, use alternating position.
    // In all chat UIs: first message = user, then alternates.
    if (newFound.length > 0 && !newFound.some(c => c.role === 'user') && !hasUser()) {
      newFound.sort((a, b) =>
        a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      )
      newFound.forEach((c, i) => {
        c.role = i % 2 === 0 ? 'user' : 'assistant'
      })
      console.log('[CM:diag:grok] S5 alternating-position fallback applied')
    }

    newFound.forEach(c => found.push(c))
    const u = found.filter(e => e.role === 'user').length
    const a = found.filter(e => e.role === 'assistant').length
    console.log(`[CM:diag:grok] S5 message-bubble: user=${u} asst=${a}`)
  }

  // ── Strategy 6: Container-child classification (obfuscated DOM) ─────────
  // When ALL named selectors fail (Grok fully obfuscated their class names),
  // find the scrollable chat container and classify its direct children by
  // structural cues: action buttons, prose/markdown, text length, alignment.
  if (found.length < 2) {
    const containers = [...document.querySelectorAll('main, [role="main"]')]
    let chatRoot: Element | null = null
    for (const c of containers) {
      // The chat container is the scrollable element with many children
      if (c.children.length >= 2) { chatRoot = c; break }
    }
    // Fallback: find the deepest scrollable container with >2 substantive children
    if (!chatRoot) {
      const scrollables = [...document.querySelectorAll('*')].filter(el => {
        const cs = getComputedStyle(el)
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
               el.scrollHeight > el.clientHeight + 50 &&
               el.children.length >= 1
      })
      // Pick the one with the most direct children with substantial text
      for (const sc of scrollables) {
        let targets = [...sc.children]
        if (targets.length === 1 && targets[0].children.length > 0) {
          targets = [...targets[0].children]
        }
        const substantialChildren = targets.filter(
          child => (child.textContent?.trim().length ?? 0) > 20
        )
        if (substantialChildren.length >= 2) {
          chatRoot = targets[0].parentElement
          break
        }
      }
    }

    if (chatRoot) {
      const foundEls = new Set(found.map(f => f.el))
      const candidates = [...chatRoot.children]
        .filter(el => !foundEls.has(el) && (el.textContent?.trim().length ?? 0) > 10 && !isStreaming(el))

      const classified: Array<{ el: Element; role: 'user' | 'assistant' }> = []

      for (const el of candidates) {
        const text = (el.textContent ?? '').trim()
        if (text.length < 5) continue
        // Skip nav, header, footer, form elements
        const tag = el.tagName.toLowerCase()
        if (['nav', 'header', 'footer', 'form', 'aside'].includes(tag)) continue

        const hasProse = el.querySelector('.prose, [class*="prose"], .markdown, [class*="markdown"]') !== null
        const hasCode = el.querySelector('pre code, pre, code') !== null
        const hasActions = el.querySelector(
          '[aria-label*="copy" i], [aria-label*="regenerate" i], ' +
          '[aria-label*="like" i], [aria-label*="dislike" i], ' +
          '[aria-label*="share" i], [aria-label*="retry" i], ' +
          'button svg, [class*="action"]'
        ) !== null
        const hasMarkdown = /^#{1,3}\s|\*\*[^*]|```|^\d+\.\s/m.test(text)
        const cs = getComputedStyle(el)
        const isRight = cs.marginLeft === 'auto' || cs.justifySelf === 'end' || cs.alignSelf === 'flex-end'
        const isLong = text.length > 300

        if (isRight && !hasProse && !hasCode && !hasActions) {
          classified.push({ el, role: 'user' })
        } else if (hasProse || hasCode || hasActions || hasMarkdown || isLong) {
          classified.push({ el, role: 'assistant' })
        } else if (text.length < 500 && !hasActions) {
          classified.push({ el, role: 'user' })
        } else {
          classified.push({ el, role: 'assistant' })
        }
      }

      // If no user messages found, use alternating position
      if (classified.length >= 2 && !classified.some(c => c.role === 'user') && !hasUser()) {
        classified.sort((a, b) =>
          a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
        )
        classified.forEach((c, i) => { c.role = i % 2 === 0 ? 'user' : 'assistant' })
        console.log('[CM:diag:grok] S6 alternating-position fallback')
      }

      classified.forEach(c => found.push(c))
      console.log(`[CM:diag:grok] S6 container-child: found=${classified.length} user=${classified.filter(e=>e.role==='user').length} asst=${classified.filter(e=>e.role==='assistant').length}`)
    }
  }

  const u = found.filter(e => e.role === 'user').length
  const a = found.filter(e => e.role === 'assistant').length
  console.log(`[CM:diag:grok] final: user=${u} asst=${a}`)

  // ── DOM inspection when user=0 but asst>0 ──────────────────────────
  if (u === 0 && a > 0) {
    const classHits = new Map<string, number>()
    const testidHits: string[] = []
    document.querySelectorAll<HTMLElement>('*').forEach(el => {
      if (!(el as HTMLElement).offsetParent && el.tagName !== 'BODY') return
      el.classList.forEach(c => {
        if (/human|user|query|question|prompt/i.test(c))
          classHits.set(c, (classHits.get(c) ?? 0) + 1)
      })
      const dt = (el as HTMLElement).dataset?.testid ?? ''
      if (dt && /human|user/i.test(dt) && !testidHits.includes(dt)) testidHits.push(dt)
      const dr = (el as HTMLElement).dataset?.role ?? ''
      if (dr && /human|user/i.test(dr) && !testidHits.includes('data-role='+dr)) testidHits.push('data-role='+dr)
    })
    console.debug('[CM:diag:grok] user=0 — selectors tried: S1=[data-testid*=human], S2=[class*=human-turn], S3=[class*=user-message]')
    console.debug('[CM:diag:grok] Candidate user classes:', [...classHits.entries()].sort((x,y)=>y[1]-x[1]).slice(0,10))
    console.debug('[CM:diag:grok] Candidate user testids/roles:', testidHits.slice(0,10))
  }

  found.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )

  return found.map(({ el, role }) => ({
    role,
    content: extractContent(el),
    timestamp: Date.now()
  })).filter(m => m.content.trim().length > 0)
}

startSessionCapture({
  platform: "grok",
  selectorOrElement: () => _remoteSelectors?.observerTarget ?? document.body ?? document.documentElement,
  scrapeMessages: () => runCapturePipeline("grok", scrapeMessages),
  requiresScrollBack: true,
  scrollBackStrategy: 'step',
  // [ISSUE-5-grok] Add scroll container selector for scrollback
  getScrollContainerSelector: () => _remoteSelectors?.scrollContainer ?? 'main, [class*="scroll"], [class*="chat"]',
  extraCaptureDelays: [1500, 3000],
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "grok") {
    injectIntoGrokInput(msg.prompt)
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
            '[aria-label*="Upload"], [aria-label*="upload"], ' +
            'button[data-testid*="upload"], button[data-testid*="attach"], ' +
            '[class*="upload"], [class*="attach"]'
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
        if (!input) { sendResponse({ ok: false, error: "File input not found on Grok page" }); return; }
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

const GROK_INJECT_SELECTORS = [
  // Current Grok composer (confirmed 2026-04) — [data-testid="chat-input"]
  // is a WRAPPER div; the real editor is a nested contenteditable ProseMirror.
  // We MUST target the inner contenteditable, not the wrapper.
  '[data-testid="chat-input"] [contenteditable="true"]',
  '[data-testid="chat-input"] .ProseMirror',
  '[data-testid="composer-text-input"] [contenteditable="true"]',
  '[data-testid="composer-text-input"]',       // legacy
  'textarea[placeholder*="Ask"]',              // Grok "Ask anything" placeholder
  'textarea[placeholder*="message"]',
  '[contenteditable="true"][role="textbox"]',
  '.ProseMirror[contenteditable="true"]',      // TipTap / ProseMirror editor
  '[class*="composer"] textarea',
  '[class*="input"] textarea',
  'form textarea',
  'textarea:not([readonly])',                  // broad textarea fallback
  '[contenteditable="true"]',                  // last-resort contenteditable
];

async function injectIntoGrokInput(text: string) {
  // Try each selector individually so we can log which one matched — this is
  // critical when Grok's DOM changes and we need to see which strategy worked.
  let input: HTMLElement | null = null;
  let matchedSelector = "";
  for (const sel of GROK_INJECT_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) {
      input = el;
      matchedSelector = sel;
      break;
    }
  }

  // If nothing yet, give the page up to 4s to render the composer (SPA route).
  if (!input) {
    input = await waitForAnyElement<HTMLElement>(GROK_INJECT_SELECTORS);
    matchedSelector = input
      ? GROK_INJECT_SELECTORS.find(s => document.querySelector(s) === input) ?? "(late)"
      : "";
  }

  if (!input) {
    console.warn("[ContextMover:grok] injection failed — no composer element matched any selector");
    return {
      ok: false,
      error: "Grok input box not found. Make sure a Grok chat tab is open and the page has finished loading.",
    };
  }

  console.log(`[ContextMover:grok] injecting via selector: ${matchedSelector}, tag=${input.tagName}, contentEditable=${input.isContentEditable}`);

  if (!await injectWithRetry(input, text, "grok")) {
    return {
      ok: false,
      error: `Grok input (${input.tagName.toLowerCase()}) did not accept the text after 3 attempts. Context copied to clipboard — paste with Ctrl+V.`,
    };
  }

  console.log("[ContextMover:grok] injection succeeded");
  return { ok: true };
}
