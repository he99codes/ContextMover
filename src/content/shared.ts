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
import { healthMonitor } from "@/lib/capture/health-monitor";

export type Message = LibMessage;

const legacyChecker = makeLegacyChecker();

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

const _brokenReported = new Set<string>();

export function createObserver(
  selectorOrElement: string | Element | (() => string | Element),
  callback: () => void,
  debounceMs = 150,
  platform = ""
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
      observer.observe(resolved, { childList: true, subtree: true, characterData: true });
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
      // Second miss — selector is genuinely absent. Platform likely updated their UI.
      if (platform && !_brokenReported.has(platform)) {
        _brokenReported.add(platform);
        chrome.runtime.sendMessage({
          type: "SCRAPER_BROKEN",
          platform,
          reason: `Selector not found: ${resolved}`,
          href: location.href,
          dom_snippet: getDebugSnippet(),
        }).catch(() => {});
      }
      return;
    }

    observer.observe(target, { childList: true, subtree: true, characterData: true });
  }

  attach();
  return observer;
}

function getDebugSnippet(): string {
  const mainEl = document.querySelector('main, [role="main"]');
  if (mainEl) return mainEl.outerHTML.slice(0, 5000);
  return document.body.outerHTML.slice(0, 5000);

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
        // Generic fallback: detect common streaming indicators across platforms.
        return !!document.querySelector(
          'button[aria-label*="Stop" i], button[aria-label*="Pause" i], ' +
          '[class*="streaming"], [class*="generating"], [class*="typing-indicator"], ' +
          '[data-streaming], [data-generating], [data-is-streaming]'
        );
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
  let lastHref = window.location.href;
  let lastUnchangedAt = 0;
  const UNCHANGED_COOLDOWN_MS = 5_000; // don't re-scrape if last result was unchanged < 5s ago

  // Zero-scrape retry gate — when scrape returns 0 after previously having messages,
  // retry 3× at 1 s intervals before clearing session state.
  let zeroScrapeRetries = 0;
  const MAX_ZERO_RETRIES = 3;
  let zeroRetryTimer: ReturnType<typeof setTimeout> | null = null;

  // Double-capture guards:
  // captureInFlight — prevents concurrent executions of capture() overlapping on ensureSessionId().
  // lastSentAt / MIN_SEND_INTERVAL_MS — enforces minimum 2s between CAPTURE_SESSION sends
  //   for the same session (absorbs rapid setTimeout + load-event pairs).
  let captureInFlight = false;
  let lastSentAt = 0;
  const MIN_SEND_INTERVAL_MS = 2_000;

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
  let streamPollId: ReturnType<typeof setInterval> | null = null;
  let isScrollbackInProgress = false;

  // Async-resolve the session id via chrome.storage URL map.  Cached after the
  // first call; invalidated when the URL changes or when the service worker
  // broadcasts SESSION_FORGOTTEN (i.e. user deleted the session).
  async function ensureSessionId(): Promise<string> {
    if (sessionId) {
      console.log(`[ContextMover] ${config.platform}: using cached sessionId=${sessionId}`);
      return sessionId;
    }
    const href = window.location.href;
    sessionId = await resolveSessionId(
      config.platform as Platform,
      href,
      legacyChecker
    );
    console.log(`[ContextMover] ${config.platform}: resolved sessionId=${sessionId} for URL=${href}`);
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
  const FETCH_FALLBACK_WINDOW_MS = 30_000;
  const capture = async () => {
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
      // Always reset the retry counter on any navigation.
      zeroScrapeRetries = 0;
      if (zeroRetryTimer !== null) { clearTimeout(zeroRetryTimer); zeroRetryTimer = null; }
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
      return;
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

    // Skip captures while scrollback is in progress — wait for all messages to load
    if (isScrollbackInProgress) {
      console.log(`[ContextMover] ${config.platform}: Skipping capture during scrollback`);
      return;
    }

    // Prevent concurrent capture executions — if ensureSessionId() is still
    // awaiting from a previous call, skip rather than sending a duplicate.
    if (captureInFlight) {
      console.log(`[ContextMover] ${config.platform}: capture already in flight, skipping`);
      diag("bail: capture in flight");
      return;
    }

    captureInFlight = true;
    try {

    console.debug(`[ContextMover] Capture triggered for ${config.platform} (DOM fallback)`);
    const messages = config.scrapeMessages();
    diag(`scraped: total=${messages.length} user=${messages.filter(m=>m.role==='user').length} asst=${messages.filter(m=>m.role==='assistant').length}`);
    if (!messages.length) {
      // If we previously captured messages, don't immediately abandon — the
      // DOM may not have re-rendered yet (SPA navigation, lazy hydration).
      // Retry up to MAX_ZERO_RETRIES × 1 s before treating as truly empty.
      if (lastSentMessageCount > 0 && zeroScrapeRetries < MAX_ZERO_RETRIES) {
        zeroScrapeRetries++;
        console.debug(`[ContextMover] ${config.platform}: 0 messages after ${lastSentMessageCount} — retry ${zeroScrapeRetries}/${MAX_ZERO_RETRIES}`);
        diag(`zero-scrape retry ${zeroScrapeRetries}/${MAX_ZERO_RETRIES}`);
        if (zeroRetryTimer !== null) clearTimeout(zeroRetryTimer);
        zeroRetryTimer = setTimeout(() => { zeroRetryTimer = null; void capture(); }, 1_000);
        return;
      }
      // Retries exhausted (or no prior messages) — genuine empty page.
      if (lastSentMessageCount > 0 && !_brokenReported.has(config.platform)) {
        // Had messages before, now zero after retries — selector likely broken.
        _brokenReported.add(config.platform);
        chrome.runtime.sendMessage({
          type: "SCRAPER_BROKEN",
          platform: config.platform,
          reason: "Zero messages found after retries.",
          href: location.href,
          dom_snippet: getDebugSnippet(),
        }).catch(() => {});
      }
      // NEW SESSION: if we've never sent messages (lastSentMessageCount === 0),
      // this is a brand new conversation. Don't report as error — just wait for
      // the user to send a message. The MutationObserver will trigger capture
      // once the first message appears in the DOM.
      if (lastSentMessageCount === 0) {
        console.debug(`[ContextMover] ${config.platform}: New empty session — waiting for first message`);
        diag("bail: new empty session");
        return;
      }
      zeroScrapeRetries = 0;
      console.debug(`[ContextMover] No messages found, skipping capture`);
      diag("bail: 0 messages from scrape");
      return;
    }
    // Non-zero scrape — reset the retry counter.
    zeroScrapeRetries = 0;
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

    // Filter out broken messages: empty content, whitespace-only, or DOM artifacts.
    const cleanMessages = messages.filter((m) => {
      if (!m.content || typeof m.content !== "string") return false;
      const trimmed = m.content.trim();
      if (trimmed.length === 0) return false;
      // Filter DOM artifacts: standalone "..." or loading placeholders.
      if (trimmed === "..." || trimmed === "Loading…" || trimmed === "Loading...") return false;
      return true;
    });

    if (cleanMessages.length === 0) {
      console.debug(`[ContextMover] All messages filtered as broken/empty, skipping capture`);
      diag("bail: all messages broken/empty after filter");
      return;
    }

    const title =
      config.getTitle?.(cleanMessages) ??
      defaultSessionTitle(cleanMessages);

    // djb2 hash of all messages — catches edits anywhere in the conversation,
    // not just appends. Only skip if the ENTIRE message array is identical.
    const newHash = hashMessages(cleanMessages);
    if (newHash === lastMessageHash) {
      lastUnchangedAt = Date.now();
      console.debug(`[ContextMover] Snapshot hash unchanged, skipping`);
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
    if (cleanMessages.length < lastSentMessageCount * 0.75) {
      console.log(
        `[ContextMover] ${config.platform}: suppressed shrinking scrape ` +
        `(${lastSentMessageCount}\u2192${cleanMessages.length}) — likely virtual scroll eviction`
      );
      lastUnchangedAt = Date.now();
      return;
    }

    const resolvedId = await ensureSessionId();

    // Minimum 2s between sends for the same session.
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
    lastSentMessageCount = cleanMessages.length;

    console.debug(`[ContextMover] Sending CAPTURE_SESSION for session: ${resolvedId}`);
    diag(`sending CAPTURE_SESSION sessionId=${resolvedId} count=${cleanMessages.length}`);
    chrome.runtime.sendMessage(
      {
        type: "CAPTURE_SESSION",
        payload: {
          platform: config.platform,
          sessionId: resolvedId,
          title,
          messages: cleanMessages,
        },
      },
      () => { void chrome.runtime.lastError; }
    );
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

  createObserver(config.selectorOrElement, capture, config.observerSettleMs, config.platform);

  // Staggered initial captures — catches lazy-rendered messages at each stage.
  void capture();
  setTimeout(capture, 100);
  setTimeout(capture, 500);
  setTimeout(capture, 1000);
  setTimeout(capture, 1500);
  // Platform-specific late captures (e.g. Claude SPA renders at 2–6s).
  if (config.extraCaptureDelays?.length) {
    for (const d of config.extraCaptureDelays) setTimeout(capture, d);
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
          ? (document.querySelector(_resolvedSO) ?? document.body)
          : _resolvedSO
      try {
        isScrollbackInProgress = true;
        console.log(`[CM:${config.platform}] scrollback: starting — loading lazy history`)
        const restore = await autoScrollBackToTop(scopeEl, config.getScrollContainerSelector, config.scrollBackStrategy)
        console.log(`[CM:${config.platform}] scrollback: DOM settled — running full capture`)
        isScrollbackInProgress = false;
        await capture()
        restore()
        setTimeout(() => void capture(), 800)
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

  // Virtual scroll — re-scrape when user scrolls to load lazy history
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => void capture(), 800);
  }, { passive: true });

  // SPA pushState navigation detection (history.pushState doesn't fire popstate)
  // Two captures only (800ms + 1500ms) — late captures (>2s) clobber authoritative
  // captures with virtual-scroll snapshots once the SW captureInFlight lock clears.
  let lastNavUrl = location.href;
  new MutationObserver(() => {
    if (location.href === lastNavUrl) return;
    lastNavUrl = location.href;
    setTimeout(capture, 800);
    setTimeout(capture, 1500);
  }).observe(document, { subtree: true, childList: true });

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
    console.warn(`[CM:${platform}] Registry strategies empty — trying structural detection`);
    const structural = detectByStructure(platform);
    if (structural.length > 0 && structural.some((m) => m.role === "assistant")) {
      messages = structural;
      detectionMethod = "structural";
    }
  }

  const finalValidation = validateCapture(messages, platform, detectionMethod);

  // Record health — fire-and-forget, never blocks the sync return
  void healthMonitor.record({
    platform,
    timestamp: Date.now(),
    success: finalValidation.valid,
    userCount: finalValidation.stats.user,
    assistantCount: finalValidation.stats.assistant,
    detectionMethod,
    errors: finalValidation.errors,
  });

  return messages;
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export interface DOMProbeCandidate {
  selector: string;
  sampleText: string;
  frequency: number;
  score: number;
  likelyRole: 'user' | 'assistant' | 'input' | 'unknown';
}

export interface DOMProbeResult {
  platform: string;
  timestamp: number;
  candidates: DOMProbeCandidate[];
  currentSelectors: Record<string, string | undefined>;
}

export function runDOMProbe(platform: string): DOMProbeResult {
  const candidates = new Map<string, { count: number, text: string, roles: Set<string> }>();

  document.querySelectorAll('*').forEach(el => {
    if (el.children.length > 0) return; // only leaf nodes
    const text = el.textContent?.trim() ?? '';
    if (text.length < 20) return;

    const selector = el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : '');
    const entry = candidates.get(selector) || { count: 0, text: '', roles: new Set<string>() };
    entry.count++;
    if (!entry.text) entry.text = text.slice(0, 80).replace(/\s+/g, ' ');
    
    // Role detection
    if (el.closest('textarea, [contenteditable="true"]')) {
      entry.roles.add('input');
    } else if (text.match(/^(You:|Human:)/i) || el.closest('[data-testid*="user"], [class*="user-query"]')) {
      entry.roles.add('user');
    } else if (el.closest('[data-testid*="assistant"], [class*="model-response"]')) {
      entry.roles.add('assistant');
    }

    candidates.set(selector, entry);
  });

  const scoredCandidates: DOMProbeCandidate[] = Array.from(candidates.entries()).map(([selector, data]) => {
    let score = 0;
    if (data.count > 1) score += 0.2;
    if (selector.includes('[data-testid')) score += 0.5;
    if (selector.includes('[role=')) score += 0.2;
    if (data.roles.size > 0) score += 0.1;

    let likelyRole: DOMProbeCandidate['likelyRole'] = 'unknown';
    if (data.roles.has('input')) likelyRole = 'input';
    else if (data.roles.has('user')) likelyRole = 'user';
    else if (data.roles.has('assistant')) likelyRole = 'assistant';

    return {
      selector,
      sampleText: data.text,
      frequency: data.count,
      score,
      likelyRole,
    };
  }).sort((a, b) => b.score - a.score).slice(0, 30);

  return {
    platform,
    timestamp: Date.now(),
    candidates: scoredCandidates,
    currentSelectors: {},
  };
}

export interface DOMProbeCandidate {
  selector: string;
  sampleText: string;
  frequency: number;
  score: number;
  likelyRole: 'user' | 'assistant' | 'input' | 'unknown';
}

export interface DOMProbeResult {
  platform: string;
  timestamp: number;
  candidates: DOMProbeCandidate[];
  currentSelectors: Record<string, string | undefined>;
}

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

  const originalScrollTop = container.scrollTop
  if (originalScrollTop === 0) return () => { /* already at top */ }

  const target = container

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
  // Hard cap — prevents SIGILL tab crashes from oversized prompts
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
    if (ok && content.includes(first50)) return true;
    if (attempt < maxAttempts) {
      console.warn(`[ContextMover] Inject attempt ${attempt} failed (${platform}), retrying in ${currentDelay}ms...`);
      await sleep(currentDelay);
      currentDelay = Math.floor(currentDelay * 1.5); // 300 → 450 → 675ms
    }
  }
  // All attempts failed — write to clipboard as last resort.
  try {
    await navigator.clipboard.writeText(text);
    chrome.runtime.sendMessage({
      type: 'CF_NOTIFICATION',
      message: 'Context copied to clipboard — paste manually with Ctrl+V',
    }).catch(() => {});
  } catch { /* clipboard API unavailable in this context */ }
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
    // ── Fast path for large text (>5k chars) ────────────────────────────────
    // execCommand("insertText") with 30k+ chars freezes ProseMirror/Lexical for
    // 10-30 seconds because it dispatches per-character beforeinput handling.
    // Synthetic ClipboardEvent with DataTransfer is handled as a single bulk
    // paste operation — ~50× faster on large strings.
    if (text.length > 5000) {
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
          // Give the editor one microtask to process; some editors apply async.
          if ((input.textContent?.trim().length ?? 0) > 0) return true;
        }
      } catch { /* fall through to standard path */ }
    }

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
  const sessionId = await resolveSessionId(platform as Platform, location.href);
  try {
    (window as unknown as { __contextForgeFetchCaptured?: { at: number; count: number } })
      .__contextForgeFetchCaptured = { at: Date.now(), count: messages.length };
  } catch { /* ignore — window flag is a hint, not required */ }
  chrome.runtime.sendMessage({
    type: 'CAPTURE_SESSION',
    payload: {
      platform,
      sessionId,
      title: document.title || location.hostname,
      messages,
      source: 'fetch-intercept',
    },
  }).catch(() => {});
}
