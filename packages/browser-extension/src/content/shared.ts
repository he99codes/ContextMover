/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/content/shared.ts
import type { Message as LibMessage, Platform } from "@/lib/types";
import { resolveSessionId, makeLegacyChecker } from "@/lib/session-id";
import { validateCapture } from "@/lib/capture/capture-validator";
import { detectByStructure } from "@/lib/capture/structural-detector";
import { mergePartialScrape } from "@/lib/capture/capture-merge";
import { healthMonitor } from "@/lib/capture/health-monitor";

export type Message = LibMessage;

const legacyChecker = makeLegacyChecker();

let _ctxInvalidated = false;
function isCtxValid(): boolean {
  if (_ctxInvalidated) return false;
  try { void chrome.runtime.id; return true; } catch { _ctxInvalidated = true; console.warn('[ContextMover] Extension context invalidated — reload page to restore'); return false; }
}
setInterval(() => { void isCtxValid(); }, 5000);

export function extractContent(el: Element): string {
  return extractMessageContent(el as HTMLElement);
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | undefined;
  return ((...args: any[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

/**
 * SPA navigation detection — watches for URL changes via history API and popstate.
 * Calls onNavigate(newUrl) when the URL changes, including on initial load.
 */
export function watchForSpaNavigation(onNavigate: (newUrl: string) => void): void {
  let lastUrl = window.location.href;

  // Call onNavigate with current URL on initial load
  onNavigate(lastUrl);

  // Override history.pushState to detect SPA navigation
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    const newUrl = window.location.href;
    if (newUrl !== lastUrl) {
      lastUrl = newUrl;
      onNavigate(newUrl);
    }
  };

  // Override history.replaceState to detect SPA navigation
  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    const newUrl = window.location.href;
    if (newUrl !== lastUrl) {
      lastUrl = newUrl;
      onNavigate(newUrl);
    }
  };

  // Listen for popstate events (back/forward navigation)
  window.addEventListener('popstate', () => {
    const newUrl = window.location.href;
    if (newUrl !== lastUrl) {
      lastUrl = newUrl;
      onNavigate(newUrl);
    }
  });
}

export function createObserver(
  selectorOrElement: string | Element | (() => string | Element),
  callback: () => void,
  debounceMs = 150,
  platform = "",
  // [PERF-C2] When false, the observer ignores characterData (text) mutations
  // and only reacts to childList/subtree changes. Streaming-heavy SPAs (Gemini's
  // Angular runtime) emit one characterData mutation per token, which re-triggered
  // a full scrape every debounce window and saturated the CPU. childList changes
  // still fire when message nodes are added/removed, so captures remain reliable.
  watchCharacterData = true
): MutationObserver {
  // Debounce so streaming AI responses (one DOM mutation per token) don't
  // call scrapeMessages on every individual token.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedCallback = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(callback, debounceMs);
  };

  const observer = new MutationObserver(debouncedCallback);

  // Tracks whether the 1 s grace-period retry has already been scheduled so
  // we don't queue it twice on rapid re-attach calls.
  let retryScheduled = false;

  function attach() {
    // Resolve getter — if selectorOrElement is a function, call it now so
    // _remoteSelectors has had time to load on the 1 s retry path.
    const resolved: string | Element =
      typeof selectorOrElement === "function" ? selectorOrElement() : selectorOrElement;

    if (typeof resolved !== "string") {
      // Element reference — observe directly; defer if body not yet ready.
      if (!resolved) {
        document.addEventListener("DOMContentLoaded", attach, { once: true });
        return;
      }
      observer.observe(resolved, { childList: true, subtree: true, characterData: watchCharacterData });
      return;
    }

    // String selector path — never silently fall back to document.body.
    const target = document.querySelector(resolved);
    if (!target) {
      if (document.readyState === "loading") {
        // DOM not yet ready — retry once it is.
        document.addEventListener("DOMContentLoaded", attach, { once: true });
        return;
      }
      if (!retryScheduled) {
        // First miss: _remoteSelectors may still be loading (async fetch).
        // Wait 1 s so the getter can return the remote value, then try once more.
        retryScheduled = true;
        setTimeout(attach, 1_000);
        return;
      }
      // [FIX] Removed SCRAPER_BROKEN alarm — self-healing deferred to v2.
      return;
    }

    observer.observe(target, { childList: true, subtree: true, characterData: watchCharacterData });
  }

  attach();
  return observer;
}

function getDebugSnippet(): string {
  const mainEl = document.querySelector('main, [role="main"]');
  if (mainEl) return mainEl.outerHTML.slice(0, 5000);
  return (document.body || document.documentElement).outerHTML.slice(0, 5000);

}

export function isAssistantStreaming(platform: string): boolean {
  try {
    switch (platform) {
      case "claude":
        return !!document.querySelector(
          '.streaming-indicator, [data-is-streaming="true"], .result-streaming'
        );
      case "chatgpt":
        return !!document.querySelector(
          '[data-testid="stop-button"], button[aria-label="Stop generating"]'
        );
      case "gemini":
        return !!document.querySelector(
          '.loading-indicator, [aria-label="Gemini is responding"]'
        );
      case "grok":
        return !!document.querySelector(
          '[data-streaming="true"], .streaming, ' +
          'button[aria-label*="Stop" i], button[data-testid*="stop"], ' +
          '[class*="streaming"], [class*="typing-indicator"]'
        );
      case "deepseek":
        return !!document.querySelector(
          '.ds-loading, [data-generating], ' +
          'button[aria-label*="Stop" i], [class*="stop-generating"], ' +
          '[class*="result-streaming"], [class*="generating"]'
        );
      case "perplexity":
        return !!document.querySelector(
          '.generating, [data-state="loading"], ' +
          'button[aria-label*="Stop" i], [class*="animate-pulse"]:not(nav *), ' +
          '[class*="streaming"], [data-is-streaming]'
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

export function defaultSessionTitle(messages: Message[]): string {
  const source =
    messages.find((message) => message.role === "user")?.content ??
    messages[0]?.content ??
    "Untitled session";

  return truncate(source.replace(/\s+/g, " ").trim(), 72);
}

/**
 * djb2 hash of a message array — fast, no dependencies.
 * Incorporates every message's role + content length + last 20 chars
 * so any edit (including to middle messages) changes the fingerprint.
 */
function hashMessages(messages: Message[]): string {
  const str = messages.map((m) =>
    m.role + m.content.length + m.content.slice(-20)
  ).join("|");
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // force 32-bit signed int
  }
  return hash.toString(36);
}

function maybeEmitScrollHint(platform: string, msgCount: number, scope: Element): void {
  // Only hint when the page actually has scrollable content worth capturing.
  // Threshold: page scroll height > 2× viewport height AND we got fewer than
  // 4 messages — strongly suggests virtual scroll didn't render older history.
  const pageScrollable = document.documentElement.scrollHeight > window.innerHeight * 2;
  const suspiciouslyLow = msgCount < 4;
  if (pageScrollable && suspiciouslyLow) {
    console.log(`[CM:${platform}] capture looks incomplete (${msgCount} msgs, page is scrollable) — emitting scroll hint`);
    try {
      chrome.runtime.sendMessage({
        type: 'CAPTURE_SCROLL_HINT',
        platform,
        msgCount,
        href: location.href,
      }, () => { void chrome.runtime.lastError; });
    } catch { /* SW asleep */ }
  }
}

export function startSessionCapture(config: {
  platform: string;
  selectorOrElement: string | Element | (() => string | Element);
  scrapeMessages: () => Message[];
  getTitle?: (messages: Message[]) => string;
  // Optional additional capture delays (ms after script load) layered on top
  // of the default schedule (immediate, 100, 500, 1000, 1500). Used by
  // platforms whose SPAs render messages later than the default window —
  // e.g. Claude's lazy virtual-scroll mount. The shrink-guard below prevents
  // a late partial scrape from clobbering an earlier complete capture.
  extraCaptureDelays?: number[];
  // When true, autoScrollBackToTop runs once at startup to force lazy-rendered
  // history into the DOM before the first scrape. Required for ChatGPT, Gemini,
  // Claude (long sessions), and DeepSeek which virtualise off-screen turns.
  requiresScrollBack?: boolean;
  // Lazy getter for the remote-config scrollContainer selector — evaluated when
  // autoScrollBackToTop runs so the async remote config has time to load.
  getScrollContainerSelector?: () => string | undefined;
  // Override the MutationObserver debounce (default 150 ms). Platforms that
  // render message shells before hydrating text (e.g. Gemini Angular) benefit
  // from a longer settle window so the scrape fires after text is populated.
  observerSettleMs?: number;
  // 'jump' (default): set scrollTop=0 once and wait for DOM settle.
  // 'step': scroll up in viewport-height chunks, dispatching scroll events
  // between each step — required for Angular CDK virtual scroll (Gemini).
  scrollBackStrategy?: 'jump' | 'step';
  // When true, instead of a single capture after scrolling to top, performs a
  // full top→bottom sweep via virtualScrollSweep(), collecting messages at every
  // scroll position and merging them. Required for Gemini's Angular CDK virtual
  // scroll which evicts off-screen messages from the DOM in both directions.
  useVirtualScrollSweep?: boolean;
  // [PERF-C2] When false, the MutationObserver ignores characterData (text)
  // mutations. Set false for streaming-heavy SPAs (Gemini) where per-token text
  // mutations would otherwise trigger a scrape every settle window.
  watchCharacterData?: boolean;
}) {
  // Guard against the content script being loaded twice in the same page.
  // This happens when the service worker re-injects on install/reload while
  // the manifest has ALREADY loaded the script natively. Two listeners both
  // returning true on INJECT_CONTEXT cause "message channel closed" errors.
  const flag = `__contextForge_${config.platform}_loaded` as const;
  const w = window as unknown as Record<string, boolean>;
  if (w[flag]) {
    console.log(`[ContextMover] ${config.platform} content script already active — skipping duplicate init`);
    return;
  }
  w[flag] = true;
  // [ISSUE-19] Also check chrome.storage.session for persistent injection guard
  // The main-world flag is lost when ISOLATED world context is invalidated, but
  // chrome.storage.session survives SW restarts within the browser session.
  const sessionGuardKey = `cm_injected_${config.platform}`;
  try {
    chrome.storage.session.get(sessionGuardKey).then((result) => {
      if (result[sessionGuardKey]) {
        console.debug(`[ContextMover] ${config.platform} injection guard found in session storage — already injected`);
      } else {
        chrome.storage.session.set({ [sessionGuardKey]: Date.now() }).catch(() => {});
      }
    }).catch(() => {});
  } catch { /* storage.session may be unavailable in some contexts */ }

  // PING handler: lets the service worker detect a live content script
  // BEFORE attempting to inject a duplicate.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "PING") {
      sendResponse({ ok: true, platform: config.platform });
      return; // sync response
    }
  });

  // DOM Probe handler: analyze current page DOM to discover selector candidates
  // for self-healing when platform DOM structure changes.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "RUN_DOM_PROBE") {
      try {
        const probeResult = runDOMProbe(config.platform);
        console.log(`[CM:${config.platform}] DOM probe completed: ${probeResult.candidates.length} candidates found`);
        sendResponse({ ok: true, probeResult });
      } catch (err) {
        console.error(`[CM:${config.platform}] DOM probe error:`, err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return; // async response
    }
  });

  let sessionId: string | null = null;
  let lastMessageHash = "";
  let lastSentMessageCount = 0;
  let lastSentMessages: Message[] = [];
  let lastHref = window.location.href;
  let _geminiLastUrl = ''; // [GEMINI-SPA-FIX] tracks last Gemini URL for SPA delay
  let lastUnchangedAt = 0;
  const UNCHANGED_COOLDOWN_MS = 5_000; // don't re-scrape if last result was unchanged < 5s ago

  // Zero-scrape retry gate — when scrape returns 0 after previously having messages,
  // retry 3× at 1 s intervals before clearing session state.
  let zeroScrapeRetries = 0;
  const MAX_ZERO_RETRIES = 3;
  let zeroRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let firstScrapeRetries = 0;
  const MAX_FIRST_SCRAPE_RETRIES = 5;

  // Double-capture guards:
  // captureInFlight — prevents concurrent executions of capture() overlapping on ensureSessionId().
  // lastSentAt / MIN_SEND_INTERVAL_MS — enforces minimum 1s between CAPTURE_SESSION sends
  //   for the same session (absorbs rapid setTimeout + load-event pairs).
  let captureInFlight = false;
  let lastSentAt = 0;
  const MIN_SEND_INTERVAL_MS = 1_000;

  // Diagnostic bridge — content-script console.log lines go to the PAGE console,
  // which is invisible from the SW console. diag() mirrors a short status line
  // to the SW so a developer can see capture decisions in one place.
  const diag = (reason: string) => {
    try {
      chrome.runtime.sendMessage(
        { type: "CM_DIAG", platform: config.platform, reason, href: location.href },
        () => { void chrome.runtime.lastError; }
      );
    } catch { /* SW asleep — page console still has the log */ }
  };
  diag("script-loaded");

  let pendingCaptureAfterStream = false;
  let pendingCaptureAfterScrollback = false; // [ISSUE-27]
  let streamPollId: ReturnType<typeof setInterval> | null = null;
  let isScrollbackInProgress = false;
  // [FIX] Deferred capture timer — when fetch-intercept gate suppresses DOM scrape,
  // schedule a fallback capture after the window expires to catch messages the
  // fetch interceptor may have missed (e.g. user continues an old conversation).
  let fetchBailDeferredTimer: ReturnType<typeof setTimeout> | null = null;
  // When set, the next ensureSessionId() call will force-mint a new random ID
  // even if the URL already has a mapping. Used for SPA "New chat" detection
  // where the URL doesn't change but the conversation does.
  let forceNewSession = false;

  // Async-resolve the session id via chrome.storage URL map.  Cached after the
  // first call; invalidated when the URL changes or when the service worker
  // broadcasts SESSION_FORGOTTEN (i.e. user deleted the session).
  async function ensureSessionId(): Promise<string> {
    if (sessionId && !forceNewSession) {
      console.log(`[ContextMover] ${config.platform}: using cached sessionId=${sessionId}`);
      return sessionId;
    }
    const href = window.location.href;
    
    // CRITICAL: For ChatGPT, skip capture if URL doesn't have /c/ conversation ID
    // This prevents multiple conversations from sharing the same sessionId during loading
    if (config.platform === 'chatgpt') {
      const hasConversationId = /\/c\/[a-zA-Z0-9-]+/.test(href);
      if (!hasConversationId) {
        console.log(`[ContextMover] ${config.platform}: SKIP capture - no conversation ID in URL yet (${href})`);
        return ''; // Return empty to signal skip
      }
    }
    
    const needsForce = forceNewSession;
    forceNewSession = false; // consume the flag
    sessionId = await resolveSessionId(
      config.platform as Platform,
      href,
      legacyChecker,
      needsForce
    );
    console.log(`[ContextMover] ${config.platform}: resolved sessionId=${sessionId} for URL=${href}${needsForce ? ' (forceNew)' : ''}`);
    return sessionId;
  }

  // Listen for forget broadcasts from the SW.  When the user (or web dashboard)
  // deletes a session matching ours, drop the cached id so the next capture
  // mints a brand-new session and re-extracts the full conversation.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "SESSION_FORGOTTEN") return;
    if (msg.sessionId && sessionId && msg.sessionId === sessionId) {
      console.log(
        `[ContextMover] ${config.platform}: received SESSION_FORGOTTEN for ${sessionId} — clearing cache, next capture will mint new id`
      );
      sessionId = null;
      lastMessageHash = "";
      lastSentMessageCount = 0;
    }
  });

  // Reduced from 60s → 30s. The previous window was too aggressive: a single
  // benign Claude API call (e.g. /sentry, /telemetry) that produced 0 captured
  // messages would still suppress all DOM scrapes for a full minute, leaving
  // sessions undetected. The new gate also requires count>0 — a fetch capture
  // with zero messages no longer blocks the DOM fallback.
  const FETCH_FALLBACK_WINDOW_MS = 10_000; // [FIX] Reduced from 30s — stale fetch capture was blocking DOM scraping of new messages for too long
  const capture = async () => {
    // Early exit: homepage/new-chat pages have no conversation to capture.
    // Skip the entire scrape pipeline to avoid CPU waste and log spam from
    // the MutationObserver firing on every SPA re-render.
    if (config.platform === 'chatgpt') {
      if (!/\/c\/[a-zA-Z0-9-]+/.test(window.location.href)) return;
    } else if (config.platform === 'claude') {
      if (!/\/chat\//.test(window.location.href)) return;
    } else if (config.platform === 'grok') {
      if (!/grok\.com\/(chat|conversation|c)\/[a-zA-Z0-9-]+/.test(window.location.href)) return;
    } else if (config.platform === 'perplexity') {
      if (!/\/search\//.test(window.location.href)) return;
    } else if (config.platform === 'gemini') {
      if (!/\/app\/[a-zA-Z0-9-]+/.test(window.location.href)) return;
    } else if (config.platform === 'deepseek') {
      if (!/chat\.deepseek\.com\/(a\/chat\/s|chat)\/[a-zA-Z0-9-]+/.test(window.location.href)) return;
    }

    // Re-resolve session ID on SPA navigation (e.g. Claude pushState from
    // /new → /chat/abc123 when a conversation starts, or Perplexity navigating
    // to a new conversation URL).
    const currentHref = window.location.href;
    if (currentHref !== lastHref) {
      lastHref = currentHref;
      // Always clear sessionId on URL change so the next capture resolves a fresh
      // session ID from the URL map. This ensures each unique conversation URL
      // gets its own session, preventing multiple conversations from merging.
      // The URL→sessionId mapping in session-id.ts handles the deduplication:
      // if we revisit the same URL, we'll get the same sessionId back.
      sessionId = null;
      lastMessageHash = "";
      lastSentMessageCount = 0; // [FIX] Reset on URL change — otherwise navigating from a 58-msg conversation to a 19-msg one triggers false virtual-scroll suppression
      lastSentMessages = [];
      // Always reset the retry counter on any navigation.
      zeroScrapeRetries = 0;
      firstScrapeRetries = 0;
      if (zeroRetryTimer !== null) { clearTimeout(zeroRetryTimer); zeroRetryTimer = null; }
      // [FIX] Clear stale fetch-intercept flag so DOM scraping runs immediately for the new conversation
      try { (window as unknown as { __contextForgeFetchCaptured?: { at: number; count: number } }).__contextForgeFetchCaptured = undefined; } catch { /* ignore */ }
      if (fetchBailDeferredTimer) { clearTimeout(fetchBailDeferredTimer); fetchBailDeferredTimer = null; }
      console.log(`[ContextMover] URL changed — re-resolving sessionId`);
    }

    // ── Fetch-intercept fallback gate ──────────────────────────────────
    // Skip the DOM scrape ONLY when the MAIN-world fetch interceptor produced
    // a non-empty capture within the last FETCH_FALLBACK_WINDOW_MS. A capture
    // with count==0 (or no flag at all) does NOT suppress the DOM fallback —
    // empty fetch captures previously caused Claude sessions to vanish.
    const fc = (window as unknown as { __contextForgeFetchCaptured?: { at: number; count: number } })
      .__contextForgeFetchCaptured;
    const hasFreshCapture = fc && fc.count > 0 && (Date.now() - fc.at) < FETCH_FALLBACK_WINDOW_MS;
    if (hasFreshCapture) {
      console.log(
        `[ContextMover] ${config.platform}: fetch-intercept active (count=${fc!.count}, age=${Date.now() - fc!.at}ms), skipping DOM scrape`
      );
      diag(`bail: fetch-intercept active (count=${fc!.count})`);
      // [FIX] Schedule a deferred capture after the fetch window expires so DOM
      // scraping catches any messages the fetch interceptor missed.
      if (!fetchBailDeferredTimer) {
        const remaining = FETCH_FALLBACK_WINDOW_MS - (Date.now() - fc!.at) + 500;
        fetchBailDeferredTimer = setTimeout(() => {
          fetchBailDeferredTimer = null;
          void capture();
        }, Math.max(remaining, 500));
      }
      return;
    }

    // [SPA-COOLDOWN-FIX] Reset unchanged cooldown on SPA navigation — a new
    // conversation URL means the old cooldown no longer applies. Without this,
    // a 0-message scrape on the old page suppresses the first scrape on the new
    // page for up to 5s, delaying capture of the new conversation.
    if (config.platform === 'gemini' && window.location.href !== _geminiLastUrl && lastUnchangedAt > 0) {
      lastUnchangedAt = 0;
    }

    // If the last scrape found no change, suppress re-scrape for UNCHANGED_COOLDOWN_MS.
    if (lastUnchangedAt > 0 && Date.now() - lastUnchangedAt < UNCHANGED_COOLDOWN_MS) {
      return;
    }

    // Skip capture while the assistant is actively streaming — schedule a
    // deferred capture for when streaming finishes instead.
    if (isAssistantStreaming(config.platform)) {
      diag("bail: assistant streaming");
      pendingCaptureAfterStream = true;
      if (!streamPollId) {
        const pollStart = Date.now();
        streamPollId = setInterval(() => {
          // 60-second hard cap — run capture anyway to avoid dropping context.
          if (Date.now() - pollStart > 60_000) {
            clearInterval(streamPollId!);
            streamPollId = null;
            pendingCaptureAfterStream = false;
            void capture();
            return;
          }
          if (!isAssistantStreaming(config.platform) && pendingCaptureAfterStream) {
            clearInterval(streamPollId!);
            streamPollId = null;
            // Wait 500ms for the DOM to settle after streaming ends.
            setTimeout(() => {
              pendingCaptureAfterStream = false;
              void capture();
            }, 500);
          }
        }, 500);
      }
      return;
    }

    // [ISSUE-27] Don't skip captures during scrollback — queue them instead
    // The scrollback will send the authoritative full-history capture, but
    // if new messages arrive during scrollback, we should still capture them
    if (isScrollbackInProgress) {
      console.debug(`[ContextMover] ${config.platform}: Deferring capture during scrollback — will run after`);
      pendingCaptureAfterScrollback = true;
      return;
    }

    // Prevent concurrent capture executions — if ensureSessionId() is still
    // awaiting from a previous call, skip rather than sending a duplicate.
    if (captureInFlight) {
      console.log(`[ContextMover] ${config.platform}: capture already in flight, skipping`);
      diag("bail: capture in flight");
      return;
    }
    if (!isCtxValid()) return;

    // [GEMINI-SPA-FIX] Gemini SPA navigation takes time for Angular to re-render.
    // Delay before setting captureInFlight so concurrent captures aren't blocked.
    if (config.platform === 'gemini' && window.location.href !== _geminiLastUrl) {
      _geminiLastUrl = window.location.href;
      console.log('[ContextMover] Gemini SPA — delaying first scrape by 1.5s');
      await new Promise<void>(r => setTimeout(r, 1500));
    }

    captureInFlight = true;
    try {

    console.log(`[ContextMover] Capture triggered for ${config.platform} (DOM fallback)`);
    let messages = config.scrapeMessages();
    diag(`scraped: total=${messages.length} user=${messages.filter(m=>m.role==='user').length} asst=${messages.filter(m=>m.role==='assistant').length}`);
    if (!messages.length) {
      // If we previously captured messages, don't immediately abandon — the
      // DOM may not have re-rendered yet (SPA navigation, lazy hydration).
      // Retry up to MAX_ZERO_RETRIES × 1 s before treating as truly empty.
      if (lastSentMessageCount > 0 && zeroScrapeRetries < MAX_ZERO_RETRIES) {
        zeroScrapeRetries++;
        console.log(`[ContextMover] ${config.platform}: 0 messages after ${lastSentMessageCount} — retry ${zeroScrapeRetries}/${MAX_ZERO_RETRIES}`);
        diag(`zero-scrape retry ${zeroScrapeRetries}/${MAX_ZERO_RETRIES}`);
        if (zeroRetryTimer !== null) clearTimeout(zeroRetryTimer);
        zeroRetryTimer = setTimeout(() => { zeroRetryTimer = null; void capture(); }, 1_000);
        return;
      }
      // [FIX] Removed SCRAPER_BROKEN alarm — self-healing will be implemented in v2.
      // NEW SESSION: if we've never sent messages (lastSentMessageCount === 0),
      // this is a brand new conversation. Don't report as error — just wait for
      // the user to send a message. The MutationObserver will trigger capture
      // once the first message appears in the DOM.
      if (lastSentMessageCount === 0) {
        if (firstScrapeRetries < MAX_FIRST_SCRAPE_RETRIES) {
          firstScrapeRetries++;
          console.log(`[ContextMover] ${config.platform}: 0 msgs on open — retry ${firstScrapeRetries}/${MAX_FIRST_SCRAPE_RETRIES} (DOM hydrating)`);
          if (zeroRetryTimer !== null) clearTimeout(zeroRetryTimer);
          zeroRetryTimer = setTimeout(() => { zeroRetryTimer = null; void capture(); }, 1_500);
          return;
        }
        console.log(`[ContextMover] ${config.platform}: New empty session — waiting for first message`);
        lastUnchangedAt = Date.now();
        diag("bail: new empty session");
        return;
      }
      zeroScrapeRetries = 0;
      lastUnchangedAt = Date.now();
      console.log(`[ContextMover] No messages found, skipping capture`);
      diag("bail: 0 messages from scrape");
      return;
    }
    // Non-zero scrape — reset the retry counters.
    zeroScrapeRetries = 0;
    firstScrapeRetries = 0;
    if (zeroRetryTimer !== null) { clearTimeout(zeroRetryTimer); zeroRetryTimer = null; }

    // Skip transient states: user just sent a message, assistant still
    // generating (or still has [data-is-streaming]). Persisting user-only
    // snapshots produces noisy "assistant missing" errors downstream and
    // pollutes the session list with half-captures.
    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    if (assistantCount === 0) {
      console.log(
        `[ContextMover] Skipping capture — ${messages.length} user-only messages (awaiting assistant response)`
      );
      diag(`bail: 0 assistant messages (${messages.length} user-only)`);
      return;
    }

    const title =
      config.getTitle?.(messages) ??
      defaultSessionTitle(messages);

    // djb2 hash of all messages — catches edits anywhere in the conversation,
    // not just appends. Only skip if the ENTIRE message array is identical.
    const newHash = hashMessages(messages);
    if (newHash === lastMessageHash) {
      lastUnchangedAt = Date.now();
      console.log(`[ContextMover] Snapshot hash unchanged, skipping`);
      return;
    }
    lastUnchangedAt = 0; // new content — allow immediate re-scrapes
    // NOTE: intentionally NOT committing newHash yet.
    // If we bail on the time-gate below, the next MutationObserver fire
    // will re-check and retry since lastMessageHash is still the old value.

    // Guard against virtual scroll shrinkage: if the current DOM scrape found
    // significantly fewer messages than we last successfully sent, the difference
    // is almost certainly virtual scroll evicting old messages from the DOM, not
    // real deletion. Suppress the send and keep the existing stored snapshot intact.
    // Allow minor fluctuations (<25% decrease) to handle normal DOM volatility.
    // EXCEPTION: If hash changed AND count dropped to near-zero, this is a NEW
    // conversation (user clicked "New chat" in SPA). Clear sessionId to mint fresh.
    const isSignificantShrink = messages.length < lastSentMessageCount * 0.75;
    const isNearEmpty = messages.length <= 2;
    const hadPreviousMessages = lastSentMessageCount > 3;
    if (isSignificantShrink) {
      if (newHash !== lastMessageHash && isNearEmpty && hadPreviousMessages) {
        // SPA "New chat" detected — conversation cleared but URL didn't change
        console.log(
          `[ContextMover] ${config.platform}: NEW CONVERSATION detected ` +
          `(${lastSentMessageCount}\u2192${messages.length}) — clearing sessionId for fresh capture`
        );
        sessionId = null;
        forceNewSession = true; // force-mint a new ID even though URL is the same
        lastMessageHash = "";
        lastSentMessageCount = 0;
        firstScrapeRetries = 0;
        lastSentMessages = [];
        // Continue to capture this as a new session
      } else {
        console.log(
          `[ContextMover] ${config.platform}: partial scrape detected ` +
          `(${lastSentMessageCount}\u2192${messages.length}) — merging with existing snapshot`
        );
        messages = mergePartialScrape(lastSentMessages, messages);
      }
    }

    const resolvedId = await ensureSessionId();
    if (!resolvedId) {
      console.log(`[ContextMover] ${config.platform}: capture skipped - no valid sessionId`);
      return;
    }

    // Minimum 1s between sends for the same session.
    // Guards against setTimeout(capture,1000) + load event firing simultaneously.
    const now = Date.now();
    if (now - lastSentAt < MIN_SEND_INTERVAL_MS) {
      console.log(
        `[ContextMover:capture] Skipped duplicate for ${resolvedId}` +
        ` (hash changed but ${now - lastSentAt}ms since last send)`
      );
      return;
    }
    // Commit hash + timestamp only after deciding to send.
    lastMessageHash = newHash;
    lastSentAt = now;
    lastSentMessageCount = messages.length;
    lastSentMessages = [...messages];
    diag(`sending CAPTURE_SESSION sessionId=${resolvedId} count=${messages.length}`);
    try {
      chrome.runtime.sendMessage(
        {
          type: "CAPTURE_SESSION",
          payload: {
            platform: config.platform,
            sessionId: resolvedId,
            title,
            messages,
          },
        },
        () => { void chrome.runtime.lastError; }
      );
    } catch { /* Extension context invalidated */ }
    } finally {
      captureInFlight = false;
    }
  };

  const captureWithMessages = async (messages: Message[]) => {
    if (captureInFlight) return;
    if (messages.length === 0) return;
    if (!isCtxValid()) return;
    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    if (assistantCount === 0) return;
    captureInFlight = true;
    try {
      const resolvedId = await ensureSessionId();
      if (!resolvedId) {
        console.log(`[ContextMover] ${config.platform}: captureWithMessages skipped - no valid sessionId`);
        return;
      }
      const title = config.getTitle?.(messages) ?? defaultSessionTitle(messages);
      const newHash = hashMessages(messages);
      if (newHash === lastMessageHash) return;
      const now = Date.now();
      if (now - lastSentAt < MIN_SEND_INTERVAL_MS) return;
      lastMessageHash = newHash;
      lastSentAt = now;
      lastSentMessageCount = messages.length;
      lastSentMessages = [...messages];
      try {
        chrome.runtime.sendMessage(
          { type: "CAPTURE_SESSION", payload: { platform: config.platform, sessionId: resolvedId, title, messages } },
          () => { void chrome.runtime.lastError; }
        );
      } catch { /* Extension context invalidated */ }
    } finally {
      captureInFlight = false;
    }
  };

  // Handle explicit capture trigger from the service worker.
  // Sent ~1.5s after onInstalled re-injects scripts into already-open tabs
  // so that an already-rendered conversation is captured without user interaction.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "TRIGGER_CAPTURE") {
      void capture();
      sendResponse({ ok: true });
      return;
    }
  });

  createObserver(config.selectorOrElement, capture, config.observerSettleMs, config.platform, config.watchCharacterData ?? true);

  // Staggered initial captures — catches lazy-rendered messages at each stage.
  void capture();
  setTimeout(capture, 100);
  setTimeout(capture, 500);
  setTimeout(capture, 1000);
  setTimeout(capture, 1500);
  // Platform-specific late captures (e.g. Claude SPA renders at 2–6s).
  // [PERF-H1] Filter out delays that duplicate the default schedule above
  // (e.g. Gemini previously listed 1500 in extraCaptureDelays, firing 2 scrapes
  // at 1.5s). De-duped so each timestamp scrapes at most once.
  if (config.extraCaptureDelays?.length) {
    const _defaultDelays = new Set([0, 100, 500, 1000, 1500]);
    for (const d of new Set(config.extraCaptureDelays)) {
      if (_defaultDelays.has(d)) continue;
      setTimeout(capture, d);
    }
  }

  // 4A — scroll-back loader: for platforms that virtualise off-screen turns,
  // scroll the conversation container to the top and wait for the SPA to
  // hydrate all lazy-rendered history before running an additional capture.
  // Runs ONCE at init, in parallel with the staggered schedule above.
  // The shrink-guard ensures this authoritative full-history capture wins over
  // any partial viewport captures that may have already been sent.
  if (config.requiresScrollBack) {
    ;(async () => {
      const _resolvedSO = typeof config.selectorOrElement === 'function'
        ? config.selectorOrElement()
        : config.selectorOrElement;
      const scopeEl: Element =
        typeof _resolvedSO === 'string'
          ? (document.querySelector(_resolvedSO) ?? document.body ?? document.documentElement)
          : _resolvedSO
      try {
        isScrollbackInProgress = true;
        if (config.useVirtualScrollSweep) {
          if (isAssistantStreaming(config.platform)) {
          isScrollbackInProgress = false;
          // [ISSUE-28] Retry scrollback after streaming settles — don't just skip
          console.log(`[CM:${config.platform}] scrollback: streaming detected — retrying in 3s`);
          setTimeout(async () => {
            if (!isAssistantStreaming(config.platform)) {
              console.log(`[CM:${config.platform}] scrollback: streaming settled — retrying sweep`);
              isScrollbackInProgress = true;
              try {
                const swept = await virtualScrollSweep(scopeEl, config.scrapeMessages, config.getScrollContainerSelector);
                isScrollbackInProgress = false;
                if (swept.length > 0) await captureWithMessages(swept);
                if (pendingCaptureAfterScrollback) { pendingCaptureAfterScrollback = false; void capture(); }
              } catch (e) {
                isScrollbackInProgress = false;
                console.warn(`[CM:${config.platform}] scrollback retry failed:`, e);
              }
            } else {
              // Still streaming — schedule one more retry
              setTimeout(() => void capture(), 800);
            }
          }, 3000);
          return;
        }
          console.log(`[CM:${config.platform}] scrollback: virtual-scroll sweep starting`)
          let swept: Message[] = [];
          for (let attempt = 0; attempt < 3 && swept.length === 0; attempt++) {
            if (attempt > 0) await sleep(2000);
            swept = await virtualScrollSweep(scopeEl, config.scrapeMessages, config.getScrollContainerSelector)
          }
          console.log(`[CM:${config.platform}] scrollback: sweep done — ${swept.length} msgs accumulated`)
          isScrollbackInProgress = false;
          if (swept.length > 0) {
            await captureWithMessages(swept)
          }
          // If sweep found very few messages despite the page having content,
          // the virtual scroll may have changed its DOM structure — hint user to scroll.
          maybeEmitScrollHint(config.platform, swept.length, scopeEl)
          setTimeout(() => void capture(), 800)
        } else {
          // Wait for DOM to hydrate before scrolling — React/Vue SPAs render
          // messages asynchronously. Without this, autoScrollBackToTop returns
          // immediately (scrollTop===0 on fresh load) and capture finds nothing.
          const _waitStart = Date.now();
          while (config.scrapeMessages().length === 0 && Date.now() - _waitStart < 8_000) {
            await sleep(500);
          }
          console.log(`[CM:${config.platform}] scrollback: starting — loading lazy history`)
          const restore = await autoScrollBackToTop(scopeEl, config.getScrollContainerSelector, config.scrollBackStrategy)
          console.log(`[CM:${config.platform}] scrollback: DOM settled — running full capture`)
          isScrollbackInProgress = false;
          await capture()
          restore()
          maybeEmitScrollHint(config.platform, lastSentMessageCount, scopeEl)
          // [ISSUE-27] Run any capture that was deferred during scrollback
          if (pendingCaptureAfterScrollback) { pendingCaptureAfterScrollback = false; }
          setTimeout(() => void capture(), 800)
        }
      } catch (err) {
        isScrollbackInProgress = false;
        console.warn(`[CM:${config.platform}] scrollback failed:`, err)
      }
    })()
  }
  window.addEventListener("load", capture, { once: true });

  // Re-scrape when tab becomes active (covers switching back to an AI tab)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      setTimeout(() => void capture(), 300);
    }
  });

  // Back/forward navigation in SPAs
  window.addEventListener("popstate", () => setTimeout(capture, 500));

  // Virtual scroll — re-scrape when user scrolls to load lazy history.
  // [PERF-H3] Debounce raised 800→1200ms and streaming guard added. Auto-scroll
  // during streaming fires continuous scroll events; capturing on each one
  // compounds observer load. Skip while the assistant is still streaming — the
  // MutationObserver will catch the final state once streaming ends.
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  // [ISSUE-25] Track SW response time for adaptive backpressure
  let _lastCaptureRTT = 0;
  let _observerDebounce = 2000;
  window.addEventListener("scroll", () => {
    // [ISSUE-30] Skip captures during programmatic scrollback
    if (isScrollbackInProgress) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (isAssistantStreaming(config.platform)) return;
      const t0 = performance.now();
      void capture().finally(() => {
        _lastCaptureRTT = performance.now() - t0;
        // [ISSUE-25] If SW is slow (>500ms), increase debounce to reduce pressure
        if (_lastCaptureRTT > 500) _observerDebounce = 5000;
        else if (_lastCaptureRTT < 200) _observerDebounce = 2000;
      });
    }, _observerDebounce);
  }, { passive: true });

  // SPA pushState navigation detection (history.pushState doesn't fire popstate).
  // [PERF-C1] Previously a document-wide MutationObserver fired on EVERY DOM
  // mutation just to compare location.href — on Gemini's Angular runtime this
  // fired thousands of times/sec during streaming and froze the page. Replaced
  // with a zero-cost history.pushState/replaceState override (no DOM observation).
  // watchForSpaNavigation also fires once immediately for the current URL; we
  // ignore that initial call since the staggered captures above already cover it.
  let _spaNavInitial = true;
  watchForSpaNavigation(() => {
    if (_spaNavInitial) { _spaNavInitial = false; return; }
    setTimeout(capture, 800);
    setTimeout(capture, 1500);
  });

  // bfcache restore detection — when user navigates back/forward and page loads from cache
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      // Page was restored from bfcache — trigger capture after 1s delay
      setTimeout(() => void capture(), 1000);
    }
  });
}

const CF_CHROME_SELECTORS = [
  "button",
  "svg",
  '[role="button"]',
  '[role="toolbar"]',
  // NOTE: [role="group"] intentionally omitted — Claude wraps response content
  // in role="group" divs; removing it strips the entire assistant message body.
  "[data-testid*=copy]",
  "[data-testid*=action]",
  "[data-testid*=retry]",
  "[data-testid*=thumbs]",
  "[data-testid*=feedback]",
  "[class*=tooltip]",
].join(", ");

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer",
  "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "tr", "pre", "hr", "br",
]);

function getTextContent(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === "script" || tag === "style") return "";
  if (tag === "br") return "\n";
  const children = Array.from(el.childNodes).map(getTextContent).join("");
  return BLOCK_TAGS.has(tag) ? `\n${children}\n` : children;
}

export function extractMessageContent(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;

  // Convert <pre><code> blocks to fenced markdown text nodes FIRST so language
  // tags are preserved after we strip the element tree.
  //
  // Language detection — try in priority order, since different platforms
  // store the lang in different places:
  //   1. <code class="language-xxx">                — ChatGPT, Gemini, generic
  //   2. <pre data-language="xxx"> / <code data-…>  — Claude
  //   3. Header sibling text (e.g. "typescript")    — ChatGPT renders the
  //      language in a small UI chrome bar above the <pre>; the chrome is
  //      stripped before we reach this code, but on the original clone we
  //      can still look at the parent for a preceding header element.
  clone.querySelectorAll<HTMLElement>("pre").forEach((pre) => {
    const codeEl = pre.querySelector("code");
    let lang = (codeEl?.className ?? "").match(/language-([\w-]+)/)?.[1] ?? "";
    if (!lang) {
      lang =
        pre.getAttribute("data-language") ??
        codeEl?.getAttribute("data-language") ??
        "";
    }
    if (!lang) {
      // Look at a previous-sibling header (ChatGPT shows lang in a div above).
      // Only accept short alphanumeric tokens — avoid swallowing prose.
      const prev = pre.previousElementSibling as HTMLElement | null;
      const headerText = prev?.textContent?.trim() ?? "";
      if (/^[a-z][\w-]{0,15}$/i.test(headerText)) {
        lang = headerText.toLowerCase();
      }
    }
    const code = (codeEl ?? pre).textContent?.trim() ?? "";
    const textNode = document.createTextNode(`\n\`\`\`${lang}\n${code}\n\`\`\`\n`);
    pre.replaceWith(textNode);
  });

  // Strip UI chrome — buttons, icon SVGs, toolbars, tooltips
  clone.querySelectorAll<Element>(CF_CHROME_SELECTORS).forEach((n) => n.remove());

  // Use tree-walker–based extraction so it works on detached nodes (innerText
  // requires layout, which Chrome may not compute for detached clones).
  return getTextContent(clone).replace(/\n{3,}/g, "\n\n").trim();
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

// Polls ALL selectors simultaneously every 100ms and returns the first match.
// Much faster than calling waitForElement() sequentially (no 1-s-per-selector wait).
export async function waitForAnyElement<T extends Element>(
  selectors: string[],
  timeoutMs = 4000
): Promise<T | null> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    for (const selector of selectors) {
      const el = document.querySelector<T>(selector);
      if (el) return el;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }

  return null;
}

// ── Capture pipeline wrapper ─────────────────────────────────────────────────
// Wraps any scrapeMessages fn with: validate → structural fallback → health record.
// Fire-and-forget for health (async storage write); scrapeMessages stays sync.
export function runCapturePipeline(
  platform: string,
  rawScrape: () => Message[]
): Message[] {
  let messages: Message[] = [];
  let detectionMethod: "registry" | "structural" | "failed" = "registry";

  try {
    messages = rawScrape();
  } catch (e) {
    console.error(`[CM:${platform}] scrapeMessages threw:`, e);
    detectionMethod = "failed";
  }

  const validation = validateCapture(messages, platform, detectionMethod);

  // Structural fallback — only when registry strategies returned 0 assistant messages
  // and the page has meaningful content (avoids false structural captures on blank pages).
  if (
    (validation.errors.length > 0 || validation.stats.assistant === 0) &&
    messages.length === 0 &&
    document.querySelector('main, [role="main"], [class*="message"], [class*="conversation"]')
  ) {
    console.debug(`[CM:${platform}] Registry strategies empty — trying structural detection`);
    const structural = detectByStructure(platform);
    if (structural.length > 0 && structural.some((m) => m.role === "assistant")) {
      messages = structural;
      detectionMethod = "structural";
    }
  }

  const finalValidation = validateCapture(messages, platform, detectionMethod);

  // Record health — fire-and-forget, never blocks the sync return.
  // Skip zero-message captures: they happen before the page renders (pre-DOM),
  // not because selectors are broken, and would poison the health window.
  if (messages.length > 0) {
    void healthMonitor.record({
      platform,
      timestamp: Date.now(),
      success: finalValidation.valid,
      userCount: finalValidation.stats.user,
      assistantCount: finalValidation.stats.assistant,
      detectionMethod,
      errors: finalValidation.errors,
    });
  }

  return messages;
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export async function autoScrollBackToTop(
  scope: Element,
  getScrollContainerSelector?: () => string | undefined,
  strategy: 'jump' | 'step' = 'jump'
): Promise<() => void> {
  const SETTLE_MS = 800
  const HARD_CAP_MS = 30_000

  let container: Element | null = null

  const remoteSel = getScrollContainerSelector?.()
  if (remoteSel) {
    container = document.querySelector(remoteSel)
  }

  if (!container) {
    for (const child of Array.from(scope.children)) {
      const cs = getComputedStyle(child)
      if (
        (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
        child.scrollHeight > child.clientHeight + 4
      ) {
        container = child
        break
      }
    }
  }

  if (!container) {
    let el: Element | null = scope.parentElement
    while (el && el !== document.documentElement) {
      const cs = getComputedStyle(el)
      if (
        (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 4
      ) {
        container = el
        break
      }
      el = el.parentElement
    }
  }

  if (!container) container = document.documentElement

  const target = container

  const originalScrollTop = container.scrollTop
  // [ISSUE-29] Don't early-return at scrollTop===0 — content may not have loaded yet.
  // Wait briefly for DOM to populate; if scrollHeight grows, we need to stay and let
  // the MutationObserver settle. Only skip if the container is truly empty/static.
  if (originalScrollTop === 0) {
    const initialChildCount = target.children.length;
    await sleep(500);
    if (target.scrollTop === 0 && target.children.length === initialChildCount) {
      return () => { /* already at top — no content loaded */ }
    }
  }

  if (strategy === 'step') {
    const stepPx = Math.max(400, (target instanceof HTMLElement ? target.clientHeight : 600))
    const maxSteps = Math.ceil(HARD_CAP_MS / 400)
    for (let i = 0; i < maxSteps && target.scrollTop > 0; i++) {
      const prev = target.scrollTop
      target.scrollTop = Math.max(0, target.scrollTop - stepPx)
      target.dispatchEvent(new Event('scroll', { bubbles: true }))
      await sleep(400)
      if (target.scrollTop === prev) break
    }
    await sleep(SETTLE_MS)
    return () => { target.scrollTop = originalScrollTop }
  }

  await new Promise<void>((resolve) => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const done = () => {
      obs.disconnect()
      clearTimeout(hardCapTimer)
      if (settleTimer) clearTimeout(settleTimer)
      resolve()
    }
    const hardCapTimer = setTimeout(done, HARD_CAP_MS)
    const resetSettle = () => {
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(done, SETTLE_MS)
    }
    const obs = new MutationObserver(resetSettle)
    obs.observe(target, { childList: true, subtree: true })
    target.scrollTop = 0
    resetSettle()
  })

  return () => { target.scrollTop = originalScrollTop }
}

export async function virtualScrollSweep(
  scope: Element,
  scrape: () => Message[],
  getScrollContainerSelector?: () => string | undefined,
  stepWaitMs = 350,
): Promise<Message[]> {
  const HARD_CAP_MS = 20_000;
  const start = Date.now();

  // Wait for the DOM to hydrate before sweeping — Angular SPAs (Gemini) render
  // messages asynchronously. Without this, the sweep starts on an empty DOM,
  // finds 0 messages, and exits immediately, missing the entire conversation.
  const contentStart = Date.now();
  while (scrape().length === 0 && Date.now() - contentStart < 8_000) {
    await sleep(500);
  }

  let container: Element | null = null;
  const remoteSel = getScrollContainerSelector?.();
  if (remoteSel) container = document.querySelector(remoteSel);
  if (!container) {
    for (const child of Array.from(scope.children)) {
      const cs = getComputedStyle(child);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && child.scrollHeight > child.clientHeight + 4) { container = child; break; }
    }
  }
  if (!container) {
    let el: Element | null = scope.parentElement;
    while (el && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) { container = el; break; }
      el = el.parentElement;
    }
  }
  if (!container) container = document.documentElement;
  const tgt = container as HTMLElement;
  const origTop = tgt.scrollTop;
  const stepPx = Math.max(400, tgt.clientHeight || 600);
  tgt.scrollTop = 0;
  tgt.dispatchEvent(new Event('scroll', { bubbles: true }));
  await sleep(600);
  const seen = new Set<string>();
  const all: Message[] = [];
  const collect = () => {
    for (const m of scrape()) {
      const key = m.role + '|' + (m.content ?? '').slice(0, 120);
      if (!seen.has(key)) { seen.add(key); all.push(m); }
    }
  };
  collect();
  while (tgt.scrollTop < tgt.scrollHeight - tgt.clientHeight - 4) {
    if (Date.now() - start > HARD_CAP_MS) break;
    if (document.hidden) break;
    tgt.scrollTop += stepPx;
    tgt.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(stepWaitMs);
    collect();
  }
  collect();
  tgt.scrollTop = origTop;
  // [ISSUE-26] Fallback: if virtual scroll sweep found 0 messages, try a direct scrape
  // This handles cases where the virtual scroll container evicts all messages or
  // the DOM structure doesn't support programmatic scrolling
  if (all.length === 0) {
    console.warn('[CM:scrollback] virtualScrollSweep found 0 messages — trying direct scrape fallback');
    const directScrape = scrape();
    if (directScrape.length > 0) {
      console.log(`[CM:scrollback] fallback scrape found ${directScrape.length} messages`);
      return directScrape;
    }
    // Last resort: try structural detection
    try {
      const { detectByStructure } = await import('../lib/capture/structural-detector');
      const structural = detectByStructure('auto');
      if (structural.length > 0) {
        console.log(`[CM:scrollback] structural fallback found ${structural.length} messages`);
        return structural;
      }
    } catch { /* structural detector may not be available */ }
  }
  return all;
}

/**
 * Retries setPromptInputValue up to maxAttempts times with exponential backoff.
 * Verifies success by checking that the first 50 chars of text landed in the input.
 * Falls back to navigator.clipboard on total failure and notifies the sidebar.
 */
// Hard cap on inject size — prevents pathological inputs from crashing tabs.
// Raised from 30k → 200k after the >5k ClipboardEvent fast path was added
// (single bulk-paste transaction instead of per-char insertText). All major
// editors (ProseMirror / Lexical / Quill / native textarea) accept 200k via
// the paste path on minimal hardware in <2s. Aligned with service-worker
// PLATFORM_MAX_CHARS so the user gets the full context they asked for.
const INJECT_HARD_CAP = 200_000;

export async function injectWithRetry(
  input: HTMLElement | HTMLTextAreaElement,
  text: string,
  platform: string,
  maxAttempts = 3,
  delayMs = 300
): Promise<boolean> {
  if (text.length > INJECT_HARD_CAP) {
    const dropped = text.length - INJECT_HARD_CAP;
    console.warn(`[ContextMover:inject] Prompt too large (${text.length} chars) — truncating to ${INJECT_HARD_CAP} (dropped ${dropped} chars)`);
    text = text.slice(0, INJECT_HARD_CAP) + `\n\n... [ContextMover: ${dropped} chars trimmed — use Tier 1 for full context]`;
  }
  let currentDelay = delayMs;
  const first50 = text.slice(0, 50);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ok = setPromptInputValue(input, text);
    // React / ProseMirror / Angular commit DOM updates asynchronously after
    // processing synthetic events.  Reading textContent synchronously returns
    // stale content from the previous injection, producing a false negative.
    // 150 ms gives every known AI-chat editor one or more render cycles to flush.
    await sleep(150);
    const content =
      input instanceof HTMLTextAreaElement ? input.value : (input.textContent ?? '');
    if (content.includes(first50)) return true;
    if (attempt < maxAttempts) {
      console.warn(`[ContextMover] Inject attempt ${attempt} failed (${platform}), retrying in ${currentDelay}ms...`);
      await sleep(currentDelay);
      currentDelay = Math.floor(currentDelay * 1.5); // 300 → 450 → 675ms
    }
  }
  // All attempts failed — write to clipboard as last resort.
  try {
    if (!document.hasFocus()) window.focus();
    await navigator.clipboard.writeText(text);
    chrome.runtime.sendMessage({
      type: 'CM_NOTIFICATION',
      message: 'Context copied to clipboard — paste manually with Ctrl+V',
    }).catch(() => {});
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      chrome.runtime.sendMessage({ type: 'CM_NOTIFICATION', message: 'Context copied — paste with Ctrl+V' }).catch(() => {});
    } catch { /* clipboard entirely unavailable */ }
  }
  return false;
}

export function setPromptInputValue(
  input: HTMLElement | HTMLTextAreaElement,
  text: string
): boolean {
  input.focus();

  // ── Standard <textarea> ──────────────────────────────────────────────────
  if (input instanceof HTMLTextAreaElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    nativeSetter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.value === text;
  }

  // ── ContentEditable (ProseMirror / React 18 / Quill / Angular) ───────────
  // IMPORTANT: execCommand('delete') desynchronises React 18's fiber state
  // from the DOM, causing the subsequent insertText to be ignored.  Using
  // selectAll → insertText is the correct sequence: it fires the right
  // beforeinput / input events in a single atomic operation that all major
  // AI chat editors (Claude ProseMirror, ChatGPT React, Gemini Angular,
  // Grok React) correctly intercept and apply to their internal models.
  if (input.isContentEditable) {
    // ── Strategy 0: beforeinput event (Lexical editors — Perplexity) ──────────
    // Lexical intercepts beforeinput events and processes them through its
    // internal model. This must run BEFORE paste because Lexical's beforeinput
    // handler takes priority and prevents the paste event from working.
    try {
      document.execCommand("selectAll", false, undefined);
      const beforeInput = new InputEvent("beforeinput", {
        inputType: "insertFromPaste",
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      input.dispatchEvent(beforeInput);
      if ((input.textContent?.trim().length ?? 0) > 0) return true;
    } catch { /* fall through to paste strategy */ }

    // ── Strategy 1: Synthetic paste event (ClipboardEvent + DataTransfer) ──────
    // This is the MOST reliable strategy for React-based editors (Lexical,
    // ProseMirror, Quill) that intercept paste events and apply text through
    // their internal model.  execCommand('insertText') is rejected by some
    // editors (e.g. Perplexity's Lexical) and innerText assignment is reverted
    // by React's reconciliation.  A synthetic paste with DataTransfer is handled
    // as a single bulk operation that all major editors correctly intercept.
    try {
      document.execCommand("selectAll", false, undefined);
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      const dispatched = input.dispatchEvent(pasteEvent);
      // Editors that intercept paste and call preventDefault will return false
      // from dispatchEvent — that's the success signal. Verify content landed.
      if (dispatched || (input.textContent?.length ?? 0) > text.length / 2) {
        if ((input.textContent?.trim().length ?? 0) > 0) return true;
      }
    } catch { /* fall through to execCommand path */ }

    // ── Strategy 2: execCommand selectAll + insertText ────────────────────────
    // Works for ProseMirror, standard contentEditable, and editors that don't
    // intercept paste.  Also the fast path for small text (<5k chars) where
    // per-character beforeinput handling is not a performance concern.
    document.execCommand("selectAll", false, undefined);
    const inserted = document.execCommand("insertText", false, text);

    if (inserted && (input.textContent?.trim().length ?? 0) > 0) {
      return true;
    }

    // Fallback A: set innerText and fire a synthetic input event.
    // Works for editors that watch MutationObserver rather than beforeinput.
    try {
      input.innerText = text;
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
      );
      if ((input.textContent?.trim().length ?? 0) > 0) return true;
    } catch { /* fall through */ }

    // Fallback B: direct textContent assignment.
    input.textContent = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    return (input.textContent?.trim().length ?? 0) > 0;
  }

  return false;
}

// ── Network-capture helper (used by fetch/XHR interceptors) ──────────────────
// Sends a CAPTURE_SESSION message from an intercepted network response,
// bypassing the DOM scraper entirely. Deduplication is handled SW-side.
//
// Marks the payload with `source: 'fetch-intercept'` so the service worker
// shrink guard recognizes this as an authoritative full-history capture and
// will not reject it for being smaller than an existing snapshot (e.g. when
// the user has scrolled and the local copy contains a different message count).
//
// Also sets window.__contextForgeFetchCaptured so the DOM-fallback gate in
// startSessionCapture/capture() suppresses late DOM scrapes for 30s — this
// prevents virtual-scroll snapshots from racing the network capture and
// clobbering the authoritative count in pendingWrites. The gate now also
// requires count>0, so an empty sendCapture call (filtered out below) does
// NOT block DOM fallback.
export async function sendCapture(
  messages: Message[],
  platform: string
): Promise<void> {
  if (messages.length === 0) return;
  // Skip ChatGPT capture if URL lacks conversation ID
  if (platform === 'chatgpt' && !/\/c\/[a-zA-Z0-9-]+/.test(location.href)) {
    console.log(`[CM] ${platform}: sendCapture skipped - no /c/ ID in URL`);
    return;
  }
  // Grok conversation URLs contain a path segment after /chat/ or /conversation/
  if (platform === 'grok' && !/grok\.com\/(chat|conversation)\/[a-zA-Z0-9-]+/.test(location.href)) {
    console.log(`[CM] ${platform}: sendCapture skipped - no conversation ID in URL`);
    return;
  }
  // DeepSeek conversation URLs contain a chat session id after /a/chat/s/ or /chat/
  if (platform === 'deepseek' && !/chat\.deepseek\.com\/(a\/chat\/s|chat)\/[a-zA-Z0-9-]+/.test(location.href)) {
    console.log(`[CM] ${platform}: sendCapture skipped - no chat session ID in URL`);
    return;
  }
  const sessionId = await resolveSessionId(platform as Platform, location.href, undefined, false);
  try {
    (window as unknown as { __contextForgeFetchCaptured?: { at: number; count: number } })
      .__contextForgeFetchCaptured = { at: Date.now(), count: messages.length };
  } catch { /* ignore — window flag is a hint, not required */ }
  // Better title extraction: use first user message as fallback when document.title is generic
  const docTitle = document.title || location.hostname;
  const firstUserMsg = messages.find(m => m.role === 'user')?.content?.slice(0, 60) ?? "";
  const title = (docTitle.length > 5 && !/^(New chat|Chat|Conversation|Home)/i.test(docTitle))
    ? docTitle
    : firstUserMsg || docTitle;
  chrome.runtime.sendMessage({
    type: 'CAPTURE_SESSION',
    payload: {
      platform,
      sessionId,
      title,
      messages,
      source: 'fetch-intercept',
    },
  }).catch(() => {});
}

// ── DOM Probe ─────────────────────────────────────────────────────────────────

export interface DOMProbeCandidate {
  selector: string;
  role: 'user' | 'assistant' | 'root' | 'input' | 'unknown';
  count: number;
  sample: string;
  confidence: number;
}

export interface DOMProbeResult {
  platform: string;
  url: string;
  timestamp: number;
  candidates: DOMProbeCandidate[];
}

// Platform-specific selector hints — same confirmed selectors the scrapers actually use
const PROBE_HINTS: Record<string, { user: string[]; assistant: string[]; root: string[]; input: string[] }> = {
  claude: {
    user: ['[data-testid="user-message"]', '[data-testid="human-turn"]', '.human-turn', '[class*="human"]'],
    assistant: ['.font-claude-response', '[data-testid="ai-turn"]', '.ai-turn', '[class*="assistant"]'],
    root: ['[class*="conversation"]', '[class*="chat-content"]', 'main'],
    input: ["[contenteditable='true'][class*='ProseMirror']", 'div[contenteditable]', 'textarea'],
  },
  gemini: {
    user: ['user-query', 'user-query-content', '.query-content', '[data-test-id*="user"]'],
    assistant: ['model-response', 'response-container', '.response-content', '[data-test-id*="response"]'],
    root: ['chat-window-content', 'chat-window', 'infinite-scroller', '[data-test-id*="chat-history"]', 'conversation-container'],
    input: ['rich-textarea', '.ql-editor', "[contenteditable='true']", 'textarea'],
  },
  chatgpt: {
    user: ["[data-message-author-role='user']", '.message--user', '[class*="user-message"]'],
    assistant: ["[data-message-author-role='assistant']", '.message--assistant', '[class*="assistant-message"]'],
    root: ['[class*="conversation"]', '[class*="chat-messages"]', 'main'],
    input: ['#prompt-textarea', 'textarea[placeholder*="Message"]', '[contenteditable]'],
  },
  grok: {
    user: ['[data-testid="user-message"]', '[class*="user-message"]', '[data-role="user"]'],
    assistant: ['[data-testid="assistant-message"]', '[class*="message-bubble"]', '[data-role="assistant"]'],
    root: ['main', '[class*="conversation"]', '[class*="messages"]'],
    input: ['textarea', '[contenteditable]'],
  },
  deepseek: {
    user: ['[class*="ds-message"]:not([class*="ds-assistant"])', '[class*="userMessage"]', '[class*="user-message"]', '[class*="human-message"]', '[data-role="user"]'],
    assistant: ['[class*="ds-assistant-message-main-content"]', '[class*="ds-markdown"]', '[class*="assistantMessage"]', '[class*="assistant-message"]', '[data-role="assistant"]'],
    root: ['[class*="chat-main"]', '[class*="message-list"]', 'main'],
    input: ['textarea', '[contenteditable]'],
  },
  perplexity: {
    user: ['[class*="group/query"]', '[class*="query"]', '[data-testid*="user"]', '[data-testid*="user-query"]', '[class*="UserMessage"]'],
    assistant: ['[class*="prose"]', '[class*="answer-text"]', '[data-testid*="answer"]', '[class*="answer-block"]', '[class*="model-answer"]'],
    root: ['[class*="thread"]', '[class*="conversation"]', 'main'],
    input: ['textarea', '[contenteditable]'],
  },
};

export function runDOMProbe(platform: string): DOMProbeResult {
  const hints = PROBE_HINTS[platform] ?? PROBE_HINTS['claude'];
  const results: DOMProbeCandidate[] = [];
  const seen = new Set<string>();

  function tryRole(sels: string[], role: DOMProbeCandidate['role']) {
    for (const sel of sels) {
      if (seen.has(sel)) continue;
      try {
        const nodes = document.querySelectorAll(sel);
        if (nodes.length === 0) continue;
        seen.add(sel);
        const sample = (nodes[0].textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const confidence = nodes.length >= 2 ? 0.9 : 0.7;
        results.push({ selector: sel, role, count: nodes.length, sample, confidence });
      } catch { /* invalid selector */ }
    }
  }

  tryRole(hints.user, 'user');
  tryRole(hints.assistant, 'assistant');
  tryRole(hints.root, 'root');
  tryRole(hints.input, 'input');

  results.sort((a, b) => b.confidence - a.confidence || b.count - a.count);
  return { platform, url: location.href, timestamp: Date.now(), candidates: results };
}

if (typeof window !== 'undefined') {
  (window as any).__cmRunDOMProbe = () => runDOMProbe(
    window.location.hostname.includes('gemini') ? 'gemini' :
    window.location.hostname.includes('claude') ? 'claude' :
    window.location.hostname.includes('chatgpt') ? 'chatgpt' :
    window.location.hostname.includes('grok') ? 'grok' :
    window.location.hostname.includes('deepseek') ? 'deepseek' :
    window.location.hostname.includes('perplexity') ? 'perplexity' : 'claude'
  );
}
