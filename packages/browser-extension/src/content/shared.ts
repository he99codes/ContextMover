// packages/browser-extension/src/content/shared.ts

// ── Bubble types (also used by floating-bubble/bubble.ts) ─────────────────────
export type BubbleState    = "idle" | "capturing" | "error";
export type SnapZone       = "top-right" | "bottom-right" | "top-left" | "bottom-left";
export interface BubblePosition { x: number; y: number; snap: SnapZone; }
// ─────────────────────────────────────────────────────────────────────────────

import type { Message, Platform } from "@/lib/types";
import { resolveSessionId, makeLegacyChecker } from "@/lib/session-id";

const legacyChecker = makeLegacyChecker();

export function createObserver(
  selectorOrElement: string | Element,
  callback: () => void,
  debounceMs = 300
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

export function defaultSessionTitle(messages: Message[]): string {
  const source =
    messages.find((message) => message.role === "user")?.content ??
    messages[0]?.content ??
    "Untitled session";

  return truncate(source.replace(/\s+/g, " ").trim(), 72);
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
    console.log(`[ContextForge] ${config.platform} content script already active — skipping duplicate init`);
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
  let lastSnapshotKey = "";
  let lastHref = window.location.href;
  let lastUnchangedAt = 0;
  const UNCHANGED_COOLDOWN_MS = 5_000; // don't re-scrape if last result was unchanged < 5s ago

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
    console.log(`[ContextForge] ${config.platform}: resolved sessionId=${sessionId}`);
    return sessionId;
  }

  // Listen for forget broadcasts from the SW.  When the user (or web dashboard)
  // deletes a session matching ours, drop the cached id so the next capture
  // mints a brand-new session and re-extracts the full conversation.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "SESSION_FORGOTTEN") return;
    if (msg.sessionId && sessionId && msg.sessionId === sessionId) {
      console.log(
        `[ContextForge] ${config.platform}: received SESSION_FORGOTTEN for ${sessionId} — clearing cache, next capture will mint new id`
      );
      sessionId = null;
      lastSnapshotKey = "";
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
      lastSnapshotKey = "";
      console.log(`[ContextForge] URL changed — re-resolving sessionId`);
    }

    // ── Fetch-intercept fallback gate ──────────────────────────────────────
    // If the MAIN-world fetch interceptor produced a valid capture recently,
    // skip the DOM scrape — fetch data is bulletproof, DOM data is fragile.
    const fc = (window as unknown as { __contextForgeFetchCaptured?: { at: number; count: number } })
      .__contextForgeFetchCaptured;
    if (fc && Date.now() - fc.at < FETCH_FALLBACK_WINDOW_MS) {
      console.log(
        `[ContextForge] ${config.platform}: fetch-intercept active (count=${fc.count}, age=${Date.now() - fc.at}ms), skipping DOM scrape`
      );
      return;
    }

    // If the last scrape found no change, suppress re-scrape for UNCHANGED_COOLDOWN_MS.
    if (lastUnchangedAt > 0 && Date.now() - lastUnchangedAt < UNCHANGED_COOLDOWN_MS) {
      return;
    }

    console.log(`[ContextForge] Capture triggered for ${config.platform} (DOM fallback)`);
    const messages = config.scrapeMessages();
    if (!messages.length) {
      console.log(`[ContextForge] No messages found, skipping capture`);
      return;
    }

    // Skip transient states: user just sent a message, assistant still
    // generating (or still has [data-is-streaming]). Persisting user-only
    // snapshots produces noisy "assistant missing" errors downstream and
    // pollutes the session list with half-captures.
    const assistantCount = messages.filter((m) => m.role === "assistant").length;
    if (assistantCount === 0) {
      console.log(
        `[ContextForge] Skipping capture — ${messages.length} user-only messages (awaiting assistant response)`
      );
      return;
    }

    const title =
      config.getTitle?.(messages) ??
      defaultSessionTitle(messages);
    const lastMessage = messages[messages.length - 1];
    const snapshotKey = `${messages.length}:${lastMessage?.role ?? ""}:${lastMessage?.content ?? ""}`;

    if (snapshotKey === lastSnapshotKey) {
      lastUnchangedAt = Date.now();
      console.log(`[ContextForge] Snapshot unchanged, skipping`);
      return;
    }
    lastUnchangedAt = 0; // new content — allow immediate re-scrapes
    lastSnapshotKey = snapshotKey;

    const resolvedId = await ensureSessionId();
    console.log(`[ContextForge] Sending CAPTURE_SESSION for session: ${resolvedId}`);
    chrome.runtime.sendMessage({
      type: "CAPTURE_SESSION",
      payload: {
        platform: config.platform,
        sessionId: resolvedId,
        title,
        messages,
      },
    });
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
