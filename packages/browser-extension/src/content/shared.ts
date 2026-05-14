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

export function detectPlatform(): string {
  const host = location.hostname;
  if (host === 'claude.ai') return 'claude';
  if (host === 'chatgpt.com') return 'chatgpt';
  if (host === 'gemini.google.com') return 'gemini';
  if (host === 'grok.com') return 'grok';
  if (host === 'perplexity.ai') return 'perplexity';
  if (host === 'deepseek.com') return 'deepseek';
  return 'unknown';
}

export function createObserver(
  selectorOrElement: string | Element,
  callback: () => void,
  debounceMs = 150
): MutationObserver {
  // Debounce so streaming AI responses (one DOM mutation per token) don't
  // call scrapeMessages on every individual token.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedCallback = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(callback, debounceMs);
  };

  const observer = new MutationObserver(debouncedCallback);

  function attach() {
    const target =
      typeof selectorOrElement === "string"
        ? document.querySelector(selectorOrElement) ?? document.body
        : selectorOrElement;

    // Guard: document.body is null at document_start — defer until DOM is ready
    if (!target) {
      document.addEventListener("DOMContentLoaded", attach, { once: true });
      return;
    }

    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  attach();
  return observer;
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
        return !!document.querySelector('[data-streaming="true"], .streaming');
      case "deepseek":
        return !!document.querySelector('.ds-loading, [data-generating]');
      case "perplexity":
        return !!document.querySelector('.generating, [data-state="loading"]');
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

export function startSessionCapture(config: {
  platform: string;
  selectorOrElement: string | Element;
  scrapeMessages: () => Message[];
  getTitle?: (messages: Message[]) => string;
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

  let sessionId: string | null = null;
  let lastMessageHash = "";
  let lastHref = window.location.href;
  let lastUnchangedAt = 0;
  const UNCHANGED_COOLDOWN_MS = 5_000; // don't re-scrape if last result was unchanged < 5s ago

  // Double-capture guards:
  // captureInFlight — prevents concurrent executions of capture() overlapping on ensureSessionId().
  // lastSentAt / MIN_SEND_INTERVAL_MS — enforces minimum 2s between CAPTURE_SESSION sends
  //   for the same session (absorbs rapid setTimeout + load-event pairs).
  let captureInFlight = false;
  let lastSentAt = 0;
  const MIN_SEND_INTERVAL_MS = 2_000;

  let pendingCaptureAfterStream = false;
  let streamPollId: ReturnType<typeof setInterval> | null = null;

  // Async-resolve the session id via chrome.storage URL map.  Cached after the
  // first call; invalidated when the URL changes or when the service worker
  // broadcasts SESSION_FORGOTTEN (i.e. user deleted the session).
  async function ensureSessionId(): Promise<string> {
    if (sessionId) return sessionId;
    sessionId = await resolveSessionId(
      config.platform as Platform,
      window.location.href,
      legacyChecker
    );
    console.log(`[ContextMover] ${config.platform}: resolved sessionId=${sessionId}`);
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
    }
  });

  const FETCH_FALLBACK_WINDOW_MS = 60_000;
  const capture = async () => {
    // Re-resolve session ID on SPA navigation (e.g. Claude pushState from
    // /new → /chat/abc123 when a conversation starts).
    const currentHref = window.location.href;
    if (currentHref !== lastHref) {
      lastHref = currentHref;
      sessionId = null;
      lastMessageHash = "";
      console.log(`[ContextMover] URL changed — re-resolving sessionId`);
    }

    // ── Fetch-intercept fallback gate ──────────────────────────────────────
    // If the MAIN-world fetch interceptor produced a valid capture recently,
    // skip the DOM scrape — fetch data is bulletproof, DOM data is fragile.
    const fc = (window as unknown as { __contextForgeFetchCaptured?: { at: number; count: number } })
      .__contextForgeFetchCaptured;
    if (fc && Date.now() - fc.at < FETCH_FALLBACK_WINDOW_MS) {
      console.log(
        `[ContextMover] ${config.platform}: fetch-intercept active (count=${fc.count}, age=${Date.now() - fc.at}ms), skipping DOM scrape`
      );
      return;
    }

    // If the last scrape found no change, suppress re-scrape for UNCHANGED_COOLDOWN_MS.
    if (lastUnchangedAt > 0 && Date.now() - lastUnchangedAt < UNCHANGED_COOLDOWN_MS) {
      return;
    }

    // Skip capture while the assistant is actively streaming — schedule a
    // deferred capture for when streaming finishes instead.
    if (isAssistantStreaming(config.platform)) {
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

    // Prevent concurrent capture executions — if ensureSessionId() is still
    // awaiting from a previous call, skip rather than sending a duplicate.
    if (captureInFlight) {
      console.log(`[ContextMover] ${config.platform}: capture already in flight, skipping`);
      return;
    }
    captureInFlight = true;
    try {

    console.log(`[ContextMover] Capture triggered for ${config.platform} (DOM fallback)`);
    const messages = config.scrapeMessages();
    if (!messages.length) {
      console.log(`[ContextMover] No messages found, skipping capture`);
      return;
    }

    // Skip transient states: user just sent a message, assistant still
    // generating (or still has [data-is-streaming]). Persisting user-only
    // snapshots produces noisy "assistant missing" errors downstream and
    // pollutes the session list with half-captures.
    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    if (assistantCount === 0) {
      console.log(
        `[ContextMover] Skipping capture — ${messages.length} user-only messages (awaiting assistant response)`
      );
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

    console.log(`[ContextMover] Sending CAPTURE_SESSION for session: ${resolvedId}`);
    chrome.runtime.sendMessage({
      type: "CAPTURE_SESSION",
      payload: {
        platform: config.platform,
        sessionId: resolvedId,
        title,
        messages,
      },
    });
    } finally {
      captureInFlight = false;
    }
  };

  createObserver(config.selectorOrElement, capture);

  // Initial capture with small delay to let page render
  setTimeout(capture, 1000);
  window.addEventListener("load", capture, { once: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      capture();
    }
  });
  // Handle back/forward navigation in SPAs
  window.addEventListener("popstate", () => setTimeout(capture, 500));
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
  clone.querySelectorAll<HTMLElement>("pre").forEach((pre) => {
    const codeEl = pre.querySelector("code");
    const lang =
      (codeEl?.className ?? "").match(/language-([\w-]+)/)?.[1] ?? "";
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

export async function waitForElement<T extends Element>(
  selector: string,
  timeoutMs = 2500
): Promise<T | null> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const element = document.querySelector<T>(selector);
    if (element) {
      return element;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }

  return null;
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
