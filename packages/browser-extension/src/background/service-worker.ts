// packages/browser-extension/src/background/service-worker.ts
import { db } from "@/lib/db";
import summarize from "@/lib/summarizer";
import buildMigrationPrompt from "@/lib/translator";
import type { ContextSession, Message } from "@/lib/types";

const BRIDGE_URL = "http://localhost:49152";
const PLATFORM_URLS = {
  claude: ["https://claude.ai/*"],
  chatgpt: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  gemini: ["https://gemini.google.com/*"],
  grok: ["https://grok.com/*", "https://grok.x.ai/*"],
} as const;

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
        sendResponse({ ok: true });
        break;

      case "MIGRATE_CONTEXT":
        await handleMigrateContext(msg.payload, sendResponse);
        break;

      case "FETCH_IDE_CONTEXT":
        await handleFetchIdeContext(sendResponse);
        break;

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

  // ── DIAGNOSTIC STAGE 3 — read back from IndexedDB to verify persistence ────
  const saved = await db.getSession(payload.sessionId);
  const savedUser = saved?.messages.filter(m => m.role === "user").length ?? 0;
  const savedAsst = saved?.messages.filter(m => m.role === "assistant").length ?? 0;
  console.log(`[ContextForge:sw] Stage3 — DB readback: total=${saved?.messages.length ?? 0} user=${savedUser} assistant=${savedAsst}`);
  if (savedAsst === 0 && savedUser > 0) {
    console.error(`[ContextForge:sw] Stage3 — ASSISTANT MESSAGES MISSING after DB save. IndexedDB corruption or payload was already broken.`);
  }

  // Push an instant refresh notification to any open extension view (sidebar).
  chrome.runtime.sendMessage({ type: "SESSIONS_UPDATED" }).catch(() => { /* no listener open */ });

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

  // ── DIAGNOSTIC STAGE 5 — summarizer ───────────────────────────────────────
  console.log(`[ContextForge:sw] Stage5 — calling summarizer with ${session.messages.length} messages`);
  const summaryResult = await summarize(session.messages);
  console.log(`[ContextForge:sw] Stage5 — summarizer done: mode=${summaryResult.mode} tokens~${summaryResult.originalTokenEstimate} codeBlocks=${summaryResult.extracted.codeBlocks.length} tailMessages=${summaryResult.extracted.conversationTail.length}`);
  const tailAsst = summaryResult.extracted.conversationTail.filter(m => m.role === "assistant").length;
  if (tailAsst === 0) {
    console.error(`[ContextForge:sw] Stage5 — conversationTail has no assistant messages`);
  }

  // Pull IDE context if bridge is available (fire-and-forget, non-blocking)
  let ideContext: string | undefined;
  try {
    const res = await fetch(`${BRIDGE_URL}/context`);
    if (res.ok) ideContext = (await res.json()).ideContext;
  } catch { /* bridge offline is normal */ }

  // ── DIAGNOSTIC STAGE 6 — translator ───────────────────────────────────────
  const prompt = buildMigrationPrompt({
    summary: summaryResult.content,
    extracted: summaryResult.extracted,
    ideContext,
    targetPlatform: payload.targetPlatform as ContextSession["platform"],
    sourceSession: session,
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

        await handleCaptureSession({
          platform,
          sessionId: snapshot.sessionId,
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
    if (messageText.includes("Receiving end does not exist") ||
        messageText.includes("Could not establish connection")) {
      return {
        ok: false,
        error:
          "The content script is not running in the target tab. " +
          "Please reload that tab (press F5 while on the AI platform page), then try migrating again.",
      };
    }

    return { ok: false, error: messageText };
  }
}
