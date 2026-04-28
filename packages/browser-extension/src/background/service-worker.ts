// packages/browser-extension/src/background/service-worker.ts
import { db } from "@/lib/db";
import summarize, { summarizeWithAttention } from "@/lib/summarizer";
import buildMigrationPrompt from "@/lib/translator";
import type { ContextSession, ExtractedContext, Message } from "@/lib/types";
import { supabase } from "@/lib/supabase";
import {
  upsertSessionToCloud,
  deleteSessionFromCloud,
  bulkSyncToCloud,
} from "@/lib/cloud-sync";
import { startRealtimeSync, stopRealtimeSync } from "@/lib/realtime-sync";
import { forgetSession, resolveSessionId } from "@/lib/session-id";

// Start realtime sync as soon as the service worker wakes up — if the user is
// already signed in, edits/deletes from the web dashboard will mirror into the
// local IndexedDB without needing a sign-in round-trip.
void startRealtimeSync();

// Broadcast a message to any OPEN extension view (sidebar, popup, options).
// Using chrome.runtime.sendMessage with no open view rejects with "Receiving
// end does not exist" which Chrome surfaces as an error in DevTools even when
// the promise rejection is caught. Gating on getContexts() eliminates the noise.
async function broadcastToViews(message: unknown): Promise<void> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [
        "SIDE_PANEL" as chrome.runtime.ContextType,
        "POPUP" as chrome.runtime.ContextType,
        "TAB" as chrome.runtime.ContextType,
      ],
    });
    if (!contexts || contexts.length === 0) return;
    await chrome.runtime.sendMessage(message);
  } catch {
    /* No listener ready — safe to ignore. */
  }
}

const BRIDGE_URL = "http://localhost:49152";
const PLATFORM_URLS = {
  claude:     ["https://claude.ai/*"],
  chatgpt:    ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  gemini:     ["https://gemini.google.com/*"],
  grok:       ["https://grok.com/*", "https://grok.x.ai/*"],
  perplexity: ["https://www.perplexity.ai/*"],
  deepseek:   ["https://chat.deepseek.com/*"],
} as const;

const ALL_PLATFORM_URL_GLOBS: string[] = Object.values(PLATFORM_URLS).flatMap((p) => [...p]);

// Broadcast SESSION_FORGOTTEN to every open AI tab so live content scripts
// drop their cached session id and let the next capture mint a fresh one.
async function broadcastForgetToTabs(sessionId: string): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: ALL_PLATFORM_URL_GLOBS });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        chrome.tabs.sendMessage(
          tab.id,
          { type: "SESSION_FORGOTTEN", sessionId },
          () => { void chrome.runtime.lastError; }
        );
      } catch { /* tab gone — ignore */ }
    }
  } catch (err) {
    console.warn("[ContextForge] broadcastForgetToTabs failed:", err);
  }
}

// ── Side panel behaviour ───────────────────────────────────────────────────────
// Register at module load so it is always active, even after the service worker
// wakes from sleep. chrome.sidePanel persists the setting in Chrome storage, but
// calling it again on each wake is cheap and ensures it is never stale.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err: unknown) => console.warn("[ContextForge] setPanelBehavior failed:", err));

// ── Lifecycle ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  console.log("[ContextForge] Extension installed.");
  chrome.storage.local.set({ sessions: [] });

  // MV3 does NOT auto-inject content scripts into already-open tabs after a
  // reload. Re-inject only into tabs that DON'T already have a live listener —
  // otherwise we end up with two listeners per tab, both returning true on
  // INJECT_CONTEXT, and Chrome logs "message channel closed".
  const manifest = chrome.runtime.getManifest();
  for (const cs of manifest.content_scripts ?? []) {
    const tabs = await chrome.tabs.query({ url: cs.matches });
    for (const tab of tabs) {
      if (!tab.id) continue;
      const alive = await new Promise<boolean>((resolve) => {
        try {
          chrome.tabs.sendMessage(tab.id!, { type: "PING" }, () => {
            // lastError means no listener → script not loaded
            resolve(!chrome.runtime.lastError);
          });
        } catch { resolve(false); }
      });
      if (alive) {
        console.log(`[ContextForge] Tab ${tab.id} already has content script — skipping`);
        continue;
      }
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: cs.js as string[] })
        .then(() => console.log(`[ContextForge] Injected content script into tab ${tab.id} (${tab.url})`))
        .catch(() => { /* non-scriptable tab */ });
    }
  }
});

// Fallback: explicitly open the panel when the toolbar icon is clicked.
// Handles edge cases where setPanelBehavior alone isn't triggered.
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId == null) return;
  chrome.sidePanel
    .open({ windowId: tab.windowId })
    .catch((err: unknown) => console.warn("[ContextForge] sidePanel.open failed:", err));
});

// ── Message Router ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log(`[ContextForge ServiceWorker] Received message: ${msg.type}`);
  (async () => {
    switch (msg.type) {
      case "CAPTURE_SESSION":
        console.log(`[ContextForge ServiceWorker] CAPTURE_SESSION payload:`, msg.payload);
        await handleCaptureSession(msg.payload);
        sendResponse({ ok: true });
        break;

      case "CAPTURE_MESSAGE":
        await handleCaptureMessage(msg.payload);
        sendResponse({ ok: true });
        break;

      case "GET_SESSIONS":
        sendResponse(await db.getAllSessions());
        break;

      case "SYNC_OPEN_TABS":
        await syncOpenTabs();
        sendResponse({ ok: true });
        break;

      case "GET_SESSION":
        sendResponse(await db.getSession(msg.sessionId));
        break;

      case "DELETE_SESSION":
        await db.deleteSession(msg.sessionId);
        await forgetSession(msg.sessionId);
        void deleteSessionFromCloud(msg.sessionId);
        void broadcastForgetToTabs(msg.sessionId);
        void broadcastToViews({ type: "SESSIONS_UPDATED" });
        sendResponse({ ok: true });
        break;

      case "SESSION_EXISTS": {
        // Used by content scripts to check if a legacy hash-based session id
        // already exists so we can adopt it instead of orphaning it.
        const existing = await db.getSession(msg.sessionId);
        sendResponse({ exists: !!existing });
        break;
      }

      case "MIGRATE_CONTEXT":
        await handleMigrateContext(msg.payload, sendResponse);
        break;

      case "FETCH_IDE_CONTEXT":
        await handleFetchIdeContext(sendResponse);
        break;

      case "AUTH_GET_USER": {
        const { data } = await supabase.auth.getUser();
        sendResponse({ user: data.user ?? null });
        break;
      }

      case "AUTH_SIGN_IN": {
        const { email, password } = msg.payload;
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) {
          sendResponse({ error: error.message });
        } else {
          sendResponse({ user: data.user });
          // Bulk-sync any locally-captured sessions to the cloud now that we
          // have an authenticated user, then begin listening for remote edits.
          void (async () => {
            const local = await db.getAllSessions();
            await bulkSyncToCloud(local);
            await startRealtimeSync();
            void broadcastToViews({ type: "AUTH_STATE_CHANGED" });
          })();
        }
        break;
      }

      case "AUTH_SIGN_UP": {
        const { email, password } = msg.payload;
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) {
          sendResponse({ error: error.message });
        } else {
          sendResponse({ user: data.user, needsConfirmation: !data.session });
        }
        break;
      }

      case "AUTH_SIGN_OUT": {
        await stopRealtimeSync();
        await supabase.auth.signOut();
        sendResponse({ ok: true });
        void broadcastToViews({ type: "AUTH_STATE_CHANGED" });
        break;
      }

      case "CLOUD_RESYNC_ALL": {
        const local = await db.getAllSessions();
        await bulkSyncToCloud(local);
        sendResponse({ ok: true, count: local.length });
        break;
      }

      default:
        sendResponse({ error: `Unknown message type: ${msg.type}` });
    }
  })();
  return true; // keep channel open for async
});

// ── Handlers ───────────────────────────────────────────────────────────────────
async function handleCaptureMessage(payload: {
  platform: string;
  sessionId: string;
  message: Message;
}) {
  const { platform, sessionId, message } = payload;
  let session: ContextSession | undefined = await db.getSession(sessionId);

  if (!session) {
    session = {
      id: sessionId,
      platform: platform as ContextSession["platform"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      title: message.content.slice(0, 60) + "…",
    };
  }

  session.messages.push(message);
  session.updatedAt = Date.now();
  await db.saveSession(session);

  // Mirror to Supabase so the web dashboard sees it in realtime.
  void upsertSessionToCloud(session);

  // Mirror to VS Code bridge (fire-and-forget — bridge may not be running)
  fetch(`${BRIDGE_URL}/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "BROWSER_CONTEXT", session }),
  }).catch(() => { });
}

async function handleCaptureSession(payload: {
  platform: string;
  sessionId: string;
  title: string;
  messages: Message[];
}) {
  // ── DIAGNOSTIC STAGE 2 — service worker received the capture ────────────────
  const rxUser = payload.messages.filter(m => m.role === "user").length;
  const rxAsst = payload.messages.filter(m => m.role === "assistant").length;
  console.log(`[ContextForge:sw] Stage2 — CAPTURE_SESSION received: platform=${payload.platform} session=${payload.sessionId} total=${payload.messages.length} user=${rxUser} assistant=${rxAsst}`);
  if (rxAsst === 0 && rxUser > 0) {
    console.error(`[ContextForge:sw] Stage2 — ASSISTANT MESSAGES MISSING in incoming payload. Bug is in Stage1 (content script).`);
  }

  const existing = await db.getSession(payload.sessionId);
  const createdAt = existing?.createdAt ?? Date.now();
  const updatedAt =
    payload.messages[payload.messages.length - 1]?.timestamp ?? Date.now();

  const session: ContextSession = {
    id: payload.sessionId,
    platform: payload.platform as ContextSession["platform"],
    createdAt,
    updatedAt,
    title: payload.title,
    messages: payload.messages,
  };

  await db.saveSession(session);

  // Mirror to Supabase so the web dashboard sees it in realtime.
  void upsertSessionToCloud(session);

  // ── DIAGNOSTIC STAGE 3 — read back from IndexedDB to verify persistence ────
  const saved = await db.getSession(payload.sessionId);
  const savedUser = saved?.messages.filter(m => m.role === "user").length ?? 0;
  const savedAsst = saved?.messages.filter(m => m.role === "assistant").length ?? 0;
  console.log(`[ContextForge:sw] Stage3 — DB readback: total=${saved?.messages.length ?? 0} user=${savedUser} assistant=${savedAsst}`);
  if (savedAsst === 0 && savedUser > 0) {
    console.error(`[ContextForge:sw] Stage3 — ASSISTANT MESSAGES MISSING after DB save. IndexedDB corruption or payload was already broken.`);
  }

  // Push an instant refresh notification to any open extension view (sidebar).
  void broadcastToViews({ type: "SESSIONS_UPDATED" });

  fetch(`${BRIDGE_URL}/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "BROWSER_CONTEXT", session }),
  }).catch(() => { });
}

async function handleMigrateContext(
  payload: {
    sessionId: string;
    targetPlatform: string;
    targetTabId?: number;
    caveman?: boolean;
    task?: string;
    strength?: "light" | "strict";
    useAttentionEngine?: boolean;
    precomputedSummary?: string;
    precomputedAttentionMap?: unknown;
  },
  sendResponse: (r: unknown) => void
) {
  // ── DIAGNOSTIC STAGE 4 — load session from IndexedDB ──────────────────────
  const session = await db.getSession(payload.sessionId);
  if (!session) return sendResponse({ error: "Session not found in storage." });

  const s4User = session.messages.filter(m => m.role === "user").length;
  const s4Asst = session.messages.filter(m => m.role === "assistant").length;
  console.log(`[ContextForge:sw] Stage4 — session loaded: total=${session.messages.length} user=${s4User} assistant=${s4Asst}`);

  if (session.messages.length === 0) {
    return sendResponse({ error: "Session has no messages. Nothing to migrate." });
  }
  if (s4Asst === 0) {
    console.warn(`[ContextForge:sw] Stage4 — assistant messages missing from stored session. Migration will proceed with user-only context (degraded).`);
  }

  // ── DIAGNOSTIC STAGE 5 — summarizer ──────────────────────────────────────
  console.log(`[ContextForge:sw] Stage5 — calling summarizer with ${session.messages.length} messages`);

  let summary: string;
  let extracted: ExtractedContext | undefined;
  let attentionMap: unknown;

  if (payload.useAttentionEngine && payload.task) {
    if (payload.precomputedSummary) {
      // Fast path: sidebar pre-computed the summary — no model inference needed here.
      summary = payload.precomputedSummary;
      attentionMap = payload.precomputedAttentionMap;
      console.log(`[ContextForge:sw] Stage5 — Attention Engine fast path (pre-computed by sidebar)`);
    } else {
      // Slow fallback: compute in service worker (first migration with no live preview).
      console.log(`[ContextForge:sw] Stage5 — Attention Engine path: task="${payload.task.slice(0, 60)}" strength=${payload.strength ?? "light"}`);
      const atResult = await summarizeWithAttention(
        session.messages,
        payload.task,
        payload.strength ?? "light",
        session
      );
      summary = atResult.summary;
      attentionMap = atResult.attentionMap;
      console.log(`[ContextForge:sw] Stage5 — Attention Engine done`);
      console.log(`[ContextForge:attention] compressionRatio: ${atResult.compressionRatio}%`);
    }
  } else {
    const summaryResult = await summarize(session.messages, { caveman: payload.caveman });
    summary = summaryResult.content;
    extracted = summaryResult.extracted;
    console.log(`[ContextForge:sw] Stage5 — summarizer done: mode=${summaryResult.mode} tokens~${summaryResult.originalTokenEstimate} codeBlocks=${summaryResult.extracted.codeBlocks.length} tailMessages=${summaryResult.extracted.conversationTail.length}`);
    const tailAsst = summaryResult.extracted.conversationTail.filter(m => m.role === "assistant").length;
    if (tailAsst === 0) {
      console.error(`[ContextForge:sw] Stage5 — conversationTail has no assistant messages`);
    }
  }

  // Pull IDE context if bridge is available (fire-and-forget, non-blocking)
  let ideContext: string | undefined;
  try {
    const res = await fetch(`${BRIDGE_URL}/context`);
    if (res.ok) ideContext = (await res.json()).ideContext;
  } catch { /* bridge offline is normal */ }

  // ── DIAGNOSTIC STAGE 6 — translator ──────────────────────────────────────
  const prompt = buildMigrationPrompt({
    summary,
    extracted,
    ideContext,
    targetPlatform: payload.targetPlatform as ContextSession["platform"],
    sourceSession: session,
    caveman: payload.caveman,
    task: payload.task,
    attentionMap,
  });

  console.log(`[ContextForge:sw] Stage6 — prompt built: length=${prompt.length} chars, target=${payload.targetPlatform}`);
  if (prompt.length < 500) {
    console.error(`[ContextForge:sw] Stage6 — prompt suspiciously short (${prompt.length} chars), context likely lost`);
    return sendResponse({
      error: `Migration prompt is too short (${prompt.length} chars) — context was lost during summarization. Check console for Stage1–5 errors.`,
    });
  }
  console.log(`[ContextForge:sw] Stage6 — prompt preview (first 400 chars):\n${prompt.slice(0, 400)}`);

  // ── Inject into target tab ─────────────────────────────────────────────────
  if (payload.targetTabId) {
    const injectionResult = await sendMessageToTab(payload.targetTabId, {
      type: "INJECT_CONTEXT",
      prompt,
      platform: payload.targetPlatform,
    });

    if (!injectionResult.ok) {
      return sendResponse({
        error: injectionResult.error ??
          "Could not inject into the active tab. Open the selected AI platform in the active tab, then try again.",
      });
    }
    console.log(`[ContextForge:sw] Stage6 — injection confirmed in tab ${payload.targetTabId}`);
  }

  sendResponse({ ok: true, prompt });
}

async function handleFetchIdeContext(sendResponse: (r: unknown) => void) {
  try {
    const res = await fetch(`${BRIDGE_URL}/context`);
    if (!res.ok) return sendResponse({ error: "Bridge not reachable" });
    sendResponse(await res.json());
  } catch {
    sendResponse({ error: "Bridge not reachable" });
  }
}

async function syncOpenTabs() {
  for (const [platform, patterns] of Object.entries(PLATFORM_URLS)) {
    const tabs = await chrome.tabs.query({ url: [...patterns] });

    for (const tab of tabs) {
      if (!tab.id) continue;

      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: scrapeSessionFromPage,
          args: [platform],
        });

        const snapshot = result?.result;
        if (!snapshot || !Array.isArray(snapshot.messages) || snapshot.messages.length === 0) {
          continue;
        }

        // Resolve the session id via the URL map (with legacy fallback) instead
        // of trusting an id minted inside the page — keeps deletes durable.
        const sessionId = await resolveSessionId(
          platform as "claude" | "chatgpt" | "gemini" | "grok",
          tab.url ?? "",
          async (legacyId) => !!(await db.getSession(legacyId))
        );

        await handleCaptureSession({
          platform,
          sessionId,
          title: snapshot.title,
          messages: snapshot.messages,
        });
      } catch (error) {
        console.warn("[ContextForge] Tab sync failed:", platform, tab.id, error);
      }
    }
  }
}

function scrapeSessionFromPage(platform: string) {
  function stableSessionId() {
    const stableUrl = `${window.location.hostname}${window.location.pathname}${window.location.search}`.replace(/\/$/, "");
    const hash = stableUrl.split("").reduce((acc, char) => {
      return (acc * 31 + char.charCodeAt(0)) >>> 0;
    }, 7);

    return `${platform}-${hash.toString(36)}`;
  }

  function normalize(text: string) {
    return text.replace(/\s+/g, " ").trim();
  }

  let messages: Array<{ role: "user" | "assistant"; content: string; timestamp: number }> = [];

  if (platform === "chatgpt") {
    messages = Array.from(
      document.querySelectorAll<HTMLElement>("[data-message-author-role]")
    )
      .map((el) => {
        const role = el.dataset.messageAuthorRole as "user" | "assistant";
        const content = el.innerText.trim();
        return content ? { role, content, timestamp: Date.now() } : null;
      })
      .filter(Boolean) as typeof messages;
  } else if (platform === "claude") {
    type Entry = { el: HTMLElement; role: "user" | "assistant" };
    const collected: Entry[] = [];
    document.querySelectorAll<HTMLElement>('[data-testid="user-message"]').forEach((el) => {
      collected.push({ el, role: "user" });
    });
    document.querySelectorAll<HTMLElement>(
      '[data-testid="ai-turn"], [data-testid="assistant-message"]'
    ).forEach((el) => {
      if (!el.closest('[data-testid="user-message"]')) collected.push({ el, role: "assistant" });
    });
    if (collected.length === 0) {
      document.querySelectorAll<HTMLElement>(
        '[data-testid="human-turn"], [data-testid="ai-turn"]'
      ).forEach((el) => {
        const role = el.dataset.testid === "human-turn" ? "user" : "assistant";
        collected.push({ el, role });
      });
    }
    collected.sort((a, b) => {
      const rel = a.el.compareDocumentPosition(b.el);
      return rel & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    messages = collected
      .map(({ el, role }) => {
        const content = el.innerText.trim();
        return content ? { role, content, timestamp: Date.now() } : null;
      })
      .filter(Boolean) as typeof messages;
  } else if (platform === "gemini") {
    messages = Array.from(
      document.querySelectorAll<HTMLElement>("user-query .query-text, model-response .response-content")
    )
      .map((el) => {
        const role = el.closest("user-query") ? "user" : "assistant";
        const content = el.innerText.trim();
        return content ? { role, content, timestamp: Date.now() } : null;
      })
      .filter(Boolean) as typeof messages;
  } else if (platform === "grok") {
    messages = Array.from(
      document.querySelectorAll<HTMLElement>('[class*="UserMessage"], [class*="AssistantMessage"]')
    )
      .map((el) => {
        const role = el.className.includes("User") ? "user" : "assistant";
        const content = el.innerText.trim();
        return content ? { role, content, timestamp: Date.now() } : null;
      })
      .filter(Boolean) as typeof messages;
  }

  if (messages.length === 0) {
    return null;
  }

  const titleSource =
    messages.find((message) => message.role === "user")?.content ??
    messages[0]?.content ??
    "Untitled session";

  return {
    sessionId: stableSessionId(),
    title: normalize(titleSource).slice(0, 72),
    messages,
  };
}

// Self-contained prompt injector — serialised and run directly in the page
// via chrome.scripting.executeScript when the content script listener is absent.
// Must have ZERO imports / outer-scope references.
function injectPromptInPage(
  text: string,
  platform: string
): { ok: boolean; error?: string } {
  const SELECTORS: Record<string, string[]> = {
    perplexity: [
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="ask"]',
      'textarea[placeholder*="Search"]',
      '[contenteditable="true"][role="textbox"]',
      '.ProseMirror[contenteditable="true"]',
      'textarea:not([readonly])',
      '[contenteditable="true"]',
    ],
    deepseek: [
      '#chat-input',
      'textarea[placeholder*="Send"]',
      'textarea[placeholder*="Message"]',
      '[contenteditable="true"]',
      'textarea:not([readonly])',
    ],
    claude: [
      '.ProseMirror[contenteditable]',
      '[contenteditable="true"]',
    ],
    chatgpt: [
      '#prompt-textarea',
      '[contenteditable="true"]',
      'textarea',
    ],
    gemini: [
      '.ql-editor[contenteditable]',
      '[contenteditable="true"]',
    ],
    grok: [
      'textarea:not([readonly])',
      '[contenteditable="true"]',
    ],
  };

  const sels = SELECTORS[platform] ?? ['textarea:not([readonly])', '[contenteditable="true"]'];
  let input: HTMLElement | null = null;
  for (const sel of sels) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) { input = el; break; }
  }

  if (!input) {
    return {
      ok: false,
      error: `Input box not found on the ${platform} page. Make sure a conversation is open, then try again.`,
    };
  }

  input.focus();

  if (input instanceof HTMLTextAreaElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    nativeSetter?.call(input, text);
    input.dispatchEvent(new Event("input",  { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: input.value === text || input.value.length > 0 };
  }

  if (input.isContentEditable) {
    document.execCommand("selectAll", false, undefined);
    const inserted = document.execCommand("insertText", false, text);
    if (inserted && (input.textContent?.trim().length ?? 0) > 0) return { ok: true };

    // Fallback: innerText + synthetic InputEvent
    try {
      input.innerText = text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      if ((input.textContent?.trim().length ?? 0) > 0) return { ok: true };
    } catch { /* fall through */ }

    input.textContent = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    return { ok: (input.textContent?.trim().length ?? 0) > 0 };
  }

  return { ok: false, error: "Unrecognised input type on target page." };
}

async function sendMessageToTab(
  tabId: number,
  message: { type: "INJECT_CONTEXT"; prompt: string; platform: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);

    if (response?.ok) {
      return { ok: true };
    }

    if (response?.error) {
      return { ok: false, error: response.error };
    }

    return {
      ok: false,
      error: "The target tab did not confirm that the migrated prompt was inserted.",
    };
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "Unknown tab messaging error";
    console.warn("[ContextForge] Tab injection failed:", messageText);

    // Chrome throws this when the content script hasn't loaded in the tab yet
    // (tab opened before extension install, or extension was reloaded).
    // Fall back to a direct executeScript injection — no content script needed.
    if (messageText.includes("Receiving end does not exist") ||
        messageText.includes("Could not establish connection")) {
      console.log(`[ContextForge] Content script absent — falling back to executeScript injection for tab ${tabId}`);
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: injectPromptInPage,
          args: [message.prompt, message.platform],
        });
        const res = result?.result as { ok: boolean; error?: string } | undefined;
        if (res?.ok) {
          console.log(`[ContextForge] executeScript injection succeeded for tab ${tabId}`);
          return { ok: true };
        }
        return {
          ok: false,
          error: res?.error ?? "Direct page injection failed. Reload the target tab and try again.",
        };
      } catch (scriptErr) {
        const scriptMsg = scriptErr instanceof Error ? scriptErr.message : String(scriptErr);
        console.warn("[ContextForge] executeScript fallback failed:", scriptMsg);
        return {
          ok: false,
          error: `Could not reach the ${message.platform} tab: ${scriptMsg}. Try reloading that tab.`,
        };
      }
    }

    return { ok: false, error: messageText };
  }
}
