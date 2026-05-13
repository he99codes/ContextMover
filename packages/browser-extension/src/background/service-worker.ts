// packages/browser-extension/src/background/service-worker.ts
import { db, sessionCache } from "@/lib/db";
import { migrateFromContextForge } from "@/lib/db-migration";
import summarize, { summarizeIntelligent, summarizeWithAttention } from "@/lib/summarizer";
import buildMigrationPrompt from "@/lib/translator";
import { promptEngine } from "@/lib/prompt-engine/engine";
import { capabilityDetector, type Tier } from "@/lib/capability-detector";
import type { ContextSession, ExtractedContext, Message } from "@/lib/types";
import { supabase } from "@/lib/supabase";
import { syncPromptTemplates, syncPromptAssignments, queueVaultSync } from "@/lib/cloud-sync";
import { getHardwareProfile } from "@/lib/attention-engine";
import { semanticIndex } from "@/lib/semantic-index/index";
import { perf } from "@/lib/perf/metrics";
import { scoreMigration, formatScoreReport, type QualityScore } from "@/lib/quality/migration-scorer";
import { generateQualityReport } from "@/lib/quality/report-generator";
import { userVault } from "@/lib/user-vault/connector";
import { forgetSession, resolveSessionId } from "@/lib/session-id";
import { WEBAPP_URL } from "@/config/urls";
import { getMcpClient, connectToFirstAvailableMcp, type IdeContext } from "@/lib/mcp/client";

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

// ── MCP local bridge (ContextMover) ─────────────────────────────────────────
// Loopback HTTP server provided by `@contextmover/mcp-server`. Optional —
// the extension functions identically without it. Fire-and-forget syncing
// makes captured sessions instantly available in Cursor / Windsurf / VS Code
// (Continue.dev) / Claude Desktop via MCP tools.
const MCP_BRIDGE_URL = "http://127.0.0.1:49001";

async function syncToMcpBridge(session: ContextSession): Promise<void> {
  try {
    // 2 s timeout: bridge should be local; if it can't respond fast,
    // assume not running and bail.
    const res = await fetch(`${MCP_BRIDGE_URL}/sessions`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        id:           session.id,
        platform:     session.platform,
        title:        session.title,
        messages:     session.messages.map(m => ({ role: m.role, content: m.content })),
        createdAt:    session.createdAt,
        updatedAt:    session.updatedAt,
        messageCount: session.messages.length,
        hasCode:      session.messages.some(m => /```/.test(m.content)),
      }),
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) {
      console.log("[CM:sw] Synced to MCP bridge:", session.id);
    }
  } catch {
    // Bridge not running — silently ignore. Most users will never install
    // the MCP server, and we never want to noise up the console for them.
  }
}

// Push chunk embeddings for a session to the MCP bridge so the IDE-side
// `semantic_search` tool can find them. Best-effort; never blocks capture.
async function syncEmbeddingsToMcpBridge(sessionId: string): Promise<void> {
  try {
    const chunks = await db.chunkEmbeddings.where("sessionId").equals(sessionId).toArray();
    if (chunks.length === 0) return;

    // Strip Dexie-internal fields and ensure embeddings are plain number arrays.
    // The IDB store keeps embeddings as Float32Array — Float32Array is JSON-
    // serialisable as a plain array, so spread into Array.from() to be safe
    // across browser implementations.
    const payload = chunks.map((c, i) => ({
      id:           c.id,
      chunkIndex:   typeof c.chunkIndex === "number" ? c.chunkIndex : i,
      text:         c.text,
      embedding:    Array.from(c.embedding as ArrayLike<number>),
      role:         c.role,
      messageIndex: typeof c.messageIndex === "number" ? c.messageIndex : i,
      hasCode:      Boolean(c.hasCode),
      language:     c.language ?? undefined,
    }));

    const res = await fetch(`${MCP_BRIDGE_URL}/embeddings`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ sessionId, chunks: payload }),
      // 5 s — embeddings payloads can be a few MB.
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      console.log(`[CM:sw] Synced ${payload.length} embeddings for ${sessionId}`);
    }
  } catch {
    /* bridge offline — ignore */
  }
}

// Push a tier-1 / tier-2 summary to the MCP bridge so it can be used by
// `migrate_context` and the `contextmover://summary` resource.
async function syncSummaryToMcpBridge(sessionId: string, tier: number, content: string): Promise<void> {
  try {
    await fetch(`${MCP_BRIDGE_URL}/summaries`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ sessionId, tier, content }),
      signal:  AbortSignal.timeout(2_000),
    });
  } catch {
    /* bridge offline — ignore */
  }
}

// Push user-selected project files to the MCP bridge so `get_file_context`
// and `migrate_context` can include them in IDE prompts.
interface FileSyncEntry {
  path:      string;
  content:   string;
  language?: string;
  size:      number;
}
async function syncFilesToMcpBridge(files: FileSyncEntry[]): Promise<void> {
  if (files.length === 0) return;
  try {
    await fetch(`${MCP_BRIDGE_URL}/files`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ files }),
      // 10 s — file payloads can be large (whole project).
      signal:  AbortSignal.timeout(10_000),
    });
  } catch {
    /* bridge offline — ignore */
  }
}

// IDB write buffer — debounces rapid CAPTURE_SESSION calls so only 1 IDB write
// fires per session per 200ms window instead of one per DOM mutation burst.
const pendingWrites = new Map<string, ContextSession>();
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

// In-flight capture lock — prevents the same session being written to IDB twice
// simultaneously (e.g. content script + syncOpenTabs both firing at once).
const captureInFlight = new Set<string>();

// GET_SESSIONS result cache — coalesces rapid-fire sidebar polls within 500ms.
let getSessionsCache: unknown = null;
let getSessionsCacheAt = 0;
const GET_SESSIONS_CACHE_MS = 500;

// Injection guard — tracks tabs already scripted this SW lifetime to prevent
// the same tab being injected 3× on rapid onInstalled/onStartup events.
const injectedTabs = new Set<number>();

// Precomputed summary cache — populated by PRECOMPUTE_SUMMARY, consumed by MIGRATE_CONTEXT.
// Avoids repeating expensive tier-1/tier-2 summarization on the critical migration path.
interface PrecomputeEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tier1: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tier2: any;
  cachedAt: number;
}
const precomputeCache = new Map<string, PrecomputeEntry>();
const PRECOMPUTE_TTL = 5 * 60_000; // 5 minutes

// Clean up injectedTabs when a tab closes so reloaded tabs can be re-injected.
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});

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
    console.warn("[ContextMover] broadcastForgetToTabs failed:", err);
  }
}

// ── Side panel behaviour ───────────────────────────────────────────────────────
// Register at module load so it is always active, even after the service worker
// wakes from sleep. chrome.sidePanel persists the setting in Chrome storage, but
// calling it again on each wake is cheap and ensures it is never stale.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err: unknown) => console.warn("[ContextMover] setPanelBehavior failed:", err));

// ── Lifecycle ──────────────────────────────────────────────────────────────────
// Rebrand migration — runs on every SW cold start (install / update / spawn).
// The function is idempotent: it no-ops if the legacy "contextforge" IndexedDB
// is not present. Errors are swallowed internally so migration failure can
// never brick capture.
void migrateFromContextForge();

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[ContextMover] Extension installed.");
  // Belt-and-braces: also trigger on install/update so a fresh-install path
  // during the ContextForge → ContextMover upgrade is always covered.
  await migrateFromContextForge().catch(() => { /* non-fatal */ });

  const existing = await chrome.storage.local.get(["sessions"]);
  if (!existing.sessions) await chrome.storage.local.set({ sessions: [] });

  // Disable Chrome's built-in click-to-open side panel — our toggle button handles it.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
    .catch((e) => console.warn("[CM:sw] setPanelBehavior failed:", e));

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
        console.log(`[ContextMover] Tab ${tab.id} already has content script — skipping`);
        continue;
      }
      if (injectedTabs.has(tab.id)) {
        console.log(`[ContextMover] Tab ${tab.id} already injected this session — skipping`);
        continue;
      }
      injectedTabs.add(tab.id);
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: cs.js as string[] })
        .then(() => console.log(`[ContextMover] Injected content script into tab ${tab.id} (${tab.url})`))
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
    .catch((err: unknown) => console.warn("[ContextMover] sidePanel.open failed:", err));
});

// ── Message Router ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log(`[ContextMover ServiceWorker] Received message: ${msg.type}`);
  (async () => {
    try {
    // [SECURITY] Reject messages from any source that is not our own extension.
    if (!isFromOwnExtension(sender)) {
      console.warn('[CM:sw] Rejected message from unknown sender:', sender.id, msg.type);
      sendResponse({ error: 'Unauthorized sender' });
      return;
    }
    switch (msg.type) {
      case "CAPTURE_SESSION": {
        // [SECURITY] Must come from a known platform tab.
        if (!isFromPlatformTab(sender)) {
          console.warn('[CM:sw] CAPTURE_SESSION from non-platform sender, rejected. url:', sender.tab?.url);
          sendResponse({ error: 'Sender is not a known platform tab' });
          break;
        }
        // [SECURITY] Validate payload schema before any DB write.
        const p = msg.payload as Record<string, unknown> | undefined;
        if (!p || typeof p.platform !== 'string' || typeof p.sessionId !== 'string' || !Array.isArray(p.messages)) {
          console.warn('[CM:sw] CAPTURE_SESSION invalid payload schema');
          sendResponse({ error: 'CAPTURE_SESSION: invalid payload schema' });
          break;
        }
        // [SECURITY] Claimed platform must match the actual tab URL.
        if (!payloadPlatformMatchesSender(p.platform, sender)) {
          console.warn(`[CM:sw] CAPTURE_SESSION platform mismatch: claimed=${p.platform} tab=${sender.tab?.url}`);
          sendResponse({ error: 'Platform claim does not match sender tab URL' });
          break;
        }
        console.log(`[CM:sw] CAPTURE_SESSION: ${p.platform} ${p.sessionId}`);
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
        console.log(`[ContextMover ServiceWorker] CAPTURE_MESSAGE: ${msg.payload.platform} ${msg.payload.sessionId}`);
        await handleCaptureMessage(msg.payload);
        sendResponse({ ok: true });
        break;
      }

      case "PRECOMPUTE_SUMMARY": {
        const session = await db.getSession(msg.payload?.sessionId);
        if (!session) { sendResponse(null); break; }
        try {
          const tier1 = await summarize(session.messages);
          const tier2 = summarizeIntelligent(session.messages);
          precomputeCache.set(session.id, { tier1, tier2, cachedAt: Date.now() });
          console.log(`[CM:sw] PRECOMPUTE_SUMMARY cached tier1+tier2 for session ${session.id}`);
          sendResponse({ cached: true });
        } catch (err) {
          console.warn("[CM:sw] PRECOMPUTE_SUMMARY failed:", err);
          sendResponse(null);
        }
        break;
      }

      case "CHECK_MCP_BRIDGE": {
        // Cheap health probe used by the sidebar status indicator.
        // Returns { running: boolean, version?, totalSessions?, ... }.
        try {
          const res = await fetch(`${MCP_BRIDGE_URL}/health`, {
            signal: AbortSignal.timeout(1_000),
          });
          if (!res.ok) {
            sendResponse({ running: false });
            break;
          }
          const data = await res.json().catch(() => ({}));
          sendResponse({ running: true, ...data });
        } catch {
          sendResponse({ running: false });
        }
        break;
      }

      case "SYNC_FILES_TO_MCP": {
        // Sidebar fires this whenever the user toggles file selection or
        // commits a new project import. Files arrive as a plain array — we
        // forward as-is to the bridge, which performs final validation.
        const filesPayload = (msg as { files?: unknown }).files;
        const files = Array.isArray(filesPayload) ? filesPayload as FileSyncEntry[] : [];
        void syncFilesToMcpBridge(files);
        sendResponse({ ok: true, queued: files.length });
        break;
      }

      case "GET_SESSIONS": {
        const now = Date.now();
        if (getSessionsCache !== null && now - getSessionsCacheAt < GET_SESSIONS_CACHE_MS) {
          sendResponse(getSessionsCache);
        } else {
          const sessions = await db.getAllSessions();
          getSessionsCache = sessions;
          getSessionsCacheAt = now;
          sendResponse(sessions);
        }
        break;
      }

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
            await vaultClient.from('cm_sessions').delete().eq('id', msg.sessionId);
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

      case "MIGRATE_CONTEXT": {
        // [SECURITY] Migration must come from extension UI (sidebar/popup), never a content script.
        if (!isFromExtensionUI(sender)) {
          sendResponse({ error: 'MIGRATE_CONTEXT must originate from extension UI' });
          break;
        }

        // ── Freemium gate ────────────────────────────────────────────────────
        // Pro users get { unlimited: true }. Free users get a hard cap per type.
        // On any error here we fail open (the helper itself fails open too).
        const _tier = (msg.payload?.tier ?? 2) as 1 | 2 | 3;
        const usage = await checkMigrationAllowed(_tier);
        if (!usage.allowed) {
          sendResponse({
            error:     "LIMIT_REACHED",
            type:      usage.type ?? tierToType(_tier),
            used:      usage.used ?? 0,
            limit:     usage.limit ?? 0,
            remaining: usage.remaining ?? 0,
          });
          break;
        }

        await handleMigrateContext(msg.payload, sendResponse);
        break;
      }

      case "AUTH_GET_USER": {
        const { data } = await supabase.auth.getUser();
        sendResponse({ user: data.user ?? null });
        break;
      }

      case "GET_SUBSCRIPTION_STATUS": {
        // Returns { plan, isPro, usage, limits } for the sidebar header.
        // Falls back to { plan: 'free', local: true } if not logged in or
        // the API is unreachable — never throws.
        try {
          const { data: { session } } = await supabase.auth.getSession();
          const token = session?.access_token;
          if (!token) {
            sendResponse({ plan: "free", local: true });
            break;
          }
          const res = await fetch(`${WEBAPP_URL}/api/payments/subscription`, {
            headers: { authorization: `Bearer ${token}` },
            signal:  AbortSignal.timeout(4000),
          });
          if (!res.ok) {
            sendResponse({ plan: "free", error: true });
            break;
          }
          const data = await res.json();
          sendResponse({
            plan:   data.subscription?.plan ?? "free",
            isPro:  Boolean(data.isPro),
            usage:  data.usage,
            limits: data.limits,
            status: data.subscription?.status,
            trialEnd: data.subscription?.trialEnd ?? null,
          });
        } catch {
          sendResponse({ plan: "free", error: true });
        }
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
              await vaultClient.from('cm_sessions').upsert({
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
          console.log(`[ContextMover:vault] Bulk synced ${vaultSynced}/${local.length} sessions to personal vault`);
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
        if (sender.tab?.id == null) {
          sendResponse({ isOpen: false, error: "no tab" });
          break;
        }
        const tabId = sender.tab.id;

        // Try to open first — if already open Chrome throws, so we close it.
        try {
          await chrome.sidePanel.open({ tabId });
          sendResponse({ isOpen: true });
        } catch {
          try {
            await (chrome.sidePanel as unknown as { close(d: { tabId: number }): Promise<void> })
              .close({ tabId });
            sendResponse({ isOpen: false });
          } catch (err) {
            sendResponse({ isOpen: false, error: String(err) });
          }
        }
        break;
      }

      case "BACKGROUND_INDEX": {
        const { sessionId: bgSessionId } = msg as { sessionId?: string };
        if (!bgSessionId) { sendResponse({ error: 'sessionId required' }); break; }
        const bgSession = await db.getSession(bgSessionId);
        if (!bgSession) { sendResponse({ error: 'Session not found' }); break; }
        void backgroundIndex(bgSession);
        sendResponse({ ok: true });
        break;
      }

      case "WARMUP_MODEL": {
        void semanticIndex.warmup().catch((e) => console.warn('[CM:sw] warmup failed:', e));
        sendResponse({ ok: true });
        break;
      }

      case "GET_INDEX_STATS": {
        try {
          const stats = await semanticIndex.getStats();
          sendResponse({ ok: true, stats });
        } catch (e) {
          sendResponse({ error: String(e) });
        }
        break;
      }

      case "CLEAR_SEMANTIC_INDEX": {
        try {
          await semanticIndex.clearAll();
          console.log('[CM:sw] Semantic index cleared by user');
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ error: String(e) });
        }
        break;
      }

      case "GET_QUALITY_REPORT": {
        try {
          const sid = (msg.payload as { sessionId?: string } | undefined)?.sessionId;
          const report = await generateQualityReport(sid);
          sendResponse({ ok: true, report });
        } catch (e) {
          sendResponse({ error: String(e) });
        }
        break;
      }

      case "GET_QUALITY_STATS": {
        try {
          const rows = await db.migrationQuality.toArray();
          const count = rows.length;
          const avgScore =
            count > 0 ? rows.reduce((s, r) => s + r.score, 0) / count : 0;
          sendResponse({
            ok: true,
            count,
            avgScore: Math.round(avgScore),
          });
        } catch (e) {
          sendResponse({ error: String(e) });
        }
        break;
      }

      case "CLEAR_QUALITY_HISTORY": {
        try {
          await db.migrationQuality.clear();
          console.log("[CM:sw] Migration quality history cleared by user");
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ error: String(e) });
        }
        break;
      }

      case "CAPTURE_HEALTH": {
        const { platform: hPlatform, success, userCount: hUser, assistantCount: hAsst, total: hTotal } = msg.payload ?? {};
        if (!hPlatform) {
          sendResponse({ error: "payload.platform required" });
          break;
        }

        // Store last 10 success flags per platform
        const key = `health_${hPlatform}`;
        const stored = await chrome.storage.local.get(key);
        const history: boolean[] = stored[key] ?? [];
        history.push(Boolean(success));
        if (history.length > 10) history.shift();
        await chrome.storage.local.set({ [key]: history });

        const successRate = history.filter(Boolean).length / history.length;
        if (successRate < 0.7 && history.length >= 3) {
          console.warn(
            `[CM:health] ${hPlatform} capture rate: ${(successRate * 100).toFixed(0)}% — selectors may be broken`
          );
          await chrome.storage.local.set({
            [`alert_${hPlatform}`]: {
              platform: hPlatform,
              successRate,
              timestamp: Date.now(),
              message: `Capture quality dropped on ${hPlatform}. Assistant messages may be missing.`,
            },
          });
        } else {
          await chrome.storage.local.remove(`alert_${hPlatform}`);
        }

        sendResponse({ ok: true, rate: successRate });
        break;
      }

      default:
        sendResponse({ error: `Unknown message type: ${msg.type}` });
    }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[CM:sw] Unhandled error in ${msg.type} handler:`, err);
      sendResponse({ error: errMsg });
    }
  })();
  return true; // keep channel open for async
});

// ── Quality scoring ─────────────────────────────────────────────────────────
// Synchronous, fast (regex counts on a 100k string take a few ms even on
// minimal hardware). Persisting to IDB is fire-and-forget so we never block
// the migration response on a write. NEVER throws — the inner scoreMigration
// already catches its own errors and returns a Failed score on any glitch.
function scoreAndPersist(
  session: ContextSession,
  outputPrompt: string,
  tier: 1 | 2 | 3,
  platform: string,
  topK?: number,
  captureStats?: { userCount: number; assistantCount: number; total: number }
): QualityScore {
  const score = scoreMigration({ session, outputPrompt, tier, platform, topK, captureStats });
  console.log("[CM:quality]\n" + formatScoreReport(score));

  // Fire-and-forget persistence
  void db.migrationQuality
    .put({
      id: score.meta.migrationId,
      sessionId: session.id,
      sessionTitle: session.title ?? session.id,
      platform,
      tier,
      score: score.total,
      grade: score.grade,
      breakdown: score.breakdown,
      meta: score.meta,
      createdAt: Date.now(),
    })
    .catch((err) => console.warn("[CM:quality] persist failed (non-fatal):", err));

  return score;
}

// ── Usage enforcement (freemium gate) ───────────────────────────────────────
// Two paths:
//   1. Logged-in users → server-side increment_usage RPC via /api/payments/usage
//   2. Anonymous users → local chrome.storage counters (best-effort gate)
//
// Fails OPEN on any network / auth error — a flaky network must NEVER block a
// migration. The server-side path is the source of truth for paying users.

interface UsageCheckResult {
  allowed:    boolean;
  used?:      number;
  limit?:     number;
  remaining?: number;
  type?:      "simple" | "smart" | "attention";
}

function tierToType(tier: 1 | 2 | 3): "simple" | "smart" | "attention" {
  return tier === 1 ? "simple" : tier === 2 ? "smart" : "attention";
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function checkLocalUsage(tier: 1 | 2 | 3): Promise<UsageCheckResult> {
  const type  = tierToType(tier);
  const month = currentMonthKey();
  const key   = `cm_usage_${month}`;

  const stored = await chrome.storage.local.get(key);
  const usage: Record<string, number> = stored[key] ?? { simple: 0, smart: 0, attention: 0 };

  const limits = { simple: 50, smart: 50, attention: 10 } as const;
  const current = usage[type] ?? 0;
  const limit   = limits[type];

  if (current >= limit) {
    return { allowed: false, used: current, limit, remaining: 0, type };
  }

  usage[type] = current + 1;
  await chrome.storage.local.set({ [key]: usage });

  return {
    allowed:   true,
    used:      current + 1,
    limit,
    remaining: limit - current - 1,
    type,
  };
}

async function checkMigrationAllowed(tier: 1 | 2 | 3): Promise<UsageCheckResult> {
  // Try the server-side gate first if we have a session.
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    if (token) {
      const type = tierToType(tier);
      const res = await fetch(`${WEBAPP_URL}/api/payments/usage`, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ type }),
        signal: AbortSignal.timeout(4000),
      });

      if (res.ok) {
        const data = await res.json();
        if (data?.unlimited) return { allowed: true, type };
        return {
          allowed:   Boolean(data?.allowed),
          used:      data?.used,
          limit:     data?.limit,
          remaining: data?.remaining,
          type,
        };
      }
      // Non-2xx from API → fall through to local check (fail-open).
    }
  } catch (err) {
    // Network / auth failure → fail open via local counters.
    console.warn("[CM:usage] server check failed, falling back to local:", err);
  }

  // No session OR server unreachable → use local counters.
  return checkLocalUsage(tier);
}

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
      await vaultClient.from('cm_sessions').upsert({
        id: session.id, platform: session.platform, title: session.title,
        messages: session.messages,
        message_count: session.messages.length,
        user_message_count: session.messages.filter((m) => m.role === 'user').length,
        assistant_message_count: session.messages.filter((m) => m.role === 'assistant').length,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
    } catch (err) { console.warn('[ContextMover:vault] CAPTURE_MESSAGE sync failed:', err); }
  })();

}

async function handleCaptureSession(payload: {
  platform: string;
  sessionId: string;
  title: string;
  messages: Message[];
  metadata?: import("@/lib/types").RequestMetadata;
}) {
  // In-flight deduplication: skip if the same session is already being processed.
  // Prevents double DB writes when content script + syncOpenTabs fire simultaneously.
  if (captureInFlight.has(payload.sessionId)) {
    console.log(`[ContextMover:capture] Skipped in-flight duplicate for session ${payload.sessionId}`);
    return;
  }
  captureInFlight.add(payload.sessionId);
  // Release lock after debounce window + buffer so rapid-fire pairs are absorbed.
  setTimeout(() => captureInFlight.delete(payload.sessionId), 2_200);

  // ── [CM:sw] received ────────────────────────────────────────────────────────
  const rxUser = payload.messages.filter(m => m.role === "user").length;
  const rxAsst = payload.messages.filter(m => m.role === "assistant").length;
  console.log('[CM:sw] received', { platform: payload.platform, session: payload.sessionId, total: payload.messages.length, user: rxUser, assistant: rxAsst });
  if (rxAsst === 0 && rxUser > 0) {
    console.error('[CM:sw] received — ASSISTANT MESSAGES MISSING in payload (Stage1 content script bug)');
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
    metadata: payload.metadata,
  };

  // Debounced IDB write — coalesces rapid-fire captures for the same session.
  // Only 1 write fires per 200ms window; SESSIONS_UPDATED broadcasts after flush.
  pendingWrites.set(session.id, session);
  const existingTimer = writeTimers.get(session.id);
  if (existingTimer !== undefined) clearTimeout(existingTimer);
  writeTimers.set(session.id, setTimeout(async () => {
    const toWrite = pendingWrites.get(session.id);
    if (!toWrite) return;
    await db.saveSession(toWrite);
    pendingWrites.delete(session.id);
    writeTimers.delete(session.id);
    sessionCache.invalidate(); // force fresh IDB read on next GET_SESSIONS
    console.log('[CM:sw] saved (debounced)', { session: toWrite.id, total: toWrite.messages.length });
    void broadcastToViews({ type: "SESSIONS_UPDATED" });
    // Kick off background semantic indexing — fire & forget, never blocks capture
    void backgroundIndex(toWrite).catch(() => {});
    // Mirror to local MCP bridge so IDEs (Cursor/Windsurf/Continue/Claude
    // Desktop) can read the session. Fire-and-forget — never blocks capture
    // and silently no-ops if the bridge isn't running.
    void syncToMcpBridge(toWrite).catch(() => {});
    // ── Pre-build MetaPrompt in background ──────────────────────────────
    // As each turn arrives, immediately re-run the summarizer + translator
    // and store the full translated prompt in IndexedDB. On migrate, this
    // prompt is returned instantly with zero computation.
    void buildMetaPromptAsync(toWrite).catch((e) =>
      console.warn('[CM:sw] background MetaPrompt build failed (non-fatal):', e)
    );
  }, 200));

  console.log('[ContextMover] Session stored locally only. No cloud sync unless user connects personal Supabase.');

  // Sync to user's personal vault — rate-limited through queueVaultSync (30s minimum).
  void (async () => {
    try {
      const vaultClient = await userVault.getClient();
      if (!vaultClient) return;
      await queueVaultSync(session, vaultClient);
    } catch (err) { console.warn('[ContextMover:vault] queueVaultSync error:', err); }
  })();

  // ── [CM:sw] verified — check pending queue and/or IDB ────────────────────
  const inFlight = pendingWrites.get(payload.sessionId);
  const saved = inFlight ?? await db.getSession(payload.sessionId);
  const savedUser = saved?.messages.filter(m => m.role === "user").length ?? 0;
  const savedAsst = saved?.messages.filter(m => m.role === "assistant").length ?? 0;
  console.log('[CM:sw] verified', { total: saved?.messages.length ?? 0, user: savedUser, assistant: savedAsst, ok: saved !== undefined, pending: !!inFlight });
  if (!saved) {
    console.error('[CM:sw] verified — FAILED: session not found in queue or IndexedDB');
  } else if (savedAsst === 0 && savedUser > 0) {
    console.error('[CM:sw] verified — ASSISTANT MESSAGES MISSING');
  }
}

/**
 * Fire-and-forget semantic indexer: chunks & embeds a session via the offscreen
 * document. Runs after every debounced IDB write. Errors are silently swallowed
 * so they never surface as extension failures.
 */
async function backgroundIndex(session: ContextSession): Promise<void> {
  try {
    const t0 = performance.now();
    await semanticIndex.indexSession(session);
    const dt = (performance.now() - t0).toFixed(0);
    console.log(`[CM:sw:bgIdx] indexed session ${session.id} in ${dt}ms`);

    // Mirror chunk embeddings to the MCP bridge for IDE-side semantic_search.
    // Fire-and-forget; bridge offline is the common case and fine.
    void syncEmbeddingsToMcpBridge(session.id);
  } catch (err) {
    console.warn('[CM:sw:bgIdx] indexing failed (non-fatal):', err);
  }
}

/**
 * Background MetaPrompt builder — runs after every capture to pre-build
 * translated prompts for all major platforms. When the user clicks migrate,
 * the prompt is already ready and injection is instant.
 *
 * Builds tier-1 and tier-2 MetaPrompts for all supported target platforms.
 * Stores them in IndexedDB (metaPrompts table). Invalidated when new messages
 * arrive (replaced on next build).
 */
async function buildMetaPromptAsync(session: ContextSession): Promise<void> {
  const t0 = performance.now();

  // Quick tier-1 summary (fast, < 100ms)
  const summaryResult = await summarize(session.messages).catch(() => null);
  if (!summaryResult) return;

  const tier1Meta = summaryResult.extracted;
  const tier1Compression = summaryResult.originalTokenEstimate > 0
    ? Math.round((1 - summaryResult.summaryTokenEstimate / summaryResult.originalTokenEstimate) * 100)
    : 0;

  // Build tier-2 intelligent summary
  const tier2Result = summarizeIntelligent(session.messages);
  const tier2Compression = tier2Result.compressionRatio;

  const targets: import("@/lib/types").Platform[] = ["claude", "chatgpt", "gemini", "grok", "deepseek", "perplexity"];

  for (const target of targets) {
    try {
      // Tier 1 MetaPrompt (full summary + tail)
      const tier1Prompt = buildMigrationPrompt({
        summary: summaryResult.content,
        extracted: tier1Meta,
        targetPlatform: target,
        sourceSession: session,
        tier: 1,
        compressionRatio: tier1Compression,
        metadata: session.metadata,
      });
      await db.saveMetaPrompt({
        id: session.id,
        platform: target,
        tier: 1,
        prompt: tier1Prompt,
        compressionRatio: tier1Compression,
        builtAt: Date.now(),
        messageCount: session.messages.length,
      });

      // Tier 2 MetaPrompt (intelligent summary)
      const tier2Prompt = buildMigrationPrompt({
        summary: tier2Result.goal,
        extracted: undefined,
        intelligentSummary: tier2Result,
        targetPlatform: target,
        sourceSession: session,
        tier: 2,
        compressionRatio: tier2Compression,
        metadata: session.metadata,
      });
      await db.saveMetaPrompt({
        id: session.id,
        platform: target,
        tier: 2,
        prompt: tier2Prompt,
        compressionRatio: tier2Compression,
        builtAt: Date.now(),
        messageCount: session.messages.length,
      });
    } catch (err) {
      console.warn(`[CM:sw:metaPrompt] build failed for ${target}:`, err);
    }
  }

  console.log(`[CM:sw:metaPrompt] built ${targets.length * 2} prompts in ${(performance.now() - t0).toFixed(0)}ms`);
}

/**
 * Returns true when a code block is annotated with a file path — these are
 * foundational files (schema, types, config) and must survive the prompt cap.
 * Checks: object .path/.filename property, or first line is a comment with "/" or "."
 */
function isPathAnnotatedCodeBlock(block: unknown): boolean {
  if (typeof block === 'object' && block !== null) {
    const b = block as Record<string, unknown>;
    if (typeof b.path === 'string' && /[./]/.test(b.path)) return true;
    if (typeof b.filename === 'string' && /[./]/.test(b.filename)) return true;
  }
  const content =
    typeof block === 'string' ? block :
    typeof (block as Record<string, unknown>)?.content === 'string'
      ? String((block as Record<string, unknown>).content)
      : '';
  if (!content) return false;
  const firstLine = content.trim().split('\n')[0] ?? '';
  // Comment line starting with // # -- that contains a file path
  if (/^(?:\/\/|#|--)[\s\S]*[./][\w]/.test(firstLine.trim())) return true;
  // Line itself matches a file path pattern (/path/to/file.ext or file.ext)
  return /[a-z0-9_\-]+\.[a-z]{1,5}/i.test(firstLine);
}

// ── Migration helpers ──────────────────────────────────────────────────────

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: () => Promise<T>
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("TIMEOUT")), ms);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    clearTimeout(timeoutId!);
    return result;
  } catch (err: unknown) {
    clearTimeout(timeoutId!);
    if (err instanceof Error && err.message === "TIMEOUT") {
      console.warn("[CM:sw] Attention Engine timeout — falling back to Tier 2");
      return fallback();
    }
    throw err;
  }
}

function reportProgress(progress: number, stage: string): void {
  void broadcastToViews({ type: "MIGRATION_PROGRESS", progress, stage });
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
    projectContext?: string | null;
  },
  sendResponse: (r: unknown) => void
) {
  // Flush any pending debounced write for this session before reading from IDB.
  // Guarantees migrate always sees the latest captured data.
  if (pendingWrites.has(payload.sessionId)) {
    const pendingSession = pendingWrites.get(payload.sessionId)!;
    const pendingTimer = writeTimers.get(payload.sessionId);
    if (pendingTimer !== undefined) { clearTimeout(pendingTimer); writeTimers.delete(payload.sessionId); }
    await db.saveSession(pendingSession);
    pendingWrites.delete(payload.sessionId);
    console.log(`[CM:sw] migrate flush: flushed pending write for session ${payload.sessionId}`);
  }

  // ── DIAGNOSTIC STAGE 4 — load session from IndexedDB ──────────────────────
  const session = await db.getSession(payload.sessionId);
  if (!session) return sendResponse({ error: "Session not found in storage." });

  const s4User = session.messages.filter(m => m.role === "user").length;
  const s4Asst = session.messages.filter(m => m.role === "assistant").length;
  console.log(`[ContextMover:sw] Stage4 — session loaded: total=${session.messages.length} user=${s4User} assistant=${s4Asst}`);

  if (session.messages.length === 0) {
    return sendResponse({ error: "Session has no messages. Nothing to migrate." });
  }

  // ── EARLY-EXIT: full prompt cache check ─────────────────────────────────
  // If we built this exact prompt within the last 5 minutes (same session/task/
  // platform/tier/template), skip ALL computation and inject straight away.
  // Skipped when projectContext or caveman are active — they change output but
  // are not part of the cache key.
  const t0_migrate = performance.now();
  if (!payload.projectContext && !payload.caveman) {
    try {
      const cached = await perf.measure('migrate.cache_check', () =>
        semanticIndex.getCachedPrompt(
          payload.sessionId,
          payload.task ?? null,
          payload.targetPlatform,
          payload.tier ?? 2,
          payload.promptTemplateId ?? null
        )
      );
      if (cached) {
        console.log(`[CM:sw] Full prompt cache HIT — skipping all computation (${(performance.now() - t0_migrate).toFixed(0)}ms)`);
        reportProgress(95, `Injecting into ${payload.targetPlatform} (cached)...`);

        if (payload.targetTabId) {
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
            return sendResponse({ error: `The active tab (${targetTab.url}) is not a ${payload.targetPlatform} page.` });
          }
          const injectionResult = await sendMessageToTab(payload.targetTabId, {
            type: "INJECT_CONTEXT",
            prompt: cached,
            platform: payload.targetPlatform,
          });
          if (!injectionResult.ok) {
            // Injection failed — fall through to normal recompute path
            console.warn('[CM:sw] Cache-hit injection failed, falling through:', injectionResult.error);
          } else {
            const qualityScore = scoreAndPersist(
              session, cached, (payload.tier ?? 2) as 1 | 2 | 3,
              payload.targetPlatform, 15
            );
            perf.logReport();
            return sendResponse({ ok: true, prompt: cached, compressionRatio: 0, fromCache: true, qualityScore });
          }
        } else {
          const qualityScore = scoreAndPersist(
            session, cached, (payload.tier ?? 2) as 1 | 2 | 3,
            payload.targetPlatform, 15
          );
          perf.logReport();
          return sendResponse({ ok: true, prompt: cached, compressionRatio: 0, fromCache: true, qualityScore });
        }
      }
    } catch (err) {
      console.warn('[CM:sw] Prompt cache check failed (non-fatal):', err);
    }
  }

  // ── Check pre-built MetaPrompt from IndexedDB ──────────────────────────
  // If the background builder already constructed this prompt, skip ALL
  // summarization and return the stored translation instantly.
  const requestedTier = (payload.tier ?? 2) as 1 | 2 | 3;
  try {
    const metaPrompt = await db.getMetaPrompt(payload.sessionId, payload.targetPlatform, requestedTier);
    if (metaPrompt && metaPrompt.messageCount >= session.messages.length) {
      console.log(`[CM:sw] MetaPrompt HIT — skipping summarization (${(performance.now() - t0_migrate).toFixed(0)}ms)`);
      reportProgress(95, `Injecting into ${payload.targetPlatform} (MetaPrompt)...`);

      if (payload.targetTabId) {
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
          return sendResponse({ error: `The active tab (${targetTab.url}) is not a ${payload.targetPlatform} page.` });
        }
        const injectionResult = await sendMessageToTab(payload.targetTabId, {
          type: "INJECT_CONTEXT",
          prompt: metaPrompt.prompt,
          platform: payload.targetPlatform,
        });
        if (!injectionResult.ok) {
          console.warn('[CM:sw] MetaPrompt injection failed, falling through to recompute:', injectionResult.error);
        } else {
          const qualityScore = scoreAndPersist(
            session, metaPrompt.prompt, requestedTier,
            payload.targetPlatform, requestedTier === 3 ? 15 : undefined
          );
          perf.logReport();
          return sendResponse({ ok: true, prompt: metaPrompt.prompt, compressionRatio: metaPrompt.compressionRatio, fromMetaPrompt: true, qualityScore });
        }
      } else {
        const qualityScore = scoreAndPersist(
          session, metaPrompt.prompt, requestedTier,
          payload.targetPlatform, requestedTier === 3 ? 15 : undefined
        );
        perf.logReport();
        return sendResponse({ ok: true, prompt: metaPrompt.prompt, compressionRatio: metaPrompt.compressionRatio, fromMetaPrompt: true, qualityScore });
      }
    }
  } catch (err) {
    console.warn('[CM:sw] MetaPrompt check failed (non-fatal):', err);
  }

  if (s4Asst === 0) {
    console.warn(`[ContextMover:sw] Stage4 — assistant messages missing from stored session. Migration will proceed with user-only context (degraded).`);
  }

  console.log(`[ContextMover:sw] Stage5 — calling summarizer with ${session.messages.length} messages`);

  let summary = "";
  let extracted: ExtractedContext | undefined;
  let attentionMap: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let intelligentSummary: any;
  let compressionRatio = 0;

  // ── Check precompute cache before running summarizer ───────────────────────────
  const precomputed = precomputeCache.get(payload.sessionId);
  const precomputeValid = precomputed && (Date.now() - precomputed.cachedAt) < PRECOMPUTE_TTL;
  let precomputeUsed = false;

  if (precomputeValid && !payload.useAttentionEngine) {
    const requestedTier = (payload.tier ?? 1) as 1 | 2 | 3;
    if (requestedTier === 1 && precomputed.tier1) {
      const r = precomputed.tier1;
      summary = r.content;
      extracted = r.extracted;
      compressionRatio = r.originalTokenEstimate > 0
        ? Math.round((1 - r.summaryTokenEstimate / r.originalTokenEstimate) * 100) : 0;
      console.log(`[CM:sw] Stage5 — Precomputed tier1 used (instant)`);
      precomputeUsed = true;
    } else if (requestedTier === 2 && precomputed.tier2) {
      const r = precomputed.tier2;
      intelligentSummary = r;
      compressionRatio = r.compressionRatio;
      summary = r.goal;
      console.log(`[CM:sw] Stage5 — Precomputed tier2 used (instant)`);
      precomputeUsed = true;
    }
  }
  // ── IDB summary cache — fallback when in-memory precompute cache misses ──
  // Latency: ~30-80ms; persists across SW restarts. Tier 3 is always recomputed.
  if (!precomputeUsed && !payload.useAttentionEngine && (payload.tier ?? 1) !== 3) {
    try {
      const requestedTierIdb = (payload.tier ?? 1) as 1 | 2;
      const idbStored = await perf.measure('migrate.idb_summary', () =>
        semanticIndex.getSummary(
          payload.sessionId, requestedTierIdb, payload.task ?? null, session.messages.length
        )
      );
      if (idbStored) {
        if (requestedTierIdb === 1) {
          summary = idbStored.content;
          compressionRatio = idbStored.compressionRatio;
          precomputeUsed = true;
          console.log(`[CM:sw] IDB summary cache hit tier=1 (${idbStored.compressionRatio}%)`);
        } else {
          try {
            intelligentSummary = JSON.parse(idbStored.content);
            summary = (intelligentSummary as { goal?: string }).goal ?? '';
            compressionRatio = idbStored.compressionRatio;
            precomputeUsed = true;
            console.log(`[CM:sw] IDB summary cache hit tier=2 (${idbStored.compressionRatio}%)`);
          } catch { /* corrupt JSON — skip, recompute below */ }
        }
      }
    } catch (idbErr) {
      console.warn('[CM:sw] IDB summary cache check failed (non-fatal):', idbErr);
    }
  }
  // Capability detector returns minimal | balanced | full — we map back to the
  // existing 1 | 2 | 3 numeric tier the summarizer/translator already speak:
  //   minimal  → 2 (summarizeIntelligent, regex extraction, <100ms)
  //   balanced → 3 (Attention Engine, WASM, 2 threads)
  //   full     → 3 (Attention Engine, WebGPU when available, 4 threads)
  let tier: 1 | 2 | 3;
  let detectedTier: Tier | null = null;
  if (precomputeUsed) {
    tier = (payload.tier ?? 1) as 1 | 2 | 3;
  } else if (payload.tier) {
    tier = payload.tier;
  } else if (payload.useAttentionEngine) {
    tier = 3;
  } else {
    detectedTier = await capabilityDetector.getEffectiveTier().catch(() => "balanced" as Tier);
    tier = detectedTier === "minimal" ? 2 : 3;
    console.log(`[ContextMover:sw] Auto-tier: capability=${detectedTier} → numeric tier=${tier}`);
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

  if (!precomputeUsed) try {
  if (tier === 3 || (payload.useAttentionEngine && payload.task)) {
    // Tier 3 — Attention Engine
    if (payload.precomputedSummary) {
      summary = payload.precomputedSummary;
      attentionMap = payload.precomputedAttentionMap;
      compressionRatio = (payload.precomputedAttentionMap as any)?.compressionRatio ?? 0;
      console.log(`[ContextMover:sw] Stage5 — Attention Engine fast path (pre-computed by sidebar)`);
    } else {
      // ── Hardware gate: skip Attention Engine on minimal hardware (FIX 5) ──────
      const hwProfile = await getHardwareProfile().catch(() => null);
      if (hwProfile?.tier === "minimal") {
        console.log(
          "[CM:sw] Minimal hardware — using enhanced Tier 2 instead of Attention Engine " +
          "(" + (hwProfile.cores) + " cores, no GPU)"
        );
        tier = 2;
        const isResult = summarizeIntelligent(session.messages, payload.task);
        intelligentSummary = isResult;
        compressionRatio = isResult.compressionRatio;
        summary = isResult.goal;
        console.log(`[CM:sw] tier=3→2 (minimal hw) compression=${compressionRatio}%`);
        void broadcastToViews({ type: "TIER_DOWNGRADED", from: 3, to: 2, reason: "slow_hardware" });
      } else {
        // ── Full Attention Engine path with 8s hard timeout ───────────────────
        console.log(`[ContextMover:sw] Stage5 — Attention Engine path: strength=${payload.strength ?? "light"}`);
        const t3Start = Date.now();
        try {
          const { attentionEngine } = await import("@/lib/attention-engine");
          const engineTier: Tier = detectedTier ?? "balanced";
          reportProgress(10, "Loading semantic model...");
          await attentionEngine.initialize(undefined, engineTier).catch((err) => {
            console.warn("[ContextMover:sw] attention engine init failed, will fallback:", err);
          });
          reportProgress(30, `Analyzing ${session.messages.length} messages...`);
          const atResult = await withTimeout(
            summarizeWithAttention(
              session.messages,
              payload.task ?? "",
              payload.strength ?? "light",
              session
            ),
            8_000,
            async () => {
              tier = 2;
              const r = summarizeIntelligent(session.messages, payload.task);
              intelligentSummary = r;
              void broadcastToViews({ type: "TIER_DOWNGRADED", from: 3, to: 2, reason: "timeout" });
              return { summary: r.goal, attentionMap: null, compressionRatio: r.compressionRatio } as unknown as Awaited<ReturnType<typeof summarizeWithAttention>>;
            }
          );
          summary = atResult.summary;
          attentionMap = atResult.attentionMap;
          compressionRatio = atResult.compressionRatio;
          reportProgress(65, "Building attention map...");
          const elapsed = Date.now() - t3Start;
          if (tier === 2) {
            console.log(`[CM:sw] tier=3 → TIMEOUT after 8s → fell back to tier=2`);
          } else {
            console.log(`[CM:sw] tier=3 → attention engine completed in ${elapsed}ms ✅`);
            reportProgress(85, "Formatting context...");
          }
        } catch (atErr) {
          const atMsg = atErr instanceof Error ? atErr.message : String(atErr);
          const isBrowserApiErr = atMsg.includes("window is not defined") ||
            atMsg.includes("document is not defined") ||
            atMsg.includes("navigator is not defined") ||
            atMsg.includes("is not defined");
          if (isBrowserApiErr) {
            console.warn(
              "[CM:sw] Attention Engine unavailable in SW (browser APIs absent) — falling back to tier2.",
              "Use the sidebar's 'Attention' tab to pre-compute before migrating."
            );
            tier = 2;
            const isResult = summarizeIntelligent(session.messages, payload.task);
            intelligentSummary = isResult;
            compressionRatio = isResult.compressionRatio;
            summary = isResult.goal;
            console.log(`[CM:sw] tier=3 → ERROR → fell back to tier=2`);
          } else {
            throw atErr;
          }
        }
      }
    }
  } else if (tier === 2) {
    // Tier 2 — summarizeIntelligent (synchronous, no ML)
    const isResult = summarizeIntelligent(session.messages, payload.task);
    intelligentSummary = isResult;
    compressionRatio = isResult.compressionRatio;
    summary = isResult.goal;
    console.log(`[ContextMover:sw] tier=2 compression=${compressionRatio}% chars=${JSON.stringify(isResult).length}`);
    void semanticIndex.saveSummary(payload.sessionId, 2, payload.task ?? null, JSON.stringify(isResult), isResult.compressionRatio, session.messages.length).catch(() => {});
    void syncSummaryToMcpBridge(payload.sessionId, 2, JSON.stringify(isResult));
  } else {
    // Tier 1 — summarize
    const summaryResult = await summarize(session.messages, { caveman: payload.caveman });
    summary = summaryResult.content;
    extracted = summaryResult.extracted;
    compressionRatio = summaryResult.originalTokenEstimate > 0
      ? Math.round((1 - summaryResult.summaryTokenEstimate / summaryResult.originalTokenEstimate) * 100)
      : 0;
    console.log(`[ContextMover:sw] Stage5 — summarizer done: mode=${summaryResult.mode} tokens~${summaryResult.originalTokenEstimate} codeBlocks=${summaryResult.extracted.codeBlocks.length} tailMessages=${summaryResult.extracted.conversationTail.length}`);
    const tailAsst = summaryResult.extracted.conversationTail.filter(m => m.role === "assistant").length;
    if (tailAsst === 0) {
      console.error(`[ContextMover:sw] Stage5 — conversationTail has no assistant messages`);
    }
    void semanticIndex.saveSummary(payload.sessionId, 1, null, summaryResult.content, compressionRatio, session.messages.length).catch(() => {});
    void syncSummaryToMcpBridge(payload.sessionId, 1, summaryResult.content);
  }
  } finally {
    // Always stop the load watchdog — even on summarizer error — to avoid a
    // dangling setInterval bleeding CPU between migrations.
    stopWatchdog();
  } // end !precomputeUsed

  reportProgress(95, "Injecting into " + (payload.targetPlatform ?? "target") + "...");

  // Inject project-file context (built in the sidebar by FileContextBuilder).
  let ideContext: string | undefined = undefined;
  if (payload.projectContext) {
    const fileCount = (payload.projectContext.match(/<file |###\s|^\[FILE:/gm) ?? []).length;
    const chars = payload.projectContext.length;
    console.log(`[ContextMover:files] injected project context files=${fileCount} chars=${chars}`);
    ideContext = payload.projectContext;
  }

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
  console.log(`[ContextMover:sw] tier=${tier} compression=${compressionRatio}% chars=${prompt.length}`);

  console.log(`[ContextMover:sw] Stage6 — prompt built: length=${prompt.length} chars, target=${payload.targetPlatform}`);
  if (prompt.length < 500) {
    console.error(`[ContextMover:sw] Stage6 — prompt suspiciously short (${prompt.length} chars), context likely lost`);
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
        `[ContextMover:prompt-engine] template="${mergeResult.templateName}"`,
        `totalChars=${mergeResult.stats.totalLength}`,
        `estimatedTokens=${mergeResult.stats.estimatedTokens}`
      );
    } catch (err) {
      console.warn("[ContextMover:prompt-engine] failed, migrating without template:", err);
    }
  }

  // ── Priority-ordered prompt cap ───────────────────────────────────────────
  // Uniform 200k char cap for all platforms — equal treatment, no discrimination.
  // Claude (ProseMirror) is confirmed smooth at 200k+; other editors may show
  // minor lag on very large payloads but will still accept the full context.
  //
  // Priority order (never drop P1–P3):
  //   P1 — metadata, primaryGoal, currentFocus, decisions  (always kept)
  //   P2 — code blocks  (kept newest-first; oldest pruned until budget fits)
  //   P3 — last 6 verbatim messages + instructions  (always kept)
  //   P4 — middle messages  (already compressed by summariser; no standalone section)
  //
  // Strategy: rebuild from structured components with progressively fewer
  // code blocks (oldest dropped first) rather than slicing the flat string.
  // Realistic 2025 input-box limits (NOT model context windows — those are far
  // larger). These are how many chars each platform's editor accepts inline
  // before degrading or auto-converting to an attachment:
  //   Claude   — ProseMirror, smooth at 500k+
  //   Gemini   — 1M+ token context, editor handles 500k easily
  //   ChatGPT  — 128k tokens (GPT-4o); UI accepts ~200k before attaching
  //   Grok     — 128k tokens, similar UI behaviour to ChatGPT
  //   DeepSeek — 128k tokens; editor accepts ~200k
  //   Perplexity — smaller search-style editor, 100k safe
  // Old caps (32k–60k) were from 2023 GPT-3.5 era and are no longer valid.
  // They were also forcing a 31-rebuild loop on minimal hardware → ~30s migrations.
  const PLATFORM_MAX_CHARS: Partial<Record<string, number>> = {
    claude:      500_000,
    gemini:      500_000,
    chatgpt:     200_000,
    grok:        200_000,
    perplexity:  100_000,
    deepseek:    200_000,
  };
  const MAX_PROMPT_CHARS = PLATFORM_MAX_CHARS[payload.targetPlatform] ?? 200_000;
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

    // Split into path-annotated (foundational — drop LAST) and unnamed (drop FIRST).
    const pathAnnotatedBlocks = allBlocks.filter(isPathAnnotatedCodeBlock);
    const unnamedBlocks       = allBlocks.filter((b) => !isPathAnnotatedCodeBlock(b));

    let rebuilt = finalPrompt;
    if (allBlocks.length > 0) {
      // Pass 1 — drop unnamed (non-path-annotated) blocks oldest-first.
      // Path-annotated blocks are always included in every candidate.
      for (let keep = unnamedBlocks.length; keep >= 0; keep--) {
        const candidate = buildWith([
          ...unnamedBlocks.slice(unnamedBlocks.length - keep),
          ...pathAnnotatedBlocks,
        ]);
        if (candidate.length <= MAX_PROMPT_CHARS) {
          rebuilt = candidate;
          const droppedUnnamed = unnamedBlocks.length - keep;
          if (droppedUnnamed > 0) {
            console.warn(
              `[ContextMover:sw] Priority cap P3: dropped ${droppedUnnamed} unnamed block(s), ` +
              `${pathAnnotatedBlocks.length} path-annotated block(s) preserved. ` +
              `${beforeChars.toLocaleString()} → ${rebuilt.length.toLocaleString()} chars`
            );
          }
          break;
        }
      }
      // Pass 2 — last resort: drop path-annotated blocks oldest-first
      // (only reached if all unnamed blocks were already removed and still over budget).
      if (rebuilt.length > MAX_PROMPT_CHARS && pathAnnotatedBlocks.length > 0) {
        for (let keep = pathAnnotatedBlocks.length - 1; keep >= 0; keep--) {
          const candidate = buildWith(pathAnnotatedBlocks.slice(pathAnnotatedBlocks.length - keep));
          if (candidate.length <= MAX_PROMPT_CHARS) {
            rebuilt = candidate;
            const droppedPath = pathAnnotatedBlocks.length - keep;
            console.warn(
              `[ContextMover:sw] Priority cap P4: forced to drop ${droppedPath} path-annotated block(s) ` +
              `(last resort — all unnamed already removed). ` +
              `${beforeChars.toLocaleString()} → ${rebuilt.length.toLocaleString()} chars`
            );
            break;
          }
        }
      }
    }

    // Tier3 (attention engine) — summary is a flat string with no code blocks
    // to prune. Measure the exact "shell" cost (attentionMap + metadata sections)
    // so we know precisely how many chars the summary may use.
    if (rebuilt.length > MAX_PROMPT_CHARS && tier === 3) {
      const TRIM_MARKER = `\n\n... [ContextMover: attention summary trimmed to fit editor limit] ...\n\n`;
      const shellPrompt = buildMigrationPrompt({
        summary: "",
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
      const summaryBudget = MAX_PROMPT_CHARS - shellPrompt.length - TRIM_MARKER.length - 50;
      if (summaryBudget > 500 && summary.length > summaryBudget) {
        const head = Math.floor(summaryBudget * 0.75);
        const tail = summaryBudget - head;
        const trimmedSummary =
          summary.slice(0, head) + TRIM_MARKER + summary.slice(-tail);
        const candidate = buildMigrationPrompt({
          summary: trimmedSummary,
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
        rebuilt = candidate;
        console.warn(
          `[ContextMover:sw] Priority cap tier3: summary trimmed to ${summaryBudget.toLocaleString()} chars. ` +
          `${beforeChars.toLocaleString()} → ${rebuilt.length.toLocaleString()} chars`
        );
      }
    }

    // Last-resort fallback: structured sections alone exceed the cap (unusual).
    if (rebuilt.length > MAX_PROMPT_CHARS) {
      const headChars = Math.floor(MAX_PROMPT_CHARS * 0.7);
      const tailChars = MAX_PROMPT_CHARS - headChars - 200;
      const dropped = rebuilt.length - headChars - tailChars;
      rebuilt =
        rebuilt.slice(0, headChars) +
        `\n\n... [ContextMover: ${dropped.toLocaleString()} chars trimmed — all code blocks removed, structured sections preserved] ...\n\n` +
        rebuilt.slice(-tailChars);
      console.warn(
        `[ContextMover:sw] Priority cap fallback: ${beforeChars.toLocaleString()} → ${rebuilt.length.toLocaleString()} chars`
      );
    }

    finalPrompt = rebuilt;
  }

  // ── Cache final prompt to IDB (fire & forget) ─────────────────────────────
  // Skipped when projectContext is active — its content changes the output but
  // is not captured in the cache key, so cache would return stale prompts.
  if (!payload.projectContext) {
    void semanticIndex.cachePrompt(
      payload.sessionId, payload.task ?? null,
      payload.targetPlatform, tier,
      payload.promptTemplateId ?? null,
      finalPrompt, []
    ).catch(() => {});
  }

  // ── MCP Migration path (optional, when a local MCP server is available) ──
  // If an MCP server is connected and exposes create_conversation, use it
  // instead of DOM injection. This works with Claude Desktop, Continue.dev,
  // and any custom MCP server that implements the create_conversation tool.
  let mcpConversationId: string | undefined;
  try {
    const mcpClient = await connectToFirstAvailableMcp();
    if (mcpClient) {
      const hasCreateConv = mcpClient.availableTools.some((t) =>
        /create_conversation|create_chat|new_chat/i.test(t.name)
      );
      if (hasCreateConv) {
        reportProgress(96, "Creating conversation via MCP...");
        const mcpResult = await mcpClient.createConversation(session.title, [
          { role: "user", content: finalPrompt },
        ]);
        if (mcpResult.conversationId) {
          mcpConversationId = mcpResult.conversationId;
          console.log(`[CM:sw] MCP conversation created: ${mcpConversationId}`);
          // Open the target platform URL with the new conversation
          const platformUrls: Record<string, string> = {
            claude: "https://claude.ai/chat",
            chatgpt: "https://chat.openai.com",
            gemini: "https://gemini.google.com/app",
            grok: "https://grok.x.ai",
            deepseek: "https://chat.deepseek.com",
            perplexity: "https://perplexity.ai",
          };
          const baseUrl = platformUrls[payload.targetPlatform];
          if (baseUrl && payload.targetTabId) {
            const targetUrl = `${baseUrl}?cm_mcp_id=${encodeURIComponent(mcpConversationId)}`;
            await chrome.tabs.update(payload.targetTabId, { url: targetUrl });
          }
        }
        mcpClient.disconnect();
      } else {
        mcpClient.disconnect();
      }
    }
  } catch (err) {
    console.warn("[CM:sw] MCP migration path failed (non-fatal):", err);
  }

  // ── Inject into target tab ─────────────────────────────────────────────────
  if (payload.targetTabId && !mcpConversationId) {
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
      console.error(`[CM:sw] injection blocked — tab ${payload.targetTabId} (${targetTab.url}) not whitelisted for platform=${payload.targetPlatform}`);
      return sendResponse({ error: `The active tab (${targetTab.url}) is not a ${payload.targetPlatform} page. Open ${payload.targetPlatform} in the target tab and try again.` });
    }
    console.log(`[CM:sw] injection domain verified: ${targetTab.url} → ${payload.targetPlatform}`);
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
    console.log(`[ContextMover:sw] Stage6 — injection confirmed in tab ${payload.targetTabId}`);
  }

  // Score the migration before responding so the sidebar can show the
  // QualityScoreCard. Scoring is synchronous + fast; persistence is fire-
  // and-forget. Wrapped in try/catch so a scoring bug never breaks injection.
  let qualityScore: QualityScore | undefined;
  try {
    qualityScore = scoreAndPersist(
      session,
      finalPrompt,
      tier,
      payload.targetPlatform,
      tier === 3 ? 15 : undefined
    );
  } catch (err) {
    console.warn("[CM:quality] scoreAndPersist failed (non-fatal):", err);
  }

  console.log(`[CM:sw] Migration complete in ${(performance.now() - t0_migrate).toFixed(0)}ms`);
  perf.logReport();
  sendResponse({
    ok: true,
    prompt: finalPrompt,
    compressionRatio,
    qualityScore,
    ...(mcpConversationId ? { mcpConversationId, migratedViaMcp: true } : {}),
  });
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
        console.warn("[ContextMover] Tab sync failed:", platform, tab.id, error);
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
    // ── Fast path for large text (>5k chars) ────────────────────────────────
    // execCommand("insertText") with 30k+ chars freezes ProseMirror/Lexical for
    // 10-180 seconds because it dispatches per-character beforeinput handling.
    // Synthetic ClipboardEvent with DataTransfer is handled as a single bulk
    // paste operation — ~50× faster on large strings.
    // (Mirrored from content/shared.ts setPromptInputValue.)
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
        if (dispatched || (input.textContent?.length ?? 0) > text.length / 2) {
          if ((input.textContent?.trim().length ?? 0) > 0) return { ok: true };
        }
      } catch { /* fall through to standard path */ }
    }

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
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 500;
  const ATTEMPT_TIMEOUT_MS = 10_000;

  let lastError = "Unknown injection error";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Race the tab message against a per-attempt 10-second timeout.
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, message) as Promise<unknown>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Injection timed out after 10s")), ATTEMPT_TIMEOUT_MS)
        ),
      ]);

      const res = response as { ok?: boolean; error?: string } | null;
      if (res?.ok) return { ok: true };
      if (res?.error) {
        // Content-script-reported error — surface directly, don't retry.
        return { ok: false, error: res.error };
      }
      lastError = "The target tab did not confirm that the migrated prompt was inserted.";
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Unknown tab messaging error";
      lastError = messageText;
      console.warn(`[ContextMover] Tab injection attempt ${attempt}/${MAX_RETRIES} failed:`, messageText);

      // Content script absent — fall back to executeScript immediately (no retry needed).
      if (
        messageText.includes("Receiving end does not exist") ||
        messageText.includes("Could not establish connection")
      ) {
        console.log(`[ContextMover] Content script absent — falling back to executeScript injection for tab ${tabId}`);
        try {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: injectPromptInPage,
            args: [message.prompt, message.platform],
          });
          const res = result?.result as { ok: boolean; error?: string } | undefined;
          if (res?.ok) {
            console.log(`[ContextMover] executeScript injection succeeded for tab ${tabId}`);
            return { ok: true };
          }
          return {
            ok: false,
            error: res?.error ?? "Direct page injection failed. Reload the target tab and try again.",
          };
        } catch (scriptErr) {
          const scriptMsg = scriptErr instanceof Error ? scriptErr.message : String(scriptErr);
          console.warn("[ContextMover] executeScript fallback failed:", scriptMsg);
          return {
            ok: false,
            error: `Could not reach the ${message.platform} tab: ${scriptMsg}. Try reloading that tab.`,
          };
        }
      }

      // Timeout or other transient error — wait before retry.
      if (attempt < MAX_RETRIES) {
        await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  return {
    ok: false,
    error: `Injection failed after ${MAX_RETRIES} attempts — make sure the ${message.platform} tab is active and not loading. (${lastError})`,
  };
}

// ── SW lifecycle ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(self as unknown as ServiceWorkerGlobalScope).addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      await semanticIndex.cleanupOldData();
      console.log('[CM:sw] activate: IDB cleanup complete');
    } catch (e) {
      console.warn('[CM:sw] activate: cleanup failed (non-fatal):', e);
    }
  })());
});
