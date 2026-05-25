/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/content/claude.ts
//
// Why this file does NOT install its own window.fetch interceptor:
//   fetch-interceptor.ts (MAIN world, document_start, manifest-declared) already
//   intercepts every Claude API endpoint matching the regex
//     /completion|append_message|chat_conversations/
//   that is, conversation-load (tree=True), assistant-streaming (/completion),
//   and message-append calls. The previous claude.ts wrapper only matched
//   chat_conversations+tree=True \u2014 a strict subset \u2014 and ran on TOP of the
//   already-installed fetch-interceptor.ts override, creating a double-process
//   chain. Removing the redundant wrapper eliminates the conflict and lets the
//   single MAIN-world interceptor route Claude through interceptor-bridge.ts.
//   This file now does only DOM scraping + injection.
import { extractContent, injectWithRetry, runCapturePipeline, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "./shared";
import { getPlatformSelectors, type PlatformSelectors } from "@/lib/remote-config";

console.log("[ContextMover] Claude content script loaded");

// Pre-warm remote selector config at load time so scrapeMessages() can use it
// synchronously. Failures are silently swallowed — hardcoded defaults take over.
let _remoteSelectors: PlatformSelectors | null = null;
getPlatformSelectors("claude").then((s) => { _remoteSelectors = s; }).catch(() => {});

// Per-element streaming guard — skip turns where Claude is still generating
// so we don't persist half-complete assistant output. Claude marks streaming
// turns with [data-is-streaming="true"] or `.result-streaming`.
function isStreaming(el: Element): boolean {
  if (el.getAttribute('data-is-streaming') === 'true') return true
  if (el.querySelector('.result-streaming, [data-is-streaming="true"], .streaming-indicator')) return true
  if (el.closest('[data-is-streaming="true"]')) return true
  return false
}

// One-shot DOM-signature diagnostic. Sends class/testid signatures of the
// elements we suspect are conversation turns to the SW console so we can lock
// onto the right Claude selectors when they change.
let domSignatureSent = false
function sendDomSignatureDiagnostic(label: string, els: Element[]): void {
  if (domSignatureSent) return
  domSignatureSent = true
  const sigs = els.slice(0, 3).map((el, i) => {
    const tag = el.tagName.toLowerCase()
    const cls = (el.className && typeof el.className === 'string')
      ? el.className.split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
      : ''
    const tid = el.getAttribute('data-testid') ?? ''
    const role = el.getAttribute('role') ?? ''
    const parentCls = (el.parentElement?.className && typeof el.parentElement.className === 'string')
      ? el.parentElement.className.split(/\s+/).filter(Boolean).slice(0, 4).join(' ')
      : ''
    return `#${i}{tag=${tag} tid="${tid}" role="${role}" cls="${cls}" parent.cls="${parentCls}"}`
  }).join(' | ')
  try {
    chrome.runtime.sendMessage(
      { type: 'CM_DIAG', platform: 'claude', reason: `dom-sig[${label}] ${sigs}`, href: location.href },
      () => { void chrome.runtime.lastError }
    )
  } catch { /* SW asleep */ }
}

function scrapeMessages(): Message[] {
  const found: Array<{ el: Element; role: 'user' | 'assistant' }> = []

  // Scope queries to the actual chat area. Claude renders the sidebar
  // conversation list and other UI chrome in the document too — querying the
  // whole document caught 167 elements that weren't real conversation turns.
  const scopeSel = _remoteSelectors?.messageScope ?? 'main'
  const scope: ParentNode = document.querySelector(scopeSel) ?? document

  // Strategy 0 (remote override): use server-pushed selectors when available.
  // If they return 0 results, fall through to hardcoded strategies unchanged.
  if (_remoteSelectors?.userSelector || _remoteSelectors?.assistantSelector) {
    if (_remoteSelectors.userSelector) {
      scope.querySelectorAll<HTMLElement>(_remoteSelectors.userSelector)
        .forEach(el => { if (!isStreaming(el)) found.push({ el, role: 'user' }) })
    }
    if (_remoteSelectors.assistantSelector) {
      scope.querySelectorAll<HTMLElement>(_remoteSelectors.assistantSelector)
        .forEach(el => { if (!isStreaming(el)) found.push({ el, role: 'assistant' }) })
    }
    if (found.length > 0) {
      console.log(`[CM:claude] remote selectors matched: ${found.length} turns`)
      found.sort((a, b) =>
        a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      )
      return found
        .map(({ el, role }) => ({ role, content: extractContent(el), timestamp: Date.now() }))
        .filter(m => m.content.trim().length > 0)
    }
    console.debug('[CM:claude] remote selectors returned 0 — falling through to hardcoded')
  }

  // Primary selectors — each queried independently so the per-selector
  // outermost guard (closest) never cross-contaminates across selector variants.
  // This prevents .font-claude-response (nested inside .font-claude-message)
  // from being filtered out when the two selectors share a combined string.
  const primaryUserCandidates = [
    '[data-testid="human-turn"]',
    '[data-testid="user-message"]',
  ];
  const primaryAsstCandidates = [
    '[data-testid="assistant-message"]',
    '[data-testid="ai-turn"]',
    '.font-claude-message',
    '.font-claude-response',
  ];

  for (const sel of primaryUserCandidates) {
    const els = Array.from(scope.querySelectorAll<HTMLElement>(sel))
      .filter(el => !el.parentElement?.closest(sel) && !isStreaming(el));
    if (els.length > 0) {
      els.forEach(el => found.push({ el, role: 'user' }));
      console.log(`[CM:diag:claude] primary user matched via ${sel}: ${els.length}`);
      break;
    }
  }
  for (const sel of primaryAsstCandidates) {
    const els = Array.from(scope.querySelectorAll<HTMLElement>(sel))
      .filter(el => !el.parentElement?.closest(sel) && !isStreaming(el));
    if (els.length > 0) {
      els.forEach(el => found.push({ el, role: 'assistant' }));
      console.log(`[CM:diag:claude] primary asst matched via ${sel}: ${els.length}`);
      break;
    }
  }

  if (found.length > 0) {
    const u = found.filter(e => e.role === 'user').length;
    const a = found.filter(e => e.role === 'assistant').length;
    console.log(`[CM:diag:claude] primary selectors matched: user=${u} asst=${a}`)
  }

  // Fallback A: 2024-2025 Claude markers. user is stable as
  // [data-testid="user-message"]; assistant has rotated through several
  // markers — try them all.
  if (found.length === 0) {
    const userEls = Array.from(scope.querySelectorAll<HTMLElement>('[data-testid="user-message"]'))
      .filter(el => !el.parentElement?.closest('[data-testid="user-message"]'))
      .filter(el => !isStreaming(el))
    userEls.forEach(el => found.push({ el, role: 'user' }))

    const asstSelectors = [
      '[data-testid="assistant-message"]',
      '[data-testid="ai-message"]',
      '[data-testid="claude-response"]',
      '[data-testid="bot-message"]',
      '.font-claude-message',
      '.font-claude-response',
      '[class*="claude-response"]',
    ]
    let asstMatchedBy = ''
    for (const sel of asstSelectors) {
      const matches = Array.from(scope.querySelectorAll<HTMLElement>(sel))
        .filter(el => !el.parentElement?.closest(sel))
        .filter(el => !isStreaming(el))
      if (matches.length > 0) {
        matches.forEach(el => found.push({ el, role: 'assistant' }))
        asstMatchedBy = sel
        break
      }
    }

    if (found.length > 0) {
      console.log(
        `[CM:claude] fallback A matched: ${userEls.length} user + ` +
        `${found.length - userEls.length} asst (asst via ${asstMatchedBy || 'NONE'})`
      )
      try {
        chrome.runtime.sendMessage(
          { type: 'CM_DIAG', platform: 'claude',
            reason: `fallback A: user=${userEls.length} asst=${found.length - userEls.length} (asst sel: ${asstMatchedBy || 'none-matched'})`,
            href: location.href },
          () => { void chrome.runtime.lastError }
        )
      } catch { /* ok */ }
    }
  }

  // Fallback B: class-substring heuristic. Stricter user selector to avoid
  // catching unrelated UI chrome like the input box ("user-message-input").
  if (found.length === 0) {
    const userSel = '[class*="HumanTurn"], [class*="human-turn"]'
    const asstSel = '[class*="AssistantTurn"], [class*="assistant-turn"], [class*="ai-turn"]'
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
    if (found.length > 0) {
      console.log(`[CM:claude] fallback B (HumanTurn/AssistantTurn) matched: ${found.length} turns`)
    }
  }

  // Fallback C: position-parity in a conversation container. When every named
  // selector fails, find the conversation root and treat its direct children
  // (or `[data-test-render-count]` turn wrappers) as alternating user/assistant
  // starting with user.
  if (found.length === 0) {
    const turnWrappers = Array.from(scope.querySelectorAll<HTMLElement>(
      '[data-test-render-count], div[class*="conversation-turn"], div[class*="group/conversation-turn"]'
    )).filter(el => (el.textContent ?? '').trim().length > 10)

    if (turnWrappers.length >= 2) {
      turnWrappers.forEach((el, i) => {
        if (isStreaming(el)) return
        found.push({ el, role: i % 2 === 0 ? 'user' : 'assistant' })
      })
      console.log(`[CM:claude] fallback C (position-parity) matched: ${found.length} turns from ${turnWrappers.length} wrappers`)
      sendDomSignatureDiagnostic('turn-wrappers', turnWrappers)
    }
  }

  // Fallback D: prose content blocks. When no role-aware selector matches,
  // collect .prose / [class*="prose"] elements inside any visible container —
  // Claude renders all assistant responses inside a prose wrapper.
  // Only used as assistant captures; role assignment is conservative (all asst).
  if (found.length === 0) {
    const proseSel = 'div[class*="prose"], div.prose'
    const proseEls = Array.from(scope.querySelectorAll<HTMLElement>(proseSel))
      .filter(el => !el.parentElement?.closest(proseSel) && !isStreaming(el))
      .filter(el => (el.textContent ?? '').trim().length > 20)
    if (proseEls.length > 0) {
      proseEls.forEach(el => found.push({ el, role: 'assistant' }))
      console.log(`[CM:diag:claude] fallback D (prose) matched: ${proseEls.length} asst blocks`)
    }
  }

  if (found.length === 0) {
    console.warn('[CM:claude] all selectors returned 0 — structural fallback will run next')
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

startSessionCapture({
  platform: "claude",
  selectorOrElement: "main",
  scrapeMessages: () => runCapturePipeline("claude", scrapeMessages),
  // Claude's SPA can take 2–6s to render messages after route changes (lazy
  // virtual-scroll mount). The default capture schedule (immediate, 100,
  // 500, 1000, 1500ms) misses these late renders. Add 3s and 6s as a safety
  // net — the SW's shrink-guard prevents these late captures from clobbering
  // a complete earlier capture with a partial one.
  extraCaptureDelays: [3000, 6000],
  // Scrollback is a no-op for short/new sessions (originalScrollTop===0);
  // for long sessions (>100 turns) it loads virtualized history.
  requiresScrollBack: true,
  getScrollContainerSelector: () => _remoteSelectors?.scrollContainer,
});

// Listen for injection requests from the service worker
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "claude") {
    injectIntoClaudeInput(msg.prompt)
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
            '[aria-label*="Attach"], [aria-label*="attach"], [aria-label*="file"], ' +
            '[data-testid*="file-upload"], [data-testid*="attach"], ' +
            'label[for*="file-upload"], button[aria-label*="File"]'
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
        if (!input) { sendResponse({ ok: false, error: "File input not found on Claude page" }); return; }
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
