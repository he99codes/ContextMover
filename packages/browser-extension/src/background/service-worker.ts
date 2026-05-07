// packages/browser-extension/src/background/service-worker.ts
import { db } from "@/lib/db";
import summarize, { summarizeIntelligent, summarizeWithAttention } from "@/lib/summarizer";
import buildMigrationPrompt from "@/lib/translator";
import { promptEngine } from "@/lib/prompt-engine/engine";
import { capabilityDetector, type Tier } from "@/lib/capability-detector";
import type { ContextSession, ExtractedContext, Message } from "@/lib/types";
import { supabase } from "@/lib/supabase";
import { syncPromptTemplates, syncPromptAssignments } from "@/lib/cloud-sync";
import { userVault } from "@/lib/user-vault/connector";
import { forgetSession, resolveSessionId } from "@/lib/session-id";

// Sessions are stored ONLY in local IndexedDB.
// Optional: synced to user's personal Supabase vault via userVault.getClient().

// NOTE: sidebarOpenTabs removed — in-memory Set resets on every SW restart
// causing the toggle to always show as "closed". State is now derived live
// from chrome.runtime.getContexts() which reflects the actual browser state.

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

// [SECURITY] Pre-compiled regex from all platform globs — used in sender validation.
const PLATFORM_GLOB_RE = new RegExp(
  ALL_PLATFORM_URL_GLOBS
    .map((g) => "^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
    .join("|"),
  "i"
);

// [SECURITY] Sender origin helpers — every sensitive message handler must call one of these.
function isFromOwnExtension(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}
function isFromExtensionUI(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab;
}
function isFromPlatformTab(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id &&
    Boolean(sender.tab?.url && PLATFORM_GLOB_RE.test(sender.tab.url));
}
function payloadPlatformMatchesSender(
  platform: string,
  sender: chrome.runtime.MessageSender
): boolean {
  const url = sender.tab?.url ?? "";
  const globs = PLATFORM_URLS[platform as keyof typeof PLATFORM_URLS] ?? [];
  return globs.some((g) => {
    const re = new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
    return re.test(url);
  });
}

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
  const existing = await chrome.storage.local.get(["sessions"]);
  if (!existing.sessions) await chrome.storage.local.set({ sessions: [] });

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
  if (tab.id == null) return;
  chrome.sidePanel
    .open({ tabId: tab.id })
    .catch((err: unknown) => console.warn("[ContextForge] sidePanel.open failed:", err));
});

// ── Message Router ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log(`[ContextForge ServiceWorker] Received message: ${msg.type}`);
  (async () => {
    try {
    // [SECURITY] Reject messages from any source that is not our own extension.
    if (!isFromOwnExtension(sender)) {
      console.warn('[CF:sw] Rejected message from unknown sender:', sender.id, msg.type);
      sendResponse({ error: 'Unauthorized sender' });
      return;
    }
    switch (msg.type) {
      case "CAPTURE_SESSION": {
        // [SECURITY] Must come from a known platform tab.
        if (!isFromPlatformTab(sender)) {
          console.warn('[CF:sw] CAPTURE_SESSION from non-platform sender, rejected. url:', sender.tab?.url);
          sendResponse({ error: 'Sender is not a known platform tab' });
          break;
        }
        // [SECURITY] Validate payload schema before any DB write.
        const p = msg.payload as Record<string, unknown> | undefined;
        if (!p || typeof p.platform !== 'string' || typeof p.sessionId !== 'string' || !Array.isArray(p.messages)) {
          console.warn('[CF:sw] CAPTURE_SESSION invalid payload schema');
          sendResponse({ error: 'CAPTURE_SESSION: invalid payload schema' });
          break;
        }
        // [SECURITY] Claimed platform must match the actual tab URL.
        if (!payloadPlatformMatchesSender(p.platform, sender)) {
          console.warn(`[CF:sw] CAPTURE_SESSION platform mismatch: claimed=${p.platform} tab=${sender.tab?.url}`);
          sendResponse({ error: 'Platform claim does not match sender tab URL' });
          break;
        }
        console.log(`[CF:sw] CAPTURE_SESSION: ${p.platform} ${p.sessionId}`);
        await handleCaptureSession(msg.payload);
        sendResponse({ ok: true });
        // Notify sidebar toggle icon in this tab — fire-and-forget.
        if (sender.tab?.id) {
          void chrome.tabs.sendMessage(sender.tab.id, { type: "CAPTURE_STATUS_UPDATE", status: "capturing" }).catch(() => {});
          setTimeout(() => {
            if (sender.tab?.id) void chrome.tabs.sendMessage(sender.tab.id, { type: "CAPTURE_STATUS_UPDATE", status: "idle" }).catch(() => {});
          }, 3000);
        }
        break;
      }

      case "CAPTURE_MESSAGE": {
        // [SECURITY] Must come from a known platform tab.
        if (!isFromPlatformTab(sender)) {
          sendResponse({ error: 'Sender is not a known platform tab' });
          break;
        }
        console.log(`[ContextForge ServiceWorker] CAPTURE_MESSAGE: ${msg.payload.platform} ${msg.payload.sessionId}`);
        await handleCaptureMessage(msg.payload);
        sendResponse({ ok: true });
        break;
      }

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
        // [SECURITY] Destructive operation — only extension UI may trigger deletion.
        if (!isFromExtensionUI(sender)) {
          sendResponse({ error: 'DELETE_SESSION must originate from extension UI' });
          break;
        }
        await db.deleteSession(msg.sessionId);
        await forgetSession(msg.sessionId);
        void (async () => {
          try {
            const vaultClient = await userVault.getClient();
            if (!vaultClient) return;
            await vaultClient.from('cf_sessions').delete().eq('id', msg.sessionId);
          } catch { /* vault failure never blocks */ }
        })();
        void broadcastForgetToTabs(msg.sessionId);
        void broadcastToViews({ type: "SESSIONS_UPDATED" });
        sendResponse({ ok: true });
        break;

      case "SESSION_EXISTS": {
        // [SECURITY] Allow only from platform content scripts or extension UI.
        if (!isFromPlatformTab(sender) && !isFromExtensionUI(sender)) {
          sendResponse({ exists: false });
          break;
        }
        // Used by content scripts to check if a legacy hash-based session id
        // already exists so we can adopt it instead of orphaning it.
        const existing = await db.getSession(msg.sessionId);
        sendResponse({ exists: !!existing });
        break;
      }

      case "MIGRATE_CONTEXT":
        // [SECURITY] Migration must come from extension UI (sidebar/popup), never a content script.
        if (!isFromExtensionUI(sender)) {
          sendResponse({ error: 'MIGRATE_CONTEXT must originate from extension UI' });
          break;
        }
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
            const { data: { user: authUser } } = await supabase.auth.getUser();
            const uid = authUser?.id;
            if (uid) {
              void syncPromptTemplates(uid);
              void syncPromptAssignments(uid);
            }
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
        await supabase.auth.signOut();
        sendResponse({ ok: true });
        void broadcastToViews({ type: "AUTH_STATE_CHANGED" });
        break;
      }

      case "CLOUD_RESYNC_ALL": {
        const { data: { user: authUser } } = await supabase.auth.getUser();
        const uid = authUser?.id;
        if (uid) { void syncPromptTemplates(uid); void syncPromptAssignments(uid); }
        const local = await db.getAllSessions();
        let vaultSynced = 0;
        const vaultClient = await userVault.getClient();
        if (vaultClient) {
          for (const session of local) {
            try {
              await vaultClient.from('cf_sessions').upsert({
                id: session.id, platform: session.platform, title: session.title,
                messages: session.messages,
                message_count: session.messages.length,
                user_message_count: session.messages.filter((m) => m.role === 'user').length,
                assistant_message_count: session.messages.filter((m) => m.role === 'assistant').length,
                updated_at: new Date().toISOString(),
              }, { onConflict: 'id' });
              vaultSynced++;
            } catch { /* vault failure never blocks */ }
          }
          console.log(`[ContextForge:vault] Bulk synced ${vaultSynced}/${local.length} sessions to personal vault`);
        }
        sendResponse({ ok: true, count: local.length, vaultSynced });
        break;
      }

      case "VAULT_GET_STATUS": {
        const status = await userVault.testConnection();
        const config = await userVault.getConfig();
        sendResponse({ ...status, config });
        break;
      }

      case "VAULT_CONNECT_MANUAL": {
        // [SECURITY] Only from extension UI.
        if (!isFromExtensionUI(sender)) { sendResponse({ error: 'Unauthorized' }); break; }
        try {
          const config = await userVault.connectManual(msg.url, msg.anonKey);
          sendResponse({ ok: true, config });
        } catch (err) {
          sendResponse({ error: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      case "VAULT_INITIATE_OAUTH": {
        // [SECURITY] Only from extension UI.
        if (!isFromExtensionUI(sender)) { sendResponse({ error: 'Unauthorized' }); break; }
        try {
          await userVault.initiateOAuth();
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ error: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      case "VAULT_DISCONNECT": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: 'Unauthorized' }); break; }
        await userVault.disconnect();
        sendResponse({ ok: true });
        break;
      }

      case "VAULT_DELETE_DATA": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: 'Unauthorized' }); break; }
        try {
          await userVault.deleteAllVaultData();
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ error: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      case "VAULT_GET_CONFIG": {
        const cfg = await userVault.getConfig();
        sendResponse({ config: cfg });
        break;
      }

      case "TOGGLE_SIDEBAR": {
        if (sender.tab?.id == null) { sendResponse({ isOpen: false }); break; }
        const tabId = sender.tab.id;

        // Ask the browser directly — immune to SW restart state loss.
        let panelIsOpen = false;
        try {
          const contexts = await chrome.runtime.getContexts({
            contextTypes: ["SIDE_PANEL" as chrome.runtime.ContextType],
          });
          // A SIDE_PANEL context exists means our panel is currently open.
          panelIsOpen = contexts.length > 0;
        } catch {
          panelIsOpen = false; // getContexts unavailable — assume closed
        }

        if (panelIsOpen) {
          await (chrome.sidePanel as unknown as { close(d: { tabId: number }): Promise<void> })
            .close({ tabId })
            .catch(() => {});
          sendResponse({ isOpen: false });
        } else {
          await chrome.sidePanel
            .open({ tabId })
            .then(() => sendResponse({ isOpen: true }))
            .catch((err: unknown) => sendResponse({ error: String(err), isOpen: false }));
        }
        break;
      }

      default:
        sendResponse({ error: `Unknown message type: ${msg.type}` });
    }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[CF:sw] Unhandled error in ${msg.type} handler:`, err);
      sendResponse({ error: errMsg });
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

  // Sync to user's personal vault if connected. Never blocks local capture.
  void (async () => {
    try {
      const vaultClient = await userVault.getClient();
      if (!vaultClient) return;
      await vaultClient.from('cf_sessions').upsert({
        id: session.id, platform: session.platform, title: session.title,
        messages: session.messages,
        message_count: session.messages.length,
        user_message_count: session.messages.filter((m) => m.role === 'user').length,
        assistant_message_count: session.messages.filter((m) => m.role === 'assistant').length,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
    } catch (err) { console.warn('[ContextForge:vault] CAPTURE_MESSAGE sync failed:', err); }
  })();

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
  // ── [CF:sw] received ────────────────────────────────────────────────────────
  const rxUser = payload.messages.filter(m => m.role === "user").length;
  const rxAsst = payload.messages.filter(m => m.role === "assistant").length;
  console.log('[CF:sw] received', { platform: payload.platform, session: payload.sessionId, total: payload.messages.length, user: rxUser, assistant: rxAsst });
  if (rxAsst === 0 && rxUser > 0) {
    console.error('[CF:sw] received — ASSISTANT MESSAGES MISSING in payload (Stage1 content script bug)');
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
  console.log('[CF:sw] saved', { session: session.id, total: session.messages.length });

  console.log('[ContextForge] Session stored locally only. No cloud sync unless user connects personal Supabase.');

  // Sync to user's personal vault if connected. Never blocks local capture.
  void (async () => {
    try {
      const vaultClient = await userVault.getClient();
      if (!vaultClient) return;
      await vaultClient.from('cf_sessions').upsert({
        id: session.id, platform: session.platform, title: session.title,
        messages: session.messages,
        message_count: session.messages.length,
        user_message_count: session.messages.filter((m) => m.role === 'user').length,
        assistant_message_count: session.messages.filter((m) => m.role === 'assistant').length,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      console.log(`[ContextForge:vault] Synced session ${session.id} to user's Supabase (${session.messages.length} messages)`);
    } catch (err) { console.warn('[ContextForge:vault] Sync failed:', err); }
  })();

  // ── [CF:sw] verified — read back from IndexedDB to confirm integrity ─────
  const saved = await db.getSession(payload.sessionId);
  const savedUser = saved?.messages.filter(m => m.role === "user").length ?? 0;
  const savedAsst = saved?.messages.filter(m => m.role === "assistant").length ?? 0;
  console.log('[CF:sw] verified', { total: saved?.messages.length ?? 0, user: savedUser, assistant: savedAsst, ok: saved !== undefined });
  if (!saved) {
    console.error('[CF:sw] verified — FAILED: session not found in IndexedDB after save');
  } else if (savedAsst === 0 && savedUser > 0) {
    console.error('[CF:sw] verified — ASSISTANT MESSAGES MISSING after DB save');
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
    tier?: 1 | 2 | 3;
    caveman?: boolean;
    task?: string;
    strength?: "light" | "strict";
    useAttentionEngine?: boolean;
    precomputedSummary?: string;
    precomputedAttentionMap?: unknown;
    promptTemplateId?: string | null;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let intelligentSummary: any;
  let compressionRatio = 0;

  // ── Resolve tier: explicit > attention-engine flag > capability auto-detect ──
  // Capability detector returns minimal | balanced | full — we map back to the
  // existing 1 | 2 | 3 numeric tier the summarizer/translator already speak:
  //   minimal  → 2 (summarizeIntelligent, regex extraction, <100ms)
  //   balanced → 3 (Attention Engine, WASM, 2 threads)
  //   full     → 3 (Attention Engine, WebGPU when available, 4 threads)
  let tier: 1 | 2 | 3;
  let detectedTier: Tier | null = null;
  if (payload.tier) {
    tier = payload.tier;
  } else if (payload.useAttentionEngine) {
    tier = 3;
  } else {
    detectedTier = await capabilityDetector.getEffectiveTier().catch(() => "balanced" as Tier);
    tier = detectedTier === "minimal" ? 2 : 3;
    console.log(`[ContextForge:sw] Auto-tier: capability=${detectedTier} → numeric tier=${tier}`);
  }

  // ── Start the load watchdog around tier-3 work — it can fire at any time ──
  // and the AttentionEngine listens via capabilityDetector.onDowngrade(). When
  // it fires, the engine drops its model and subsequent embed calls fall
  // through to keyword scoring — same behavior as if minimal had been picked
  // from the start, but without aborting the in-flight migration.
  const stopWatchdog =
    tier === 3
      ? capabilityDetector.monitorLoad(detectedTier ?? "balanced")
      : () => { /* tier 1/2 finish in <500ms, no watchdog needed */ };

  try {
  if (tier === 3 || (payload.useAttentionEngine && payload.task)) {
    // Tier 3 — Attention Engine
    if (payload.precomputedSummary) {
      summary = payload.precomputedSummary;
      attentionMap = payload.precomputedAttentionMap;
      compressionRatio = (payload.precomputedAttentionMap as any)?.compressionRatio ?? 0;
      console.log(`[ContextForge:sw] Stage5 — Attention Engine fast path (pre-computed by sidebar)`);
    } else {
      console.log(`[ContextForge:sw] Stage5 — Attention Engine path: strength=${payload.strength ?? "light"}`);
      try {
        // Warm up the singleton engine at the resolved tier so the model + ONNX
        // settings match capability detection.  No-op if already initialized.
        const { attentionEngine } = await import("@/lib/attention-engine");
        const engineTier: Tier = detectedTier ?? (payload.useAttentionEngine ? "balanced" : "balanced");
        await attentionEngine.initialize(undefined, engineTier).catch((err) => {
          console.warn("[ContextForge:sw] attention engine init failed, will fallback:", err);
        });
        const atResult = await summarizeWithAttention(
          session.messages,
          payload.task ?? "",
          payload.strength ?? "light",
          session
        );
        summary = atResult.summary;
        attentionMap = atResult.attentionMap;
        compressionRatio = atResult.compressionRatio;
        console.log(`[ContextForge:sw] Stage5 — Attention Engine done`);
        console.log(`[ContextForge:attention] compressionRatio: ${atResult.compressionRatio}%`);
      } catch (atErr) {
        // Attention Engine requires browser APIs (window, document, WebGPU) that
        // are unavailable in the service worker. Pre-computing in the sidebar
        // (AttentionModal) is the correct path — fall back to tier2 here.
        const atMsg = atErr instanceof Error ? atErr.message : String(atErr);
        const isBrowserApiErr = atMsg.includes("window is not defined") ||
          atMsg.includes("document is not defined") ||
          atMsg.includes("navigator is not defined") ||
          atMsg.includes("is not defined");
        if (isBrowserApiErr) {
          console.warn(
            "[CF:sw] Attention Engine unavailable in SW (browser APIs absent) — falling back to tier2.",
            "Use the sidebar's 'Attention' tab to pre-compute before migrating."
          );
          tier = 2;
          const isResult = summarizeIntelligent(session.messages);
          intelligentSummary = isResult;
          compressionRatio = isResult.compressionRatio;
          summary = isResult.goal;
          console.log(`[ContextForge:sw] tier=2 (fallback) compression=${compressionRatio}% chars=${JSON.stringify(isResult).length}`);
        } else {
          throw atErr;
        }
      }
    }
  } else if (tier === 2) {
    // Tier 2 — summarizeIntelligent (synchronous, no ML)
    const isResult = summarizeIntelligent(session.messages);
    intelligentSummary = isResult;
    compressionRatio = isResult.compressionRatio;
    summary = isResult.goal;
    console.log(`[ContextForge:sw] tier=2 compression=${compressionRatio}% chars=${JSON.stringify(isResult).length}`);
  } else {
    // Tier 1 — summarize
    const summaryResult = await summarize(session.messages, { caveman: payload.caveman });
    summary = summaryResult.content;
    extracted = summaryResult.extracted;
    compressionRatio = summaryResult.originalTokenEstimate > 0
      ? Math.round((1 - summaryResult.summaryTokenEstimate / summaryResult.originalTokenEstimate) * 100)
      : 0;
    console.log(`[ContextForge:sw] Stage5 — summarizer done: mode=${summaryResult.mode} tokens~${summaryResult.originalTokenEstimate} codeBlocks=${summaryResult.extracted.codeBlocks.length} tailMessages=${summaryResult.extracted.conversationTail.length}`);
    const tailAsst = summaryResult.extracted.conversationTail.filter(m => m.role === "assistant").length;
    if (tailAsst === 0) {
      console.error(`[ContextForge:sw] Stage5 — conversationTail has no assistant messages`);
    }
  }
  } finally {
    // Always stop the load watchdog — even on summarizer error — to avoid a
    // dangling setInterval bleeding CPU between migrations.
    stopWatchdog();
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
    tier,
    compressionRatio,
    intelligentSummary,
  });
  console.log(`[ContextForge:sw] tier=${tier} compression=${compressionRatio}% chars=${prompt.length}`);

  console.log(`[ContextForge:sw] Stage6 — prompt built: length=${prompt.length} chars, target=${payload.targetPlatform}`);
  if (prompt.length < 500) {
    console.error(`[ContextForge:sw] Stage6 — prompt suspiciously short (${prompt.length} chars), context likely lost`);
    return sendResponse({
      error: `Migration prompt is too short (${prompt.length} chars) — context was lost during summarization. Check console for Stage1–5 errors.`,
    });
  }

  // ── Prompt Engine template injection (never blocks migration) ─────────────
  let finalPrompt = prompt;
  if (payload.promptTemplateId) {
    try {
      const mergeResult = await promptEngine.mergeWithContext(
        prompt,
        payload.promptTemplateId,
        payload.targetPlatform,
        payload.caveman ?? false
      );
      finalPrompt = mergeResult.finalContext;
      console.log(
        `[ContextForge:prompt-engine] template="${mergeResult.templateName}"`,
        `totalChars=${mergeResult.stats.totalLength}`,
        `estimatedTokens=${mergeResult.stats.estimatedTokens}`
      );
    } catch (err) {
      console.warn("[ContextForge:prompt-engine] failed, migrating without template:", err);
    }
  }

  // ── Priority-ordered prompt cap ───────────────────────────────────────────
  // Per-platform safe limits — editor engine determines the ceiling:
  //   Claude   (ProseMirror) — very tolerant, tested to 200k+
  //   Gemini   (Quill)       — tolerant, tested to 150k+
  //   ChatGPT  (CodeMirror)  — starts lagging ~80k; cap at 80k
  //   Others   (various)     — conservative 60k until tested further
  //
  // Priority order (never drop P1–P3):
  //   P1 — metadata, primaryGoal, currentFocus, decisions  (always kept)
  //   P2 — code blocks  (kept newest-first; oldest pruned until budget fits)
  //   P3 — last 6 verbatim messages + instructions  (always kept)
  //   P4 — middle messages  (already compressed by summariser; no standalone section)
  //
  // Strategy: rebuild from structured components with progressively fewer
  // code blocks (oldest dropped first) rather than slicing the flat string.
  const PLATFORM_MAX_CHARS: Partial<Record<string, number>> = {
    claude:     120_000,
    gemini:     120_000,
    chatgpt:     80_000,
    grok:        80_000,
    perplexity:  60_000,
    deepseek:    80_000,
  };
  const MAX_PROMPT_CHARS = PLATFORM_MAX_CHARS[payload.targetPlatform] ?? 80_000;
  if (finalPrompt.length > MAX_PROMPT_CHARS) {
    const beforeChars = finalPrompt.length;

    // Helper: rebuild base prompt with a given code-block array.
    const buildWith = (codeBlocks: unknown[]): string =>
      buildMigrationPrompt({
        summary,
        extracted: tier !== 2 && extracted
          ? { ...extracted, codeBlocks: codeBlocks as typeof extracted.codeBlocks }
          : extracted,
        intelligentSummary: tier === 2 && intelligentSummary
          ? { ...intelligentSummary, codeBlocks: codeBlocks }
          : intelligentSummary,
        ideContext,
        targetPlatform: payload.targetPlatform as ContextSession["platform"],
        sourceSession: session,
        caveman: payload.caveman,
        task: payload.task,
        attentionMap,
        tier,
        compressionRatio,
      });

    // Collect the active code-block array (newest are last; prune from front = oldest).
    const allBlocks: unknown[] =
      tier === 2
        ? ((intelligentSummary as { codeBlocks?: unknown[] } | undefined)?.codeBlocks ?? [])
        : (extracted?.codeBlocks ?? []);

    let rebuilt = finalPrompt;
    if (allBlocks.length > 0) {
      // Walk from (N-1) kept blocks down to 0, stopping when it fits.
      for (let keep = allBlocks.length - 1; keep >= 0; keep--) {
        const candidate = buildWith(allBlocks.slice(allBlocks.length - keep));
        if (candidate.length <= MAX_PROMPT_CHARS) {
          rebuilt = candidate;
          const dropped = allBlocks.length - keep;
          console.warn(
            `[ContextForge:sw] Priority cap: dropped ${dropped} oldest code block(s) ` +
            `(P1/P3 preserved). ${beforeChars.toLocaleString()} → ${rebuilt.length.toLocaleString()} chars`
          );
          break;
        }
      }
    }

    // Last-resort fallback: P1+P3 alone exceeds 30k (extremely unusual).
    if (rebuilt.length > MAX_PROMPT_CHARS) {
      const headChars = Math.floor(MAX_PROMPT_CHARS * 0.7);
      const tailChars = MAX_PROMPT_CHARS - headChars - 200;
      const dropped = rebuilt.length - headChars - tailChars;
      rebuilt =
        rebuilt.slice(0, headChars) +
        `\n\n... [ContextForge: ${dropped.toLocaleString()} chars trimmed — all code blocks removed, structured sections preserved] ...\n\n` +
        rebuilt.slice(-tailChars);
      console.warn(
        `[ContextForge:sw] Priority cap fallback: ${beforeChars.toLocaleString()} → ${rebuilt.length.toLocaleString()} chars`
      );
    }

    finalPrompt = rebuilt;
  }

  // ── Inject into target tab ─────────────────────────────────────────────────
  if (payload.targetTabId) {
    // Domain whitelist guard — INJECT_CONTEXT must only fire on a known platform page.
    const targetTab = await chrome.tabs.get(payload.targetTabId).catch(() => null);
    if (!targetTab?.url) {
      return sendResponse({ error: "Target tab not found or URL unavailable." });
    }
    const allowedGlobs = PLATFORM_URLS[payload.targetPlatform as keyof typeof PLATFORM_URLS] ?? [];
    const domainAllowed = allowedGlobs.some((glob) => {
      const pattern = new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return pattern.test(targetTab.url!);
    });
    if (!domainAllowed) {
      console.error(`[CF:sw] injection blocked — tab ${payload.targetTabId} (${targetTab.url}) not whitelisted for platform=${payload.targetPlatform}`);
      return sendResponse({ error: `The active tab (${targetTab.url}) is not a ${payload.targetPlatform} page. Open ${payload.targetPlatform} in the target tab and try again.` });
    }
    console.log(`[CF:sw] injection domain verified: ${targetTab.url} → ${payload.targetPlatform}`);
    const injectionResult = await sendMessageToTab(payload.targetTabId, {
      type: "INJECT_CONTEXT",
      prompt: finalPrompt,
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

  sendResponse({ ok: true, prompt: finalPrompt, compressionRatio });
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
      'textarea#ask',
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
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="message"]',
      'textarea[placeholder*="Ask"]',
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
