// packages/browser-extension/src/background/service-worker.ts
import { db, dexieDb, sessionCache } from "@/lib/db";
import { migrateFromContextForge } from "@/lib/db-migration";
import summarize, { summarizeIntelligent, type IntelligentSummary } from "@/lib/summarizer";
import buildMigrationPrompt from "@/lib/translator";
import type { ContextSession, Message } from "@/lib/types";
import { supabase } from "@/lib/supabase";
import { syncPromptTemplates, syncPromptAssignments, queueVaultSync } from "@/lib/cloud-sync";
import { semanticIndex } from "@/lib/semantic-index/index";
import { scoreMigration, formatScoreReport, type QualityScore } from "@/lib/quality/migration-scorer";
import { generateQualityReport } from "@/lib/quality/report-generator";
import { userVault } from "@/lib/user-vault/connector";
import { forgetSession, resolveSessionId } from "@/lib/session-id";
import { WEBAPP_URL } from "@/config/urls";
import { buildTier1File, buildTier2File, buildTier3File } from "@/lib/file-builder"
import { buildInstructionPrompt } from "@/lib/instruction-builder"
import { checkUsage, incrementUsage } from "@/lib/usage-client";
import type { MigrationFile } from "@/lib/file-builder"

// ── Attention-engine availability (set to false if model fetch blocked) ─────
let attentionEngineAvailable = true;

// ── In-memory migration file cache ────────────────────────────────────────────
interface CachedMigrationFile {
  filename: string
  content: string
  charCount: number
  estimatedTokens: number
  tier: number
  platform: string
  sessionTitle: string
  cachedAt: number
  sessionId: string
}

const migrationFileCache = new Map<string, CachedMigrationFile>()
const FILE_CACHE_TTL_MS = 30 * 60 * 1000  // 30 minutes

function makeCacheKey(sessionId: string, tier: number): string {
  return `${sessionId}-tier${tier}`
}

function purgeStaleCacheEntries(): void {
  const now = Date.now()
  for (const [key, entry] of migrationFileCache.entries()) {
    if (now - entry.cachedAt > FILE_CACHE_TTL_MS) {
      migrationFileCache.delete(key)
      console.debug(`[CM:cache] Purged stale file: ${entry.filename}`)
    }
  }
}

setInterval(purgeStaleCacheEntries, 5 * 60 * 1000)

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
// keyed per-tab for cleanup; injectedScripts is per-(tab,script) for dedup.
const injectedTabs = new Set<number>();
const injectedScripts = new Set<string>(); // "tabId:scriptFiles" composite key

// Clean up both sets when a tab closes so reloaded tabs can be re-injected.
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  for (const k of injectedScripts) {
    if (k.startsWith(`${tabId}:`)) injectedScripts.delete(k);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["SIDE_PANEL" as chrome.runtime.ContextType],
    });
    for (const ctx of contexts as { tabId?: number }[]) {
      if (ctx.tabId !== undefined && ctx.tabId !== activeInfo.tabId) {
        try {
          await (chrome.sidePanel as unknown as { close(d: { tabId: number }): Promise<void> }).close({ tabId: ctx.tabId });
        } catch {
          // Tab may have navigated or panel already closed — ignore
        }
      }
    }
  } catch {
    // getContexts may fail on SW restart — ignore silently
  }
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


// ── Lifecycle ──────────────────────────────────────────────────────────────────
// Rebrand migration — runs on every SW cold start (install / update / spawn).
// The function is idempotent: it no-ops if the legacy "contextforge" IndexedDB
// is not present. Errors are swallowed internally so migration failure can
// never brick capture.
void migrateFromContextForge();

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[ContextMover] Extension installed.");
  // Belt-and-braces: also trigger on install/update so a fresh-install path
  // during the legacy database upgrade to ContextMover is always covered.
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
      const scriptKey = `${tab.id}:${(cs.js ?? []).join(',')}`;
      if (injectedScripts.has(scriptKey)) {
        console.log(`[ContextMover] Tab ${tab.id} already injected this session — skipping`);
        continue;
      }
      // First new script for this tab: clear stale window flags left behind by
      // the old (now-dead) extension context so new scripts can self-initialize.
      if (!injectedTabs.has(tab.id)) {
        injectedTabs.add(tab.id);
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            (['__contextForge_claude_loaded', '__contextForge_chatgpt_loaded',
              '__contextForge_gemini_loaded', '__contextForge_grok_loaded',
              '__contextForge_perplexity_loaded', '__contextForge_deepseek_loaded',
              '__cm_toggle_v2'] as const).forEach((k) => {
              try { delete (window as unknown as Record<string, unknown>)[k]; } catch { /* non-configurable */ }
            });
          },
        }).catch(() => {});
      }
      injectedScripts.add(scriptKey);
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: cs.js as string[] })
        .then(() => console.log(`[ContextMover] Injected content script into tab ${tab.id} (${tab.url})`))
        .catch(() => { /* non-scriptable tab */ });
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
    .catch(() => {});
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

      case "PRECOMPUTE_SUMMARY": {
        const session = await db.getSession(msg.payload?.sessionId);
        if (!session) { sendResponse(null); break; }
        try {
          await summarize(session.messages);
          summarizeIntelligent(session.messages);
          console.log(`[CM:sw] PRECOMPUTE_SUMMARY warmed summaries for session ${session.id}`);
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

      case "GET_ATTENTION_STATUS": {
        sendResponse({ available: attentionEngineAvailable });
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
        const _tier = (msg.payload?.tier ?? 2) as 1 | 2 | 3;
        const { accessToken } = await chrome.storage.local.get("accessToken");

        if (accessToken) {
          const usage = await checkMigrationAllowed(_tier, accessToken as string);
          if (!usage.allowed) {
            sendResponse({
              success: false,
              error: "limit_reached",
              limitData: {
                tier: _tier,
                used: usage.used,
                limit: usage.limit,
                daysUntilReset: usage.daysUntilReset ?? 0,
                upgradeUrl: usage.upgradeUrl ?? "https://contextmover.com/pricing",
              },
            });
            break;
          }
        }

        await handleMigrateContext(msg.payload, sendResponse, accessToken as string | undefined);
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
          // Store token for usage-limit API calls.
          if (data.session?.access_token) {
            await chrome.storage.local.set({
              accessToken: data.session.access_token,
              userId: data.user?.id,
            });
          }
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
        await chrome.storage.local.remove(["accessToken", "userId"]);
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
        const hint = (msg as { shouldOpen?: boolean }).shouldOpen;

        // If the content script passes the desired target state, use it directly
        // to avoid a getContexts() await before sidePanel.open() — the await can
        // consume the user-gesture activation token in some Chrome builds.
        let panelShouldOpen: boolean;
        if (hint !== undefined) {
          panelShouldOpen = hint;
        } else {
          // Fallback: derive target state from live panel contexts
          let panelIsOpen = false;
          try {
            const contexts = await chrome.runtime.getContexts({
              contextTypes: ["SIDE_PANEL" as chrome.runtime.ContextType],
            });
            panelIsOpen = contexts.some((ctx: { tabId?: number }) => ctx.tabId === tabId);
          } catch {
            panelIsOpen = false;
          }
          panelShouldOpen = !panelIsOpen;
        }

        if (!panelShouldOpen) {
          // Close the panel
          try {
            await (chrome.sidePanel as unknown as { close(d: { tabId: number }): Promise<void> }).close({ tabId });
            sendResponse({ isOpen: false });
          } catch {
            // Fallback for Chrome < 123
            await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
            await chrome.sidePanel.setOptions({
              tabId, enabled: true, path: "src/sidebar/index.html",
            }).catch(() => {});
            sendResponse({ isOpen: false });
          }
        } else {
          // Open the panel
          try {
            await chrome.sidePanel.open({ tabId });
            sendResponse({ isOpen: true });
          } catch (err) {
            sendResponse({ isOpen: false, error: String(err) });
          }
        }
        break;
      }

      case "CLOSE_SIDEBAR": {
        if (sender.tab?.id == null) {
          sendResponse({ ok: true });
          break;
        }
        try {
          await (chrome.sidePanel as unknown as { close(d: { tabId: number }): Promise<void> }).close({
            tabId: sender.tab.id,
          });
        } catch {
          // ignore — panel may already be closed
        }
        sendResponse({ ok: true });
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
        if (!attentionEngineAvailable) {
          sendResponse({ ok: false, unavailable: true });
          break;
        }
        void (async () => {
          try {
            await semanticIndex.warmup();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("Failed to fetch")) {
              attentionEngineAvailable = false;
              await chrome.storage.local.set({ attentionEngineAvailable: false });
              console.debug("[CM:sw] Model fetch blocked — Attention tier unavailable on this session");
              return;
            }
            console.warn("[CM:sw] warmup failed:", e);
          }
        })();
        sendResponse({ ok: true });
        break;
      }

      case "RETRY_MODEL_LOAD": {
        attentionEngineAvailable = true;
        await chrome.storage.local.set({ attentionEngineAvailable: true });
        sendResponse({ ok: true });
        void (async () => {
          try {
            await semanticIndex.warmup();
            console.debug("[CM:sw] RETRY_MODEL_LOAD warmup succeeded");
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("Failed to fetch")) {
              attentionEngineAvailable = false;
              await chrome.storage.local.set({ attentionEngineAvailable: false });
              console.debug("[CM:sw] RETRY_MODEL_LOAD still blocked:", msg);
            } else {
              console.warn("[CM:sw] RETRY_MODEL_LOAD warmup error:", e);
            }
          }
        })();
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

      case "GET_CACHED_FILE": {
        const entry = migrationFileCache.get(msg.cacheKey)
        if (!entry) {
          sendResponse({ success: false, error: 'File not in cache or expired' })
          break
        }
        sendResponse({ success: true, file: entry })
        break
      }

      case "DELETE_CACHED_FILE": {
        migrationFileCache.delete(msg.cacheKey)
        console.debug(`[CM:cache] Deleted on user action: ${msg.cacheKey}`)
        sendResponse({ success: true })
        break
      }

      case "GET_SIDEBAR_STATE": {
        let isOpen = false;
        try {
          const contexts = await chrome.runtime.getContexts({
            contextTypes: ["SIDE_PANEL" as chrome.runtime.ContextType],
          });
          const senderTabId = sender.tab?.id;
          if (senderTabId !== undefined) {
            isOpen = contexts.some(
              (ctx: { tabId?: number }) => ctx.tabId === senderTabId
            );
          } else {
            isOpen = contexts.length > 0;
          }
        } catch {
          isOpen = false;
        }
        sendResponse({ isOpen });
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

// ── Usage enforcement (freemium gate) ───────────────────────────────────────
// Two paths:
//   1. Logged-in users → server-side increment_usage RPC via /api/payments/usage
//   2. Anonymous users → local chrome.storage counters (best-effort gate)
//
// Fails OPEN on any network / auth error — a flaky network must NEVER block a
// migration. The server-side path is the source of truth for paying users.

interface UsageCheckResult {
  allowed:        boolean;
  plan:           string;
  unlimited:      boolean;
  tier:           number;
  used:           number;
  limit:          number;
  remaining:      number;
  reason?:        string;
  daysUntilReset?: number;
  resetDate?:     string;
  upgradeUrl?:    string;
  fallback?:      boolean;
}

async function checkMigrationAllowed(
  tier: 1 | 2 | 3,
  accessToken: string
): Promise<UsageCheckResult> {
  return checkUsage(tier, accessToken);
}

// ── Handlers ───────────────────────────────────────────────────────────────────
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
  if (!attentionEngineAvailable) return;
  try {
    const t0 = performance.now();
    await semanticIndex.indexSession(session);
    const dt = (performance.now() - t0).toFixed(0);
    console.log(`[CM:sw:bgIdx] indexed session ${session.id} in ${dt}ms`);

    // Mirror chunk embeddings to the MCP bridge for IDE-side semantic_search.
    // Fire-and-forget; bridge offline is the common case and fine.
    void syncEmbeddingsToMcpBridge(session.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Failed to fetch")) {
      attentionEngineAvailable = false;
      await chrome.storage.local.set({ attentionEngineAvailable: false });
      console.debug("[CM:bgIdx] Model fetch blocked — Attention tier unavailable on this session");
      return;
    }
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
        sessionId: session.id,
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
        sessionId: session.id,
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
    promptTemplate?: { name: string; content: string; icon: string } | null;
    projectContext?: string | null;
  },
  sendResponse: (r: unknown) => void,
  accessToken?: string
) {
  const t0 = performance.now()
  const session = await db.sessions.get(payload.sessionId)
  if (!session) {
    sendResponse({ success: false, error: 'Session not found' })
    return
  }
  reportProgress(10, 'Loading session...')
  const tier = (payload.tier ?? 2) as 1 | 2 | 3
  let migrationFile: MigrationFile
  reportProgress(20, 'Building context file...')
  try {
    if (tier === 1) {
      migrationFile = buildTier1File(session)
    } else if (tier === 2) {
      reportProgress(30, 'Extracting smart summary...')
      const stored = await semanticIndex.getSummary(
        session.id, 2, payload.task ?? null, session.messages.length
      )
      let summary: IntelligentSummary
      if (stored) {
        summary = JSON.parse(stored.content)
      } else {
        summary = summarizeIntelligent(session.messages, payload.task)
        await semanticIndex.saveSummary(
          session.id, 2, payload.task ?? null,
          JSON.stringify(summary), summary.compressionRatio,
          session.messages.length
        )
      }
      migrationFile = buildTier2File(session, summary, payload.task)
    } else {
      if (!attentionEngineAvailable) {
        sendResponse({ success: false, error: 'Attention Engine unavailable — model could not load on this device' });
        return;
      }
      reportProgress(30, 'Running attention engine...')
      try {
        const needsIndex = await semanticIndex.needsIndexing(session)
        if (needsIndex) {
          reportProgress(35, 'Indexing session...')
          await semanticIndex.indexSession(session, (pct: number, stage: string) => {
            reportProgress(35 + pct * 0.4, stage)
          })
        }
        reportProgress(75, 'Retrieving relevant chunks...')
        const chunks = await semanticIndex.retrieve(
          session.id, payload.task ?? null, 15
        )
        migrationFile = buildTier3File(
          session, chunks,
          payload.task ?? 'Continue from where we left off'
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Failed to fetch")) {
          attentionEngineAvailable = false;
          await chrome.storage.local.set({ attentionEngineAvailable: false });
          console.debug("[CM:sw] Model fetch blocked during migration — Attention tier unavailable");
          sendResponse({ success: false, error: 'Attention Engine unavailable — model could not load on this device' });
          return;
        }
        throw err;
      }
    }
  } catch (err: any) {
    console.warn('[CM:sw] File build failed, falling back to tier 1:', err)
    migrationFile = buildTier1File(session)
  }

  // ── Attach prompt template to XML if specified ────────────────────────────────────
  // payload.promptTemplate is preferred (includes system templates which are never in DB).
  // Fall back to DB lookup for legacy callers that only pass promptTemplateId.
  const tplData = payload.promptTemplate
    ?? (payload.promptTemplateId ? await dexieDb.prompt_templates.get(payload.promptTemplateId).catch(() => null) : null);
  if (tplData) {
    try {
      const templateSection = `
  <prompt_template>
    <name><![CDATA[${tplData.name}]]></name>
    <content><![CDATA[${tplData.content}]]></content>
  </prompt_template>`;
      migrationFile.content = migrationFile.content.replace(
        '</meta>',
        `</meta>\n${templateSection}`
      );
      migrationFile.charCount = migrationFile.content.length;
      migrationFile.estimatedTokens = Math.ceil(migrationFile.content.length / 4);
      console.debug('[CM:sw] Prompt template attached:', tplData.name);
    } catch (err) {
      console.warn('[CM:sw] Prompt template attach failed:', err);
    }
  }

  // ── Append project files if provided ──────────────────────────────────────────
  // projectContext is already structured XML/Markdown from fileContextBuilder —
  // insert it directly without any additional CDATA wrapping.
  if (payload.projectContext && payload.projectContext.length > 0) {
    const closingTag = migrationFile.content.lastIndexOf('</contextmover_migration>');
    if (closingTag !== -1) {
      migrationFile.content =
        migrationFile.content.slice(0, closingTag) +
        '\n' + payload.projectContext + '\n' +
        migrationFile.content.slice(closingTag);
    } else {
      migrationFile.content += '\n' + payload.projectContext;
    }
    migrationFile.charCount = migrationFile.content.length;
    migrationFile.estimatedTokens = Math.ceil(migrationFile.content.length / 4);
    console.debug('[CM:sw] Project files appended:', payload.projectContext.length, 'chars');
  }

  reportProgress(80, 'Building instructions...')
  const instructionPrompt = buildInstructionPrompt({
    session,
    targetPlatform: payload.targetPlatform,
    tier,
    task: payload.task,
    filename: migrationFile.filename,
    estimatedTokens: migrationFile.estimatedTokens,
    caveman: payload.caveman
  })
  reportProgress(90, 'Injecting instructions...')
  let injected = false
  if (!payload.targetTabId) {
    console.warn('[CM:sw] No targetTabId — skipping injection')
  } else {
    try {
      const result = await sendMessageToTab(payload.targetTabId, {
        type: 'INJECT_CONTEXT',
        prompt: instructionPrompt,
        platform: payload.targetPlatform
      })
      injected = result?.ok ?? false
    } catch (err) {
      console.warn('[CM:sw] Injection failed (non-fatal):', err)
    }
  }
  const elapsed = performance.now() - t0
  reportProgress(100, 'Done')
  const cacheKey = makeCacheKey(session.id, tier)
  migrationFileCache.set(cacheKey, {
    filename: migrationFile.filename,
    content: migrationFile.content,
    charCount: migrationFile.charCount,
    estimatedTokens: migrationFile.estimatedTokens,
    tier,
    platform: session.platform,
    sessionTitle: session.title,
    cachedAt: Date.now(),
    sessionId: session.id
  })
  console.debug(`[CM:cache] Stored: ${migrationFile.filename}`)
  // Fire-and-forget usage increment — never block the response.
  if (accessToken) {
    void incrementUsage(tier, accessToken);
  }
  sendResponse({
    success: true,
    injected,
    cacheKey,
    migrationFile: {
      filename: migrationFile.filename,
      charCount: migrationFile.charCount,
      estimatedTokens: migrationFile.estimatedTokens,
      tier,
      platform: session.platform,
      sessionTitle: session.title
    },
    elapsed: Math.round(elapsed)
  })
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
  } else if (platform === "perplexity") {
    type PEntry = { el: HTMLElement; role: "user" | "assistant" };
    const pCollected: PEntry[] = [];
    document.querySelectorAll<HTMLElement>(
      '.user-query, [data-testid="user-message"], [class*="UserQuery"], [class*="user-message"]'
    ).forEach((el) => pCollected.push({ el, role: "user" }));
    document.querySelectorAll<HTMLElement>(
      '.assistant-content, [data-testid="answer"], [class*="AnswerBody"], .prose, [class*="answer-content"]'
    ).forEach((el) => pCollected.push({ el, role: "assistant" }));
    pCollected.sort((a, b) => {
      const rel = a.el.compareDocumentPosition(b.el);
      return rel & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    messages = pCollected
      .map(({ el, role }) => {
        const content = el.innerText.trim();
        return content ? { role, content, timestamp: Date.now() } : null;
      })
      .filter(Boolean) as typeof messages;
  } else if (platform === "deepseek") {
    type DEntry = { el: HTMLElement; role: "user" | "assistant" };
    const dCollected: DEntry[] = [];
    document.querySelectorAll<HTMLElement>(
      '[class*="human-message"], [class*="user-message"], [data-role="user"], .fbb737a4'
    ).forEach((el) => dCollected.push({ el, role: "user" }));
    document.querySelectorAll<HTMLElement>(
      '[class*="assistant-message"], [class*="ds-markdown"], [data-role="assistant"], .f9bf7997'
    ).forEach((el) => dCollected.push({ el, role: "assistant" }));
    dCollected.sort((a, b) => {
      const rel = a.el.compareDocumentPosition(b.el);
      return rel & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    messages = dCollected
      .map(({ el, role }) => {
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
