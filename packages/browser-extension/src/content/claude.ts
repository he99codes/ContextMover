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

console.log("[ContextMover] Claude content script loaded");

// Per-element streaming guard — skip turns where Claude is still generating
// so we don't persist half-complete assistant output. Claude marks streaming
// turns with [data-is-streaming="true"] or `.result-streaming`.
function isStreaming(el: Element): boolean {
  if (el.getAttribute('data-is-streaming') === 'true') return true
  if (el.querySelector('.result-streaming, [data-is-streaming="true"], .streaming-indicator')) return true
  if (el.closest('[data-is-streaming="true"]')) return true
  return false
}

function scrapeMessages(): Message[] {
  const found: Array<{ el: Element; role: 'user' | 'assistant' }> = []

  // Primary selectors — role assigned from the selector itself, never from
  // DOM position or class-substring guessing.
  document.querySelectorAll<HTMLElement>('[data-testid="human-turn"]')
    .forEach(el => { if (!isStreaming(el)) found.push({ el, role: 'user' }) })
  document.querySelectorAll<HTMLElement>('[data-testid="ai-turn"]')
    .forEach(el => { if (!isStreaming(el)) found.push({ el, role: 'assistant' }) })

  // Fallback if primary returns nothing. Use DISTINCT selectors per role
  // rather than a generic selector + class-string match — the latter would
  // mis-classify e.g. an element with class "humanize-button" as a user turn.
  if (found.length === 0) {
    const userSel = '[class*="human-turn"], [class*="HumanTurn"], [class*="user-message"]'
    const asstSel = '.font-claude-message, [class*="ai-turn"], [class*="AssistantTurn"], [class*="assistant-message"]'
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
  // Claude's SPA can take 2\u20136s to render messages after route changes (lazy
  // virtual-scroll mount). The default capture schedule (immediate, 100,
  // 500, 1000, 1500ms) misses these late renders. Add 3s and 6s as a safety
  // net \u2014 the SW's shrink-guard prevents these late captures from clobbering
  // a complete earlier capture with a partial one.
  extraCaptureDelays: [3000, 6000],
});

// Listen for injection requests from the service worker
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "claude") {
    injectIntoClaudeInput(msg.prompt)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // CRITICAL — keeps channel open for async response
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
