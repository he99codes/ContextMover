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

console.log("[ContextMover] Grok content script loaded");

// Pre-warm remote selector config at load time.
let _remoteSelectors: PlatformSelectors | null = null;
getPlatformSelectors("grok").then((s) => { _remoteSelectors = s; }).catch(() => {});

// Per-element streaming guard — skips messages still being generated so we
// don't persist half-complete assistant output.
function isStreaming(el: Element): boolean {
  return (
    el.getAttribute('data-streaming') === 'true' ||
    el.closest('[data-streaming="true"]') !== null ||
    el.closest('[class*="streaming"]') !== null ||
    el.closest('[class*="loading"]') !== null
  )
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
    if (!hasAsst()) aEls.forEach(el => found.push({ el, role: 'assistant' }))
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

  // ── Strategy 5: message-bubble class — fallback for 2026+ Grok DOM ────────
  // Probe confirmed [class*="message-bubble"] finds 28 elements with text.
  // Use data-testid attribute within these bubbles to distinguish user vs assistant.
  if (!hasUser()) {
    const bubbles = [...document.querySelectorAll('[class*="message-bubble"]')]
      .filter(el => !isStreaming(el) && (el.textContent?.trim().length ?? 0) > 30)
    bubbles.forEach(el => {
      const testid = el.getAttribute('data-testid') || ''
      if (testid.includes('user')) {
        found.push({ el, role: 'user' })
      } else if (testid.includes('assistant')) {
        found.push({ el, role: 'assistant' })
      }
    })
    const u = found.filter(e => e.role === 'user').length
    const a = found.filter(e => e.role === 'assistant').length
    console.log(`[CM:diag:grok] S5 message-bubble: user=${u} asst=${a}`)
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
    console.warn('[CM:diag:grok] user=0 — selectors tried: S1=[data-testid*=human], S2=[class*=human-turn], S3=[class*=user-message]')
    console.warn('[CM:diag:grok] Candidate user classes:', [...classHits.entries()].sort((x,y)=>y[1]-x[1]).slice(0,10))
    console.warn('[CM:diag:grok] Candidate user testids/roles:', testidHits.slice(0,10))
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
  selectorOrElement: "main",
  scrapeMessages: () => runCapturePipeline("grok", scrapeMessages),
  requiresScrollBack: true,
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
        const file = new File([msg.fileContent as string], msg.fileName as string, { type: "text/xml" });
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
