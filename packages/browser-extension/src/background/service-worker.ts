/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/background/service-worker.ts
import { db, dexieDb, ensureDbReady, sessionCache } from "@/lib/db";
import { migrateFromContextForge } from "@/lib/db-migration";
import summarize, { summarizeIntelligent, buildTier2WithScoring, type IntelligentSummary } from "@/lib/summarizer";
import buildMigrationPrompt from "@/lib/translator";
import type { ContextSession, Message, ScoredMessage } from "@/lib/types";
import { supabase } from "@/lib/supabase";
import { syncPromptTemplates, syncPromptAssignments, queueVaultSync } from "@/lib/cloud-sync";
import { semanticIndex } from "@/lib/semantic-index/index";
import { getHardwareProfile, attentionEngine } from "@/lib/attention-engine";
import { scoreMigration, formatScoreReport, type QualityScore } from "@/lib/quality/migration-scorer";
import { generateQualityReport } from "@/lib/quality/report-generator";
import { userVault } from "@/lib/user-vault/connector";
import { forgetSession, resolveSessionId } from "@/lib/session-id";
import { WEBAPP_URL } from "@/config/urls";
import { buildTier1File, buildTier2File, buildTier3File, getMessagesFromChunks } from "@/lib/file-builder"
import { buildInstructionPrompt } from "@/lib/instruction-builder"
import { checkUsage, incrementUsage } from "@/lib/usage-client"
import type { MigrationFile } from "@/lib/file-builder"
import { fetchSummary, fetchMigrationBuild, reportScraperBroken, reportInjectionError, reportExtensionEvent } from "@/lib/server-intelligence-client"
import { getRemoteConfig } from "@/lib/remote-config"
// Drive sync — additive layer over IndexedDB. Independent of Supabase vault.
import { driveClient } from "@/lib/drive/drive-client";
import { driveSyncManager } from "@/lib/drive/sync-manager";

const DEBUG = process.env.NODE_ENV === "development";
const DEBUG_DIAG = false; // Set true to re-enable verbose diagnostic log mirroring

// ── Attention-engine availability (set to false if model fetch blocked) ─────
let attentionEngineAvailable = true;
let activeMigrationInProgress = false;

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

// Pending tier-selection gates — keyed by pendingId (UUID).
// When MIGRATE_CONTEXT arrives without an explicit tier, the SW pauses here
// and waits for MIGRATION_TIER_CONFIRMED from the sidebar (60 s timeout → Tier 1).
const pendingMigrations = new Map<string, { resolve: (tier: 1 | 2 | 3) => void }>()

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

// Track which tab last had its sidebar opened so SIDEBAR_CLOSED can relay
// the notification to the toggle content script even when the side panel
// sends the message without a tab context (sender.tab === undefined).
let lastSidebarTabId: number | null = null;

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

// MetaPrompt rebuild guard — skip re-summarisation when message content hasn't
// changed since the last build, or when the last build was < 30 s ago.
const metaPromptLastHash = new Map<string, string>();
const metaPromptLastBuiltAt = new Map<string, number>();
const METAPROMPT_COOLDOWN_MS = 30_000;

// SCRAPER_BROKEN refresh debounce — one remote-config fetch per 30 s is enough
// even when multiple content scripts break simultaneously.
let scraperBrokenRefreshAt = 0;
const SCRAPER_BROKEN_REFRESH_COOLDOWN_MS = 30_000;

/**
 * Ensures the offscreen document is running before sending it a message.
 * Lightweight version scoped to the SW — swallows "already exists" errors.
 */
async function ensureOffscreenDocumentLocal(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offscreen = (chrome as any).offscreen;
  if (!offscreen) return;
  // [CM-RACE-FIX] keep-alive starts BEFORE doc creation so it covers hasDocument + createDocument + ONNX init
  const ka = setInterval(() => chrome.storage.local.get('_ka', () => {}), 5_000);
  try {
    const has: boolean = await offscreen.hasDocument?.() ?? false;
    if (has) { clearInterval(ka); return; }
    await offscreen.createDocument({
      url: "src/offscreen/offscreen.html",
      reasons: ["WORKERS"],
      justification: "Run ML embedding pipeline for Tier 3 context retrieval",
    });
    console.log("[CM:sw] offscreen document created");
    try {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error('offscreen_ready_timeout')), 20_000);
        const l = (m: any) => { if (m?.type === 'OFFSCREEN_READY') { clearTimeout(t); chrome.runtime.onMessage.removeListener(l); res(); } };
        chrome.runtime.onMessage.addListener(l);
      });
      console.log("[CM:sw] offscreen ready");
    } catch (e) { console.warn("[CM:sw] offscreen ready wait:", e); }
    finally { clearInterval(ka); }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Only a single offscreen") && !msg.includes("already")) {
      console.warn("[CM:sw] ensureOffscreenDocumentLocal failed:", msg);
    }
  }
}

// GET_SESSIONS result cache — coalesces rapid-fire sidebar polls within 500ms.
let getSessionsCache: unknown = null;
let getSessionsCacheAt = 0;
const GET_SESSIONS_CACHE_MS = 500;

// Throttle the background Drive pull triggered by GET_SESSIONS.
// Without this, rapid sidebar polls reset the upload debounce timer
// continuously, so queued uploads never fire.
let lastDrivePullFromListAt = 0;
const DRIVE_PULL_FROM_LIST_COOLDOWN_MS = 60_000;

// Injection guard — tracks tabs already scripted this SW lifetime to prevent
// the same tab being injected 3× on rapid onInstalled/onStartup events.
// keyed per-tab for cleanup; injectedScripts is per-(tab,script) for dedup.
const injectedTabs = new Set<number>();
const injectedScripts = new Set<string>(); // "tabId:scriptFiles" composite key

// [CM-PERF] tracks whether the ONNX model is already loaded in the offscreen doc.
// Prevents repeated ~90s re-inits on rapid sidebar open/close cycles.
let modelWarmed = false;

// Clean up both sets when a tab closes so reloaded tabs can be re-injected.
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  for (const k of injectedScripts) {
    if (k.startsWith(`${tabId}:`)) injectedScripts.delete(k);
  }
  // [CM-PERF] offscreen doc may be destroyed when tab closes — reset warm flag
  modelWarmed = false;
});

// ── Trigger capture on tab URL changes ─────────────────────────────────────
// When a user navigates to an existing conversation URL (or reloads), trigger
// a capture so the extension detects and scrapes the conversation without
// requiring user interaction. The content script's debounce prevents duplicate
// captures within 1500ms.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && PLATFORM_GLOB_RE.test(tab.url)) {
    chrome.tabs.sendMessage(tabId, { type: 'TRIGGER_CAPTURE' }, () => {
      void chrome.runtime.lastError; // swallow if content script not ready
    });
  }
});

// ── Auto-close sidebar on tab/window switch ───────────────────────────────
// Why this is broadcast-based rather than chrome.sidePanel.close({tabId}):
//   • getContexts() returns ctx.tabId as undefined when the panel was opened
//     in default mode, so iterating and matching by tabId silently skips it.
//   • chrome.sidePanel.close throws on Chrome < 123, and even on 123+ may
//     no-op silently when the panel is in default behavior.
//   • Broadcasting SIDEBAR_FORCE_CLOSE lets the sidebar window.close() itself,
//     which is the reliable cross-version path.
async function closeAllSidebarsAndNotify(): Promise<void> {
  // 1. Tell every sidebar instance (any tab/window) to self-close.
  try {
    await chrome.runtime.sendMessage({ type: "SIDEBAR_FORCE_CLOSE" });
  } catch (err) {
    console.debug("[CM:sw] closeAllSidebars: no sidebar receivers", err instanceof Error ? err.message : err);
  }
  // 2. Reset all toggle-button icons via existing SIDEBAR_CLOSED listener.
  try {
    const tabs = await chrome.tabs.query({ url: ALL_PLATFORM_URL_GLOBS });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        chrome.tabs.sendMessage(tab.id, { type: "SIDEBAR_CLOSED" }, () => {
          void chrome.runtime.lastError;
        });
      } catch (err) {
        console.debug(`[CM:sw] closeAllSidebars: tab ${tab.id} gone`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn("[CM:sw] closeAllSidebars: tabs.query failed", err);
  }
  // 3. Best-effort native close (Chrome 123+); ignored if unsupported.
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["SIDE_PANEL" as chrome.runtime.ContextType],
    });
    for (const ctx of contexts as { tabId?: number }[]) {
      if (ctx.tabId === undefined) continue;
      try {
        await (chrome.sidePanel as unknown as { close(d: { tabId: number }): Promise<void> })
          .close({ tabId: ctx.tabId });
      } catch (err) {
        console.debug(`[CM:sw] closeAllSidebars: sidePanel.close unsupported`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.debug("[CM:sw] closeAllSidebars: getContexts unavailable", err instanceof Error ? err.message : err);
  }
}

// Auto-close on tab/window change removed: sidebar must persist across tab
// switches so cross-tab migrations (source tab → target LLM tab) are not
// interrupted. closeAllSidebarsAndNotify() remains available for explicit
// programmatic close (e.g. on extension uninstall or user-initiated logout).

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
//
// CRITICAL: ensureDbReady() must run BEFORE the legacy migration (and before
// any handler touches the DB). Dexie auto-opens lazily on first access, and
// if the open fails (e.g. UpgradeError when a primary key changed across
// versions) there is no automatic recovery — the DB stays closed and every
// subsequent operation throws DatabaseClosedError. Awaiting ensureDbReady
// first lets the recovery path delete-and-recreate when the upgrade is
// impossible.
void (async () => {
  try {
    await ensureDbReady();
  } catch (err) {
    console.error("[CM:sw] ensureDbReady failed at startup:", err);
  }
  void migrateFromContextForge();
})();

// ── Remote config: warm cache so content scripts have selectors ready ────────
// Refresh is triggered from THREE places (defence in depth):
//   1. chrome.runtime.onInstalled — fresh install / extension update
//   2. chrome.runtime.onStartup    — browser startup (covers stale-cache restart)
//   3. chrome.alarms (every 6 h)   — long-running browser sessions
// Plus content scripts implicitly refresh via getRemoteConfig()'s 1-hour TTL.
// Hot-fixes pushed to selectors.json reach all users within ~6 h worst-case.
const REMOTE_CONFIG_ALARM = "cm-remote-config-refresh";
const REMOTE_CONFIG_PERIOD_MIN = 6 * 60; // 6 hours
async function refreshRemoteConfig(): Promise<void> {
  try {
    // Force-expire the cache by clearing the timestamp, then call getRemoteConfig
    // which will fetch fresh and re-cache.
    await chrome.storage.local.remove("remoteConfigTs");
    const cfg = await getRemoteConfig();
    if (cfg) {
      console.log(`[CM:config] Remote config refreshed.`);
    } else {
      console.log("[CM:config] Remote config fetch failed, using defaults");
    }
  } catch (err) {
    console.log("[CM:config] Remote config fetch failed, using defaults:", err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[ContextMover] Extension installed.");
  // Belt-and-braces: also trigger on install/update so a fresh-install path
  // during the legacy database upgrade to ContextMover is always covered.
  await migrateFromContextForge().catch(() => { /* non-fatal */ });

  // Warm remote selector config on install — content scripts will refresh
  // naturally via the 1-hour TTL after that.
  void refreshRemoteConfig();

  const existing = await chrome.storage.local.get(["sessions"]);
  if (!existing.sessions) await chrome.storage.local.set({ sessions: [] });

  // Disable Chrome's built-in click-to-open side panel — our toggle button handles it.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
    .catch((e) => console.warn("[CM:sw] setPanelBehavior failed:", e));

  // MV3 does NOT auto-inject content scripts into already-open tabs after a
  // reload. Re-inject only into tabs that DON'T already have a live listener.
  //
  // CRITICAL — why the old per-cs-entry loop caused 4 injections per tab:
  //   The manifest has 4 entries that match claude.ai (fetch-interceptor,
  //   interceptor-bridge, claude, toggle). The old loop PINGed the same tab
  //   once per entry, all before any freshly-injected script had time to
  //   register its onMessage listener. Every PING therefore returned "no
  //   listener" → 4 independent injections → duplicate MutationObservers,
  //   duplicate capture listeners, and a double-wrapped window.fetch chain.
  //
  // Fix: collect every content_script entry that matches each open tab,
  // PING each unique tab EXACTLY ONCE, then inject ALL matching scripts for
  // that tab in a single sequential pass under the same alive/dedup guards.
  const manifest = chrome.runtime.getManifest();

  // Build a map: tabId → { tab, scripts: string[][] }
  // where scripts is an ordered list of cs.js arrays to inject.
  const tabScriptMap = new Map<number, { tab: chrome.tabs.Tab; scripts: string[][] }>();
  for (const cs of manifest.content_scripts ?? []) {
    const tabs = await chrome.tabs.query({ url: cs.matches });
    for (const tab of tabs) {
      if (!tab.id) continue;
      const entry = tabScriptMap.get(tab.id);
      if (entry) {
        entry.scripts.push(cs.js as string[]);
      } else {
        tabScriptMap.set(tab.id, { tab, scripts: [cs.js as string[]] });
      }
    }
  }

  // One PING per unique tab — no more per-script-entry races.
  for (const [tabId, { tab, scripts }] of tabScriptMap) {
    // Skip tabs already handled this SW lifetime.
    if (injectedTabs.has(tabId)) {
      console.log(`[ContextMover] Tab ${tabId} already injected this session — skipping`);
      continue;
    }

    const alive = await new Promise<boolean>((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, { type: "PING" }, () => {
          resolve(!chrome.runtime.lastError);
        });
      } catch { resolve(false); }
    });

    if (alive) {
      console.log(`[ContextMover] Tab ${tabId} already has content script — skipping`);
      injectedTabs.add(tabId); // prevent future redundant checks this session
      continue;
    }

    injectedTabs.add(tabId);

    // Clear stale window flags left by the old (now-dead) extension context
    // so freshly-injected scripts can self-initialize their idempotency guards.
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        (['__contextForge_claude_loaded', '__contextForge_chatgpt_loaded',
          '__contextForge_gemini_loaded', '__contextForge_grok_loaded',
          '__contextForge_perplexity_loaded', '__contextForge_deepseek_loaded',
          '__contextForgeFetchInstalled', '__contextForgeBridgeInstalled',
          '__cm_toggle_v2'] as const).forEach((k) => {
          try { delete (window as unknown as Record<string, unknown>)[k]; } catch { /* non-configurable */ }
        });
      },
    }).catch(() => {});

    // Inject each matching script set sequentially and await completion so
    // each script's onMessage/PING listener is registered before we move on.
    const injected: string[] = [];
    for (const jsFiles of scripts) {
      const scriptKey = `${tabId}:${jsFiles.join(',')}`;
      if (injectedScripts.has(scriptKey)) continue;
      injectedScripts.add(scriptKey);
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: jsFiles });
        injected.push(jsFiles.join(','));
      } catch { /* non-scriptable tab — e.g. chrome:// URL */ }
    }
    const injectedAny = injected.length > 0;
    if (injectedAny) {
      // One summary line per tab — confirms a tab is injected exactly once.
      console.log(
        `[ContextMover] Injected content script into tab ${tabId} (${tab.url}) — ` +
        `${injected.length} script(s): ${injected.join(' | ')}`
      );
    }

    // After a successful injection, give the newly-loaded scripts a moment to
    // initialise, then trigger an immediate capture so an already-rendered
    // conversation is captured without requiring user interaction.
    if (injectedAny) {
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: "TRIGGER_CAPTURE" }, () => {
          void chrome.runtime.lastError; // swallow if script not ready yet
        });
      }, 1500);
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
    .catch(() => {});
  // Warm remote selector cache after a browser restart (TTL may have expired).
  void refreshRemoteConfig();
  // Warm Drive sync manager cache (reduces subsequent chrome.storage.local calls by 90%)
  void driveSyncManager.warmupCache();
  // Re-register the periodic refresh alarm (alarms persist across SW restarts
  // but `create` with the same name is idempotent — safe to call every startup).
  chrome.alarms.create(REMOTE_CONFIG_ALARM, { periodInMinutes: REMOTE_CONFIG_PERIOD_MIN });
  const driveValid = await driveClient.isTokenValid();
  if (driveValid) {
    void driveSyncManager.initialSync().catch(() => {});
    chrome.alarms.create("drive-sync-periodic", { periodInMinutes: 5 });
  }
  void getHardwareProfile().then((hw) => {
    chrome.storage.local.set({ hwTier: hw.tier }).catch(() => {});
  }).catch(() => {});

  // [CM-PERSIST-FIX] recover interrupted background index jobs after Chrome restart
  // Delay 5s to let offscreen doc and Drive sync initialise first
  setTimeout(() => {
    void (async () => {
      try {
        const recentSessions = await dexieDb.sessions.orderBy('updatedAt').reverse().limit(20).toArray();
        for (const session of recentSessions) {
          if (session.messages.length > 0) {
            const chunkCount = await dexieDb.chunkEmbeddings.where('sessionId').equals(session.id).count();
            if (chunkCount === 0) {
              console.log(`[CM:startup] Found un-indexed session ${session.id}, re-queuing`);
              await semanticIndex.indexSession(session).catch(() => {});
            }
          }
        }
      } catch (err) {
        console.warn('[CM:startup] un-indexed session recovery failed:', err);
      }
    })();
    void (async () => {
      try {
        const pending = await dexieDb.pendingIndex
          .orderBy('createdAt')
          .toArray()

        if (pending.length === 0) return

        console.log(`[CM:startup] recovering ${pending.length} interrupted index job(s)`)

        for (const job of pending) {
          // Give up after 3 failed attempts — session may be corrupted
          const hw = await getHardwareProfile();
          if (hw.tier === 'minimal') {
            console.log(`[CM:startup] skipping ${job.sessionId} — indexing disabled on minimal hardware`);
            await dexieDb.pendingIndex.delete(job.sessionId).catch(() => {});
            continue;
          }

          // Verify session still exists locally
          const recoverySession = await db.getSession(job.sessionId)
          if (!recoverySession) {
            await dexieDb.pendingIndex.delete(job.sessionId).catch(() => {})
            continue
          }

          // Increment retry count before attempting
          await dexieDb.pendingIndex.update(job.sessionId, {
            retryCount: job.retryCount + 1,
            lastAttemptAt: Date.now(),
          }).catch(() => {})

          // Dispatch background index — non-blocking
          // BACKGROUND_INDEX handler at line 1491 calls backgroundIndex(session)
          chrome.runtime.sendMessage({
            type: 'BACKGROUND_INDEX',
            sessionId: job.sessionId,
          }).catch(() => {
            // SW may not be listening yet — job persists for next startup
          })

          // Stagger 2s between jobs — avoid overwhelming offscreen doc on startup
          await new Promise<void>(resolve => setTimeout(resolve, 2000))
        }
      } catch (err) {
        console.warn('[CM:startup] pending index recovery failed:', err)
      }
    })()
  }, 5000)
});

// Ensure the periodic alarms exist on install/update too.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(REMOTE_CONFIG_ALARM, { periodInMinutes: REMOTE_CONFIG_PERIOD_MIN });
  chrome.alarms.create("drive-sync-periodic", { periodInMinutes: 5 });
});

// Keep chrome.storage.local in sync whenever Supabase silently refreshes the token.
supabase.auth.onAuthStateChange(async (event, session) => {
  if (session?.access_token) {
    await chrome.storage.local.set({
      accessToken: session.access_token,
      userId: session.user?.id,
    });
    console.log("[CM:auth] token refreshed, event:", event);
  }
  if (event === "SIGNED_OUT") {
    await chrome.storage.local.remove(["accessToken", "userId"]);
  }
});

// Periodic remote-config refresh — fires every 6 h while the browser is running.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REMOTE_CONFIG_ALARM) {
    void refreshRemoteConfig();
  }
  if (alarm.name === "drive-sync-periodic") {
    // SYNC-2, SYNC-3: bidirectional sync every 5 min while Drive connected.
    void driveSyncManager.syncBidirectional();
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
  if (DEBUG_DIAG) console.log(`[ContextMover ServiceWorker] Received message: ${msg.type}`);
  (async () => {
    try {
    // [SECURITY] Reject messages from any source that is not our own extension.
    if (!isFromOwnExtension(sender)) {
      console.warn('[CM:sw] Rejected message from unknown sender:', sender.id, msg.type);
      sendResponse({ error: 'Unauthorized sender' });
      return;
    }
    switch (msg.type) {
      case "CM_DIAG": {
        if (!isFromOwnExtension(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        // Content-script diagnostic mirrored to SW console so developers can
        // see capture decisions without opening every page console.
        const platform = typeof msg.platform === 'string' ? msg.platform : '?';
        const reason = typeof msg.reason === 'string' ? msg.reason : '?';
        if (DEBUG_DIAG) console.log(`[CM:diag:${platform}] ${reason}  (tab=${sender.tab?.id ?? '?'})`);
        sendResponse({ ok: true });
        break;
      }

      case "SCRAPER_BROKEN": {
        // Sent by content scripts when a selector is missing (platform DOM changed)
        // or when the zero-message retry gate is exhausted after having prior messages.
        if (!isFromPlatformTab(sender)) { sendResponse({ ok: false }); return; }
        const brokenPlatform = typeof msg.platform === 'string' ? msg.platform : '?';
        const brokenReason   = typeof msg.reason   === 'string' ? msg.reason   : '?';
        console.warn(`[ContextMover] UI Update Detected! Scraper broken on ${brokenPlatform}: ${brokenReason}`);
        // Self-healing: immediately fetch fresh selectors so the next page load
        // picks up the hotfix. Debounced — one fetch per 30 s even if many scripts break at once.
        const now = Date.now();
        if (now - scraperBrokenRefreshAt > SCRAPER_BROKEN_REFRESH_COOLDOWN_MS) {
          scraperBrokenRefreshAt = now;
          void refreshRemoteConfig().then(() => {
            console.log(`[CM:config] Selector config refreshed after SCRAPER_BROKEN (${brokenPlatform})`);
          }).catch(() => {});
          void reportScraperBroken({
            platform:  brokenPlatform,
            reason:    brokenReason,
            href:      typeof msg.href === 'string' ? msg.href : '',
            timestamp: now,
          });
        }
        void broadcastToViews(msg);
        sendResponse({ ok: true });
        break;
      }

      // ── DOM Probe for self-healing selector discovery ──────────────────
      case "RUN_DOM_PROBE": {
        if (!isFromExtensionUI(sender)) { sendResponse({ ok: false }); return; }
        const tabId = typeof msg.tabId === 'number' ? msg.tabId : null;
        if (!tabId) { sendResponse({ ok: false, error: "No tabId provided" }); return; }
        try {
          const response = await new Promise<{ ok: boolean; probeResult?: any; error?: string }>((resolve) => {
            chrome.tabs.sendMessage(
              tabId,
              { type: "RUN_DOM_PROBE" },
              (result) => {
                if (chrome.runtime.lastError) {
                  console.warn(`[CM:sw] DOM probe failed on tab ${tabId}:`, chrome.runtime.lastError.message);
                  resolve({ ok: false, error: chrome.runtime.lastError.message });
                } else {
                  resolve(result ?? { ok: false, error: "no response from content script" });
                }
              }
            );
          });
          sendResponse(response);
        } catch (err) {
          console.error("[CM:sw] DOM probe error:", err);
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      // ── Google Drive sync (additive layer over IndexedDB) ──────────────
      case "DRIVE_CONNECT": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        try {
          const connected = await driveClient.connect();
          if (connected) {
            // Pull existing Drive sessions in background; never block UI.
            void driveSyncManager.initialSync();
            // Start periodic bidirectional sync (every 5 min).
            // SYNC-2: ensures cross-extension changes propagate within 5 min.
            chrome.alarms.create("drive-sync-periodic", { periodInMinutes: 5 });
          }
          sendResponse({ connected });
        } catch (err) {
          console.error("[CM:drive] connect error:", err);
          sendResponse({ connected: false, error: String(err) });
        }
        break;
      }
      case "DRIVE_DISCONNECT": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        await driveClient.disconnect();
        // Stop periodic sync — no point syncing when disconnected.
        chrome.alarms.clear("drive-sync-periodic");
        sendResponse({ ok: true });
        break;
      }
      case "DRIVE_STATUS": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const status = await driveSyncManager.getStatus();
        sendResponse(status);
        break;
      }
      case "DRIVE_SYNC_NOW": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const result = await driveSyncManager.pullFromDrive();
        sendResponse({ ok: true, ...result });
        break;
      }
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
        // CRITICAL: Return true to keep message channel open for async handleCaptureSession()
        // Without this, Chrome closes the channel immediately and "No SW" errors occur
        (async () => {
          try {
            await handleCaptureSession(msg.payload);
            sendResponse({ ok: true });
          } catch (err) {
            console.error('[CM:sw] CAPTURE_SESSION error:', err);
            sendResponse({ error: err instanceof Error ? err.message : String(err) });
          }
          // Notify sidebar toggle icon in this tab — fire-and-forget.
          if (sender.tab?.id) {
            void chrome.tabs.sendMessage(sender.tab.id, { type: "CAPTURE_STATUS_UPDATE", status: "idle" }).catch(() => {});
          }
        })();
        // Notify sidebar toggle icon in this tab — fire-and-forget.
        if (sender.tab?.id) {
          void chrome.tabs.sendMessage(sender.tab.id, { type: "CAPTURE_STATUS_UPDATE", status: "capturing" }).catch(() => {});
        }
        return true;
      }

      case "PRECOMPUTE_SUMMARY": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const session = await db.getSession(msg.payload?.sessionId);
        if (!session) { sendResponse(null); break; }
        try {
          await summarize(session.messages, { skipHardLimit: true });
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
        if (!isFromOwnExtension(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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
        if (!isFromOwnExtension(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        sendResponse({ available: attentionEngineAvailable });
        break;
      }

      case "SYNC_FILES_TO_MCP": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        // Force-invalidate the in-memory cache on explicit user refresh.
        if ((msg as { force?: boolean }).force) {
          getSessionsCache = null;
          sessionCache.invalidate();
        }
        const now = Date.now();
        if (getSessionsCache !== null && now - getSessionsCacheAt < GET_SESSIONS_CACHE_MS) {
          sendResponse(getSessionsCache);
        } else {
          // Defensive: heal a wedged DB on first request after a schema-impossible
          // upgrade (e.g. metaPrompts primary-key change). Cheap when DB is open.
          await ensureDbReady();
          const sessions = await db.getAllSessions();
          // Cap message content at 2000 chars per message in the list response.
          // Sending 858K of raw content through sendMessage blocks the popup main
          // thread. Full content is fetched on-demand via GET_SESSION when the user
          // opens a session detail view or initiates migration.
          const MSG_PREVIEW_CAP = 2_000;
          const listItems = sessions.map(s => ({
            ...s,
            messageCount: s.messages.length,
            messages: s.messages.map(m =>
              m.content.length > MSG_PREVIEW_CAP
                ? { ...m, content: m.content.slice(0, MSG_PREVIEW_CAP), _truncated: true }
                : m
            ),
          }));
          getSessionsCache = listItems;
          getSessionsCacheAt = now;
          sendResponse(listItems);
        }
        // Fire-and-forget Drive pull — throttled to once per 60s so that
        // rapid GET_SESSIONS polls never reset the upload debounce timer.
        if (Date.now() - lastDrivePullFromListAt > DRIVE_PULL_FROM_LIST_COOLDOWN_MS) {
          lastDrivePullFromListAt = Date.now();
          void driveSyncManager.initialSync().catch(() => {});
        }
        break;
      }

      case "GET_SESSION":
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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
        // SYNC-4: also delete from Drive so other profiles see the deletion.
        void driveSyncManager.deleteFromDrive(msg.sessionId);
        void broadcastForgetToTabs(msg.sessionId);
        void broadcastToViews({ type: "SESSIONS_UPDATED" });
        sendResponse({ ok: true });
        break;

      case "RENAME_SESSION":
        if (!isFromExtensionUI(sender)) {
          sendResponse({ error: "Unauthorized" });
          break;
        }
        const { sessionId: renameId, title: newTitle } = msg as {
          sessionId: string;
          title: string;
        };
        if (!renameId || !newTitle?.trim()) {
          sendResponse({ error: "sessionId and title required" });
          break;
        }
        const session = await db.getSession(renameId);
        if (!session) {
          sendResponse({ error: "Session not found" });
          break;
        }
        const updatedSession = session;
        updatedSession.customName = newTitle.trim();
        updatedSession.updatedAt = Date.now();
        await db.saveSession(updatedSession);
        // Sync rename to Drive + vault
        void driveSyncManager.syncAfterCapture(renameId).catch(() => {});
        void (async () => {
          try {
            const vaultClient = await userVault.getClient();
            if (!vaultClient) return;
            await vaultClient
              .from("cm_sessions")
              .update({ title: updatedSession.customName, updated_at: new Date().toISOString() })
              .eq("id", renameId);
          } catch { /* vault failure never blocks */ }
        })();
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

        // ── Migration tier decision gate ─────────────────────────────────
        // If the caller did NOT pre-select a tier (tier === undefined / null),
        // pause and ask the sidebar which tier to use.  The sidebar shows
        // MigrationTierModal; auto-defaults to Tier 1 after 60 s.
        let _tier: 1 | 2 | 3 = (msg.payload?.tier ?? 0) as 1 | 2 | 3;
        if (_tier !== 1 && _tier !== 2 && _tier !== 3) {
          const _pendingId = crypto.randomUUID();
          const _modalSession = msg.payload?.sessionId
            ? await db.getSession(msg.payload.sessionId).catch(() => null)
            : null;
          _tier = await new Promise<1 | 2 | 3>((resolve) => {
            pendingMigrations.set(_pendingId, { resolve });
            setTimeout(() => {
              if (pendingMigrations.has(_pendingId)) {
                pendingMigrations.delete(_pendingId);
                resolve(1); // default: Full Context
              }
            }, 60_000);
            void broadcastToViews({
              type: "MIGRATION_TIER_REQUIRED",
              pendingId: _pendingId,
              sessionId: msg.payload?.sessionId ?? "",
              sessionTitle:
                _modalSession?.customName ??
                _modalSession?.title ??
                "Untitled",
              targetPlatform: msg.payload?.targetPlatform ?? "",
            });
          });
        }

        // ── Freemium gate ────────────────────────────────────────────────────
        // Always try to get fresh session first
        let accessToken: string | undefined;
        try {
          const { data: { session } } = await supabase.auth.getSession();
          console.log("[CM:debug] getSession result:", { hasSession: !!session, hasToken: !!session?.access_token, tokenLen: session?.access_token?.length ?? 0 });
          if (session?.access_token) {
            accessToken = session.access_token;
            // Keep storage in sync
            await chrome.storage.local.set({
              accessToken: session.access_token,
              userId: session.user?.id,
            });
          } else {
            // Fallback to stored token
            const stored = await chrome.storage.local.get("accessToken");
            accessToken = stored.accessToken as string | undefined;
            console.log("[CM:debug] fallback to storage, token:", typeof accessToken, "len:", accessToken?.length ?? 0);
          }
        } catch (e) {
          console.log("[CM:debug] getSession threw:", e);
          const stored = await chrome.storage.local.get("accessToken");
          accessToken = stored.accessToken as string | undefined;
        }

        console.log("[CM:debug] final accessToken:", typeof accessToken, "truthy:", !!accessToken, "len:", accessToken?.length ?? 0);
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

        // ── Priority Tier 3 indexing ─────────────────────────────────────
        // Fire-and-forget: kick off high-priority semantic indexing so the
        // embedding pipeline is ready (or refreshed) by the time the migration
        // prompt is injected. Runs in parallel with handleMigrateContext.
        // Does NOT block or affect Tier 1 / Tier 2 logic.
        if (msg.payload?.sessionId) {
          void (async () => {
            try {
              await ensureOffscreenDocumentLocal();
              const t3Session = await db.getSession(msg.payload.sessionId).catch(() => null);
              if (t3Session) {
                const hwStored = await chrome.storage.local.get("hwTier").catch(() => ({}));
                const hwTier = (hwStored as Record<string, string>).hwTier ?? "standard";
                const t3RequestId = `migrate-priority-${t3Session.id}-${Date.now()}`;
                chrome.runtime.sendMessage({
                  type: "OFFSCREEN_INDEX_SESSION",
                  session:   t3Session,
                  hardware:  { tier: hwTier },
                  requestId: t3RequestId,
                  priority:  true,
                }).catch(() => {});
                console.log(`[CM:sw] MIGRATE_CONTEXT — priority T3 index queued (${t3RequestId})`);
              }
            } catch (e) {
              console.warn("[CM:sw] MIGRATE_CONTEXT priority index error:", e);
            }
          })();
        }

        try {
          await handleMigrateContext(
            { ...msg.payload, tier: _tier },
            sendResponse,
            accessToken as string | undefined
          );
        } finally {
          activeMigrationInProgress = false;
        }
        break;
      }

      case "MIGRATION_TIER_CONFIRMED": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const _confirmedPendingId = typeof msg.pendingId === "string" ? msg.pendingId : "";
        const _confirmedTier = (msg.tier as 1 | 2 | 3 | undefined);
        if (!_confirmedPendingId || _confirmedTier !== 1 && _confirmedTier !== 2 && _confirmedTier !== 3) {
          sendResponse({ error: "pendingId and tier (1|2|3) required" });
          break;
        }
        const _pending = pendingMigrations.get(_confirmedPendingId);
        if (_pending) {
          pendingMigrations.delete(_confirmedPendingId);
          _pending.resolve(_confirmedTier);
        }
        sendResponse({ ok: true });
        break;
      }

      case "AUTH_GET_USER": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const { data } = await supabase.auth.getUser();
        sendResponse({ user: data.user ?? null });
        break;
      }

      case "GET_SUBSCRIPTION_STATUS": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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

      case "AUTH_GOOGLE_SIGN_IN": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const payload = msg.payload as { code?: string; idToken?: string; accessToken?: string; refreshToken?: string };
        try {
          // ── Primary path: PKCE authorization-code exchange ──────────────────
          // The sidebar calls supabase.auth.signInWithOAuth (which stores the
          // PKCE code_verifier in chrome.storage.local), then uses
          // launchWebAuthFlow to get the authorization code, then sends it here.
          // exchangeCodeForSession reads the stored verifier and exchanges the
          // code with Supabase — no custom backend endpoint required.
          if (payload.code) {
            const { data: sd, error: exchErr } = await supabase.auth.exchangeCodeForSession(payload.code);
            if (exchErr || !sd?.session) {
              console.error("[CM:auth] exchangeCodeForSession failed:", exchErr);
              sendResponse({ error: exchErr?.message ?? "Failed to create session" });
              break;
            }
            await chrome.storage.local.set({
              accessToken: sd.session.access_token,
              userId: sd.user?.id,
            });
            sendResponse({ user: sd.user ? { id: sd.user.id, email: sd.user.email } : null });
            void broadcastToViews({ type: "AUTH_STATE_CHANGED" });
            break;
          }

          // ── Implicit flow path: tokens from URL hash (Supabase implicit mode) ─
          // When Supabase project flow type is "Implicit", the redirect URL
          // contains #access_token=...&refresh_token=... instead of ?code=.
          if (payload.accessToken) {
            const { data: sd, error: sessErr } = await supabase.auth.setSession({
              access_token: payload.accessToken,
              refresh_token: payload.refreshToken ?? "",
            });
            if (sessErr || !sd?.session) {
              console.error("[CM:auth] setSession (implicit) failed:", sessErr);
              sendResponse({ error: sessErr?.message ?? "Failed to create session" });
              break;
            }
            await chrome.storage.local.set({
              accessToken: sd.session.access_token,
              userId: sd.user?.id,
            });
            sendResponse({ user: sd.user ? { id: sd.user.id, email: sd.user.email } : null });
            void broadcastToViews({ type: "AUTH_STATE_CHANGED" });
            break;
          }

          // ── Legacy path: id_token via custom backend (backward compat) ───────
          // Kept for clients that still send idToken. Will be removed once the
          // PKCE path is confirmed stable across all environments.
          if (payload.idToken) {
            const res = await fetch(`${WEBAPP_URL}/api/auth/extension-google-signin`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ idToken: payload.idToken }),
              signal: AbortSignal.timeout(10_000),
            });
            const data = (await res.json()) as {
              error?: string;
              message?: string;
              signupUrl?: string;
              access_token?: string;
              refresh_token?: string;
              user?: { id: string; email?: string };
            };
            if (!res.ok || data.error) {
              sendResponse({ error: data.error ?? "signin_failed", message: data.message, signupUrl: data.signupUrl });
              break;
            }
            if (data.access_token && data.refresh_token) {
              await supabase.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
            }
            if (data.access_token) {
              await chrome.storage.local.set({ accessToken: data.access_token, userId: data.user?.id });
            }
            sendResponse({ user: data.user ?? null });
            void broadcastToViews({ type: "AUTH_STATE_CHANGED" });
            break;
          }

          sendResponse({ error: "Missing code or idToken in payload" });
        } catch (err) {
          console.error("[CM:auth] AUTH_GOOGLE_SIGN_IN error:", err);
          sendResponse({ error: err instanceof Error ? err.message : "Google sign-in failed" });
        }
        break;
      }

      case "AUTH_SIGN_IN": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        await supabase.auth.signOut();
        await chrome.storage.local.remove(["accessToken", "userId"]);
        sendResponse({ ok: true });
        void broadcastToViews({ type: "AUTH_STATE_CHANGED" });
        break;
      }

      case "CLOUD_RESYNC_ALL": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const cfg = await userVault.getConfig();
        sendResponse({ config: cfg });
        break;
      }

      case "TOGGLE_SIDEBAR": {
        if (!isFromOwnExtension(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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
            lastSidebarTabId = tabId; // remember for SIDEBAR_CLOSED relay
            sendResponse({ isOpen: true });
          } catch (err) {
            sendResponse({ isOpen: false, error: String(err) });
          }
        }
        break;
      }

      case "CLOSE_SIDEBAR": {
        if (!isFromOwnExtension(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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

      case "INJECT_FILE_TO_TAB": {
        if (!isFromExtensionUI(sender)) { sendResponse({ ok: false, error: "Unauthorized" }); return; }
        const { tabId: injectTabId, fileName, fileContent: fileContentPayload } = msg as {
          tabId: number; fileName: string; fileContent: string;
        };
        if (!injectTabId) { sendResponse({ ok: false, error: "no tabId" }); return; }
        // ── Gemini: bypass file-upload path; inject as text directly ──────────
        // Gemini's Angular file input silently rejects uploads even when found.
        // Text injection via injectPromptInPage (Gemini-specific path) is the
        // only reliable path.
        const injectTab = await chrome.tabs.get(injectTabId).catch(() => null);
        if (injectTab?.url?.includes("gemini.google.com")) {
          try {
            const [execRes] = await chrome.scripting.executeScript({
              target: { tabId: injectTabId },
              func: injectIntoGeminiPage,
              args: [fileContentPayload],
            });
            const result = execRes?.result as { ok: boolean; selector?: string; length?: number; reason?: string } | undefined;
            console.log('[CM:gemini] injection result:', result);
            if (!result?.ok) {
              console.warn('[CM:gemini] injection failed — reason:', result?.reason ?? 'unknown');
            }
            sendResponse(result ?? { ok: false, error: "no result from executeScript" });
          } catch (err) {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
          break;
        }
        // Wait up to 3 × 500 ms for the content script to be ready.
        // For Tier-1 migrations the SW never pings the target tab beforehand,
        // so the content script may not have initialised yet when the user
        // clicks "Inject to chat" in the modal.
        let fileScriptReady = false;
        for (let _pi = 0; _pi < 3; _pi++) {
          if (_pi > 0) await new Promise<void>((r) => setTimeout(r, 500));
          const alive = await new Promise<boolean>((resolve) => {
            try {
              chrome.tabs.sendMessage(injectTabId, { type: "PING" }, (resp) => {
                resolve(!chrome.runtime.lastError && !!resp);
              });
            } catch { resolve(false); }
          });
          if (alive) { fileScriptReady = true; break; }
        }
        if (!fileScriptReady) {
          console.warn(`[CM:sw] INJECT_FILE_TO_TAB: content script not ready on tab ${injectTabId} after 3 pings`);
          sendResponse({ ok: false, error: "Content script not ready — reload the target tab and try again" });
          break;
        }
        const fileInjectResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
          chrome.tabs.sendMessage(
            injectTabId,
            { type: "INJECT_FILE_AS_UPLOAD", fileName, fileContent: fileContentPayload },
            (response) => {
              void chrome.runtime.lastError;
              resolve(response ?? { ok: false, error: "no response from content script" });
            }
          );
        });
        sendResponse(fileInjectResult);
        break;
      }

      case "SIDEBAR_CLOSED": {
        if (!isFromOwnExtension(sender)) { sendResponse({}); return; }
        // The sidebar panel sends this via chrome.runtime.sendMessage which
        // reaches the SW but NOT content scripts. Relay it to the toggle
        // content script on the associated tab so its icon reflects closed state.
        //
        // CRITICAL FIX: Chrome side panels send messages with sender.tab === undefined
        // because the panel is not "inside" a tab. The old guard (sender.tab?.id != null)
        // therefore NEVER relayed the message when the user closed the panel via
        // Chrome's X button, leaving the toggle button permanently stuck in open state.
        // Fix: fall back to lastSidebarTabId which was recorded when the panel opened.
        const relayTabId = sender.tab?.id ?? lastSidebarTabId;
        if (relayTabId != null) {
          chrome.tabs.sendMessage(
            relayTabId,
            { type: "SIDEBAR_CLOSED" },
            () => { void chrome.runtime.lastError; }
          );
          lastSidebarTabId = null; // clear after relay
        }
        sendResponse({});
        break;
      }

      case "OFFSCREEN_INDEX_DONE": {
        // [CM-PERSIST-FIX] indexing complete — remove from persistent queue
        // This fires when offscreen.ts successfully finishes embedding a session
        const { sessionId: doneSessionId, chunkCount: doneChunkCount } =
          msg as { sessionId?: string; chunkCount?: number }
        if (doneSessionId) {
          await dexieDb.pendingIndex.delete(doneSessionId).catch(() => {})
          console.log(
            `[CM:persist] ${doneSessionId} completed — ` +
            `${doneChunkCount ?? '?'} chunks embedded, removed from pendingIndex` 
          )
        }
        sendResponse({ ok: true })
        break
      }

      case "BACKGROUND_INDEX": {
        if (!isFromOwnExtension(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const { sessionId: bgSessionId } = msg as { sessionId?: string };
        if (!bgSessionId) { sendResponse({ error: 'sessionId required' }); break; }
        const bgSession = await db.getSession(bgSessionId);
        if (!bgSession) { sendResponse({ error: 'Session not found' }); break; }
        void backgroundIndex(bgSession);
        sendResponse({ ok: true });
        break;
      }

      case "WARMUP_MODEL": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        if (!attentionEngineAvailable) {
          sendResponse({ ok: false, unavailable: true });
          break;
        }
        // [CM-PERF] idempotency guard — model already loaded, skip re-init
        if (modelWarmed) { sendResponse({ ok: true, warmedUp: true, skipped: true }); break; }
        const warmupHw = await getHardwareProfile().catch(() => null);
        if (warmupHw?.tier === 'minimal') {
          sendResponse({ ok: true, skipped: true, reason: 'minimal_hardware' });
          break;
        }
        void (async () => {
          try {
            await semanticIndex.warmup();
            modelWarmed = true; // [CM-PERF] mark loaded so next sidebar open skips re-init
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
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        try {
          const stats = await semanticIndex.getStats();
          sendResponse({ ok: true, stats });
        } catch (e) {
          sendResponse({ error: String(e) });
        }
        break;
      }

      case "CLEAR_SEMANTIC_INDEX": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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
        if (!isFromOwnExtension(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const entry = migrationFileCache.get(msg.cacheKey)
        if (!entry) {
          sendResponse({ success: false, error: 'File not in cache or expired' })
          break
        }
        sendResponse({ success: true, file: entry })
        break
      }

      case "DELETE_CACHED_FILE": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        migrationFileCache.delete(msg.cacheKey)
        console.debug(`[CM:cache] Deleted on user action: ${msg.cacheKey}`)
        sendResponse({ success: true })
        break
      }

      case "GET_SIDEBAR_STATE": {
        if (!isFromOwnExtension(sender)) { sendResponse({ error: "Unauthorized" }); return; }
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

      case "USAGE_WARNING": {
        const remaining = typeof msg.remaining === "number" ? msg.remaining : 0;
        try {
          const text  = remaining === 0 ? "0" : remaining.toString();
          const color = remaining === 0 ? "#FF0000" : "#FF8800";
          await chrome.action.setBadgeText({ text });
          await chrome.action.setBadgeBackgroundColor({ color });
        } catch (e) {
          console.warn("[CM:sw] setBadge failed:", e);
        }
        sendResponse({ ok: true });
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
  source?: string;
}) {
  // In-flight deduplication: skip if the same session is already being processed.
  // Prevents double DB writes when content script + syncOpenTabs fire simultaneously.
  if (captureInFlight.has(payload.sessionId)) {
    console.log(`[ContextMover:capture] Skipped in-flight duplicate for session ${payload.sessionId}`);
    return;
  }
  captureInFlight.add(payload.sessionId);
  // Release lock after the full staggered-capture window (0 / 100 / 500 / 1000 / 1500 ms
  // + extraCaptureDelays up to 4 s) + a 1 s buffer so every burst from a single
  // MutationObserver fire is absorbed by this single in-flight slot.
  setTimeout(() => captureInFlight.delete(payload.sessionId), 5_000);

  // ── [CM:sw] received ────────────────────────────────────────────────────────
  const rxUser = payload.messages.filter(m => m.role === "user").length;
  const rxAsst = payload.messages.filter(m => m.role === "assistant").length;
  if (DEBUG) console.log('[CM:sw] received', { platform: payload.platform, session: payload.sessionId, total: payload.messages.length, user: rxUser, assistant: rxAsst });
  if (rxAsst === 0 && rxUser > 0) {
    console.error('[CM:sw] received — ASSISTANT MESSAGES MISSING in payload (Stage1 content script bug)');
  }

  const existing = await db.getSession(payload.sessionId);
  // CRITICAL: also consult pendingWrites — a 200ms debounce window means an
  // authoritative network capture may be queued but not yet committed to IDB
  // when a late DOM scrape arrives. Without this check, the DOM scrape would
  // silently clobber the queued 26-msg capture with a 10-msg snapshot.
  const pending = pendingWrites.get(payload.sessionId);
  const bestKnown =
    pending && existing
      ? (pending.messages.length >= existing.messages.length ? pending : existing)
      : (pending ?? existing);

  // Protect the most complete capture for this session.
  // DOM scrapes shrink when virtual scroll evicts old messages from the DOM.
  // Network captures (source: 'fetch-intercept') carry authoritative full
  // history from the API and are always allowed to overwrite.
  const isNetworkCapture = payload.source === 'fetch-intercept';
  if (bestKnown && payload.messages.length < bestKnown.messages.length && !isNetworkCapture) {
    console.log(
      `[CM:sw] CAPTURE_SESSION: incoming count (${payload.messages.length}) < best known (${bestKnown.messages.length}, pending=${!!pending}) from DOM scrape — keeping existing`
    );
    return;
  }

  const createdAt = existing?.createdAt ?? Date.now();
  const updatedAt =
    payload.messages[payload.messages.length - 1]?.timestamp ?? Date.now();

  // Propagate `authoritative` flag: once a network/fetch-intercept capture has
  // saved this session, mark it so the sidebar's "scroll to top" warning knows
  // the capture is complete even when message count is small.
  const wasAuthoritative = existing?.metadata?.authoritative === true;
  const nextMeta: import("@/lib/types").RequestMetadata | undefined =
    (payload.metadata || wasAuthoritative || isNetworkCapture)
      ? {
          ...(payload.metadata ?? {}),
          ...(wasAuthoritative || isNetworkCapture ? { authoritative: true } : {}),
        }
      : undefined;

  const session: ContextSession = {
    id: payload.sessionId,
    platform: payload.platform as ContextSession["platform"],
    createdAt,
    updatedAt,
    title: payload.title,
    messages: payload.messages,
    metadata: nextMeta,
  };

  console.log(`[CM:sw] CAPTURE_SESSION queued: sessionId=${session.id} platform=${session.platform} messages=${session.messages.length} title="${session.title}"`);

  // Debounced IDB write — coalesces rapid-fire captures for the same session.
  // Only 1 write fires per 200ms window; SESSIONS_UPDATED broadcasts after flush.
  pendingWrites.set(session.id, session);
  const existingTimer = writeTimers.get(session.id);
  if (existingTimer !== undefined) clearTimeout(existingTimer);
  writeTimers.set(session.id, setTimeout(async () => {
    const toWrite = pendingWrites.get(session.id);
    if (!toWrite) return;
    await db.saveSession(toWrite);

    // [CM-PERSIST-FIX] enqueue for background indexing — survives Chrome close
    // put() is idempotent — safe to call on every session update
    await dexieDb.pendingIndex.put({
      sessionId: toWrite.id,
      createdAt: Date.now(),
      priority: 'background' as const,
      retryCount: 0,
    }).catch((e: unknown) => {
      console.warn('[CM:persist] failed to write pendingIndex:', e)
    })
    pendingWrites.delete(session.id);
    writeTimers.delete(session.id);
    sessionCache.invalidate(); // force fresh IDB read on next GET_SESSIONS
    console.log('[CM:sw] SAVED to IndexedDB', { sessionId: toWrite.id, platform: toWrite.platform, messages: toWrite.messages.length, title: toWrite.title });
    void broadcastToViews({ type: "SESSIONS_UPDATED" });
    // Kick off background semantic indexing — fire & forget, never blocks capture
    if (semanticIndex.getQueueLength() >= 40) {
      console.warn(`[CM:sw] backpressure: deferring index for ${toWrite.id} by 60s`);
      setTimeout(() => backgroundIndex(toWrite).catch(() => {}), 60000);
    } else {
      void backgroundIndex(toWrite).catch(() => {});
    }
    // Queue Drive upload (debounced ~30s). Fire-and-forget; silent no-op when
    // the user has not connected Google Drive. Independent of Supabase vault.
    void driveSyncManager.syncAfterCapture(toWrite.id).catch(() => {});
    // MCP bridge sync disabled — IDE bridge deferred to Phase 2.
    // void syncToMcpBridge(toWrite).catch(() => {});
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
  if (activeMigrationInProgress) return;
  try {
    // Skip embedding-based indexing on minimal-tier hardware (no WebGPU,
    // ≤4 cores). Embedding hundreds of chunks at ~400ms/chunk on weak CPUs
    // monopolizes the offscreen doc and freezes the sidebar / semantic search
    // for minutes after large captures or Drive sync. Retrieval falls back to
    // keyword search, which is acceptable for these users.
    const hw = await getHardwareProfile().catch(() => null);
    if (hw?.tier === "minimal") {
      return;
    }
    const t0 = performance.now();
    await semanticIndex.indexSession(session);
    const dt = (performance.now() - t0).toFixed(0);
    console.log(`[CM:sw:bgIdx] indexed session ${session.id} in ${dt}ms`);

    // MCP embeddings sync disabled — IDE bridge deferred to Phase 2.
    // void syncEmbeddingsToMcpBridge(session.id);
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
// Sessions above this total-chars threshold are too large for background
// pre-building — doing so saturates the SW for 1s+ and starves message handling.
// Migration prompts for these sessions are computed on-demand instead.
const METAPROMPT_MAX_CHARS = 300_000;

async function buildMetaPromptAsync(session: ContextSession): Promise<void> {
  const totalChars = session.messages.reduce((s, m) => s + m.content.length, 0);
  if (totalChars > METAPROMPT_MAX_CHARS) {
    console.log(`[CM:sw:metaPrompt] skipped (${totalChars} chars > ${METAPROMPT_MAX_CHARS} limit): ${session.id}`);
    return;
  }

  // Skip re-summarisation when message content is identical to the last build,
  // or when the last build ran less than METAPROMPT_COOLDOWN_MS ago.
  const contentSig = `${session.messages.length}:${totalChars}:` +
    (session.messages[session.messages.length - 1]?.content ?? '').slice(0, 200);
  const prevSig = metaPromptLastHash.get(session.id);
  const prevBuiltAt = metaPromptLastBuiltAt.get(session.id) ?? 0;
  const nowMs = Date.now();
  if (prevSig === contentSig && (nowMs - prevBuiltAt) < METAPROMPT_COOLDOWN_MS) {
    console.log(`[CM:sw:metaPrompt] skipped (unchanged, ${Math.round((nowMs - prevBuiltAt) / 1000)}s since last): ${session.id}`);
    return;
  }
  metaPromptLastHash.set(session.id, contentSig);
  metaPromptLastBuiltAt.set(session.id, nowMs);

  const t0 = performance.now();

  // Quick tier-1 summary (fast, < 100ms)
  // skipHardLimit: file-based migration uploads the XML directly — no paste limit.
  const summaryResult = await summarize(session.messages, { skipHardLimit: true }).catch(() => null);
  if (!summaryResult) return;

  const tier1Meta = summaryResult.extracted;
  const tier1Compression = summaryResult.originalTokenEstimate > 0
    ? Math.round((1 - summaryResult.summaryTokenEstimate / summaryResult.originalTokenEstimate) * 100)
    : 0;

  // Tier 2 produces ~440 chars of fixed XML scaffolding regardless of session size.
  // For sessions with fewer than 10 messages OR under 500 total chars the output
  // is larger than the input → negative compression. Skip Tier 2 pre-build for
  // these cases; on-demand build at migration time will handle them.
  const TIER2_MIN_MESSAGES = 10;
  const TIER2_MIN_CHARS = 500;
  const buildTier2 = session.messages.length >= TIER2_MIN_MESSAGES || totalChars >= TIER2_MIN_CHARS;

  // Build tier-2 intelligent summary
  const tier2Result = buildTier2 ? summarizeIntelligent(session.messages) : null;
  const tier2Compression = tier2Result?.compressionRatio ?? 0;

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

      // Tier 2 MetaPrompt — only for sessions large enough to benefit from compression.
      if (tier2Result) {
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
      }
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
    skipAutoInject?: boolean;
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
  activeMigrationInProgress = true;
  reportProgress(10, 'Loading session...')
  const tier = (payload.tier ?? 2) as 1 | 2 | 3
  void reportExtensionEvent({ event: 'migration_start', platform: session.platform, tier, sessionMessageCount: session.messages.length, timestamp: Date.now() });
  let migrationFile: MigrationFile
  let coverageStats: IntelligentSummary['coverageStats']
  reportProgress(20, 'Building context file...')
  try {
    if (tier === 1) {
      const localFile = buildTier1File(session)
      migrationFile = accessToken
        ? await fetchMigrationBuild(
            { tier: 1, platform: session.platform, sessionTitle: session.title, messages: session.messages },
            accessToken, localFile
          )
        : localFile
    } else if (tier === 2) {
      reportProgress(30, 'Extracting smart summary...')
      const stored = await semanticIndex.getSummary(
        session.id, 2, payload.task ?? null, session.messages.length
      )
      let summary: IntelligentSummary
      if (stored) {
        summary = JSON.parse(stored.content)
      } else {
        let scoredMessages: ScoredMessage[] = []
        try {
          // [CM-T2-ENHANCE] transformer-scored extraction — same quality for all users
          scoredMessages = await attentionEngine.scoreMessagesForSummarization(session)
          console.log(`[CM:tier2] scored ${scoredMessages.length} messages for extraction`)
        } catch (err) {
          console.warn('[CM:tier2] scoring failed, using heuristic fallback:', err)
        }

        // [CM-T2-LOCAL] removed server call — Tier 2 is local-only for all users
        summary = await buildTier2WithScoring(session, scoredMessages, payload.task)

        await semanticIndex.saveSummary(
          session.id, 2, payload.task ?? null,
          JSON.stringify(summary), summary.compressionRatio,
          session.messages.length
        )
      }
      coverageStats = summary.coverageStats
      const localFile = buildTier2File(session, summary, payload.task)
      migrationFile = localFile
    } else {
      if (!attentionEngineAvailable) {
        activeMigrationInProgress = false;
        sendResponse({ success: false, error: 'Attention Engine unavailable — model could not load on this device' });
        return;
      }
      reportProgress(30, 'Running attention engine...')
      // [CM-TIER-FIX] removed auto-downgrade — user controls tier, not hardware detector
      // If Tier 3 was requested, run it. Let it be slow. That is the user's choice.
      // Do NOT change tier here under any circumstance.
      const TIER3_TIMEOUT_MS = 120_000; // 2 minute timeout for Tier 3 operations
      let tid: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        tid = setTimeout(() => reject(new Error('tier3_timeout')), TIER3_TIMEOUT_MS);
      });
      try {
        // [CM-RACE-FIX] pre-warm model before Tier 3 indexing so embed requests don't race
        if (!modelWarmed) {
          reportProgress(28, 'Warming up model...')
          try {
            await Promise.race([
              semanticIndex.warmup(),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('warmup_timeout')), 45_000))
            ]);
            modelWarmed = true;
          } catch (e) {
            console.warn('[CM:sw] Model warmup failed:', e);
          }
        }
        const needsIndex = await Promise.race([
          semanticIndex.needsIndexing(session),
          timeout
        ]);
        if (needsIndex) {
          reportProgress(35, 'Indexing session...')
          await Promise.race([
            semanticIndex.indexSessionPriority(session, (pct: number, stage: string) => {
              reportProgress(35 + pct * 0.4, stage)
            }),
            timeout
          ]);
        }
        reportProgress(75, 'Retrieving relevant chunks...')
        const { chunks, usedKeywordFallback } = await Promise.race([
          semanticIndex.retrieve(session.id, payload.task ?? null, 15),
          timeout
        ]);
        // [CM-T3-FIX] reject keyword-fallback results for Tier 3 — fail loudly
        if (usedKeywordFallback) {
          console.warn('[CM:sw] Tier 3 retrieve used keyword fallback — rejecting');
          activeMigrationInProgress = false;
          sendResponse({ success: false, error: 'tier3_embed_timeout', requestedTier: 3, message: 'Semantic search timed out. Please try again.' });
          return;
        }
        if (chunks.length === 0) {
          // [CM-T3-FIX] clear phantom hash so next attempt will re-index
          await dexieDb.sessionHashes.where('sessionId').equals(session.id).delete();
          console.warn(`[CM:sw] T3 — 0 chunks for ${session.id}, phantom hash cleared. User must retry migration.`);
          // [CM-TIER-FIX] 0 chunks — return error, never auto-downgrade
          activeMigrationInProgress = false;
          sendResponse({ success: false, error: 'tier3_no_chunks', requestedTier: 3, message: 'Attention engine returned no relevant chunks. Try again or switch to Smart Summary.' });
          return;
        }
        const selectedMessages = getMessagesFromChunks(chunks, session)
        const task3 = payload.task ?? 'Continue from where we left off'
        // [CM-T3-FIX] build attention map for scored chunk serialization
        const attentionMap = await attentionEngine.buildAttentionMap(session, task3, 'balanced');
        const localFile = buildTier3File(session, chunks, task3, attentionMap)
        migrationFile = accessToken
          ? await fetchMigrationBuild(
              { tier: 3, platform: session.platform, sessionTitle: session.title,
                messages: session.messages, originalCount: session.messages.length,
                chunks: selectedMessages, task: task3 },
              accessToken, localFile
            )
          : localFile;
      } catch (err) {
        clearTimeout(tid);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'tier3_timeout') {
          // [CM-TIER-FIX] timeout — return error, never auto-downgrade
          activeMigrationInProgress = false;
          sendResponse({ success: false, error: 'tier3_timeout', requestedTier: 3, message: 'Attention engine timed out on this device. Try again, or switch to Smart Summary or Full Context.' });
          return;
        }
        if (msg.includes("Failed to fetch")) {
          attentionEngineAvailable = false;
          await chrome.storage.local.set({ attentionEngineAvailable: false });
          console.debug("[CM:sw] Model fetch blocked during migration — Attention tier unavailable");
          activeMigrationInProgress = false;
          sendResponse({ success: false, error: 'Attention Engine unavailable — model could not load on this device' });
          return;
        }
        throw err;
      }
    }
  } catch (err: any) {
    console.warn('[CM:sw] File build failed, falling back to tier 1:', err)
    void reportExtensionEvent({ event: 'migration_fallback', platform: session.platform, tier, detail: String(err instanceof Error ? err.message : err).slice(0, 200), timestamp: Date.now() });
    migrationFile = buildTier1File(session)
    // Notify sidebar so the user knows the context was compressed.
    void broadcastToViews({
      type: 'MIGRATION_QUALITY_WARNING',
      originalTier: tier,
      fallbackTier: 1,
      reason: String(err instanceof Error ? err.message : err).slice(0, 120),
    })
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
  let injectionError: string | undefined
  
  // [CM-INJECT-FIX] All auto-injection is disabled. User must click inject button.
  if (payload.skipAutoInject) {
      console.log(`[CM:sw] Tier ${tier} skipAutoInject=true — injection deferred to MigrationModal button click`);
  } else {
      // This path is preserved for KnowledgeSynthesizer, which has no UI button.
      // It should still be user-triggered from the extension, just not from MigrationModal.
      try {
        if (tier === 1) {
            const t1Ready = await waitForTabContentScript(payload.targetTabId!)
            if (t1Ready) {
              const t1Result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
                chrome.tabs.sendMessage(
                  payload.targetTabId!,
                  { type: "INJECT_FILE_AS_UPLOAD", fileName: migrationFile.filename, fileContent: migrationFile.content },
                  (response) => {
                    void chrome.runtime.lastError;
                    resolve((response as { ok: boolean; error?: string } | null) ?? { ok: false, error: "no response from content script" });
                  }
                );
              });
              injected = t1Result.ok;
              if (!t1Result.ok) injectionError = t1Result.error;
            } else {
              console.warn(`[CM:sw] Tier 1 file injection: content script not ready on tab ${payload.targetTabId}`);
            }
        } else {
            const ready = await waitForTabContentScript(payload.targetTabId!);
            if (!ready) {
                console.warn(`[CM:sw] Tab ${payload.targetTabId} content script not ready after 8 pings — trying executeScript fallback`);
                const [execResult] = await chrome.scripting.executeScript({
                    target: { tabId: payload.targetTabId! },
                    func: injectPromptInPage,
                    args: [instructionPrompt, payload.targetPlatform],
                });
                const execRes = execResult?.result as { ok: boolean; error?: string } | undefined;
                if (execRes?.ok) {
                    injected = true;
                } else {
                    injectionError = execRes?.error ?? 'executeScript fallback failed';
                }
            } else {
                const result = await sendMessageToTab(payload.targetTabId!, {
                    type: 'INJECT_CONTEXT',
                    prompt: instructionPrompt,
                    platform: payload.targetPlatform
                });
                injected = result?.ok ?? false;
                if (!result.ok) injectionError = result.error;
            }
        }
      } catch (err) {
        injectionError = err instanceof Error ? err.message : String(err);
        console.warn('[CM:sw] Auto-injection for non-modal path failed:', err)
        void reportInjectionError({ platform: payload.targetPlatform, reason: `auto-inject_${injectionError.slice(0,200)}`, timestamp: Date.now(), tier });
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
  activeMigrationInProgress = false;
  void reportExtensionEvent({ event: 'migration_success', platform: session.platform, tier, detail: injected ? 'injected' : 'prepared', timestamp: Date.now() });
  sendResponse({
    success: true,
    injected,
    injectionError,
    cacheKey,
    coverageStats,
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
        const tabUrl = tab.url ?? "";
        void reportScraperBroken({ platform, reason: String(error).slice(0, 200), href: tabUrl, timestamp: Date.now() });
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

  // Helper: query outermost elements for a selector, filtering nested duplicates.
  function outermost(sel: string): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((el) => !el.parentElement?.closest(sel));
  }

  type Entry = { el: HTMLElement; role: "user" | "assistant" };

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
    // Multi-strategy: data-testid → class substrings → aria-label → legacy
    const gCollected: Entry[] = [];
    const hasGUser = () => gCollected.some((e) => e.role === "user");
    const hasGAsst = () => gCollected.some((e) => e.role === "assistant");

    // S1: data-testid
    outermost('[data-testid*="user"], [data-testid*="human"]').forEach((el) => gCollected.push({ el, role: "user" }));
    if (!hasGAsst()) outermost('[data-testid*="assistant"], [data-testid*="ai-turn"], [data-testid*="grok-response"]').forEach((el) => gCollected.push({ el, role: "assistant" }));

    // S2: class substrings (human-turn / HumanTurn, response-content-markdown)
    if (!hasGUser()) outermost('[class*="human-turn"], [class*="HumanTurn"], [class*="human_turn"]').forEach((el) => gCollected.push({ el, role: "user" }));
    if (!hasGAsst()) outermost('[class*="response-content-markdown"], [class*="grok-response"], [class*="GrokResponse"]').forEach((el) => gCollected.push({ el, role: "assistant" }));

    // S3: legacy class + data-role
    if (!hasGUser()) outermost('[class*="user-message"], [class*="UserMessage"], [data-role="user"]').forEach((el) => gCollected.push({ el, role: "user" }));
    if (!hasGAsst()) outermost('[class*="assistant-message"], [class*="AssistantMessage"], [data-role="assistant"]').forEach((el) => gCollected.push({ el, role: "assistant" }));

    gCollected.sort((a, b) => {
      const rel = a.el.compareDocumentPosition(b.el);
      return rel & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    messages = gCollected
      .map(({ el, role }) => {
        const content = el.innerText.trim();
        return content ? { role, content, timestamp: Date.now() } : null;
      })
      .filter(Boolean) as typeof messages;
  } else if (platform === "perplexity") {
    // Multi-strategy: data-message-role → data-testid + class → thread structure
    const pCollected: Entry[] = [];
    const hasPUser = () => pCollected.some((e) => e.role === "user");
    const hasPAsst = () => pCollected.some((e) => e.role === "assistant");

    // A: data-message-role
    outermost("[data-message-role]").forEach((el) => {
      const role = (el as HTMLElement).dataset.messageRole as "user" | "assistant";
      if (role === "user" || role === "assistant") pCollected.push({ el, role });
    });

    // B: data-testid + class substrings
    if (!hasPAsst()) {
      outermost('[class*="group/query"], [data-testid="user-message"], [data-testid*="user-query"], [data-testid*="user"], [class*="UserMessage"], [class*="user-query"], [class*="user-message"]')
        .forEach((el) => pCollected.push({ el, role: "user" }));
      outermost('[class*="prose"], [class*="AnswerText"], [class*="answer-text"], [data-testid*="answer"], [data-testid*="assistant"], [class*="assistant-message"], .answer-block, [class*="answer-block"]')
        .forEach((el) => pCollected.push({ el, role: "assistant" }));
    }

    // C: thread-item structure
    if (!hasPUser()) {
      outermost('[class*="thread-item"], [class*="ThreadItem"], [class*="conversation-turn"]').forEach((turn) => {
        const queryEl = turn.querySelector<HTMLElement>('[class*="query"], [class*="Query"], [class*="user"]');
        const answerEl = turn.querySelector<HTMLElement>('[class*="answer"], [class*="Answer"], [class*="markdown"], .prose');
        if (queryEl) pCollected.push({ el: queryEl, role: "user" });
        if (!hasPAsst() && answerEl) pCollected.push({ el: answerEl, role: "assistant" });
      });
    }

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
    // Multi-strategy: data-message-author-role → data-testid + class → data-role
    const dCollected: Entry[] = [];
    const hasDUser = () => dCollected.some((e) => e.role === "user");
    const hasDAsst = () => dCollected.some((e) => e.role === "assistant");

    // A: data-message-author-role
    outermost("[data-message-author-role]").forEach((el) => {
      const role = (el as HTMLElement).dataset.messageAuthorRole as "user" | "assistant";
      if (role === "user" || role === "assistant") dCollected.push({ el, role });
    });

    // B: data-testid + class substrings (no obfuscated hashes)
    if (!hasDAsst()) {
      outermost('[class*="ds-message"]:not([class*="ds-assistant"]), [data-testid*="user"], [data-testid*="human"], [class*="user-message"], [class*="human-message"], [data-type="user"], [data-role="user"]')
        .filter((el) => !el.querySelector('[class*="ds-markdown"], [class*="ds-assistant"]'))
        .forEach((el) => dCollected.push({ el, role: "user" }));
      outermost('[class*="ds-assistant-message-main-content"], [class*="ds-markdown"], [data-testid*="assistant"], [data-testid*="answer"], [class*="assistant-message"], [class*="model-response"]')
        .forEach((el) => dCollected.push({ el, role: "assistant" }));
    }

    // C: data-role / role attributes
    if (!hasDUser()) {
      outermost("[data-role]").forEach((el) => {
        const role = ((el as HTMLElement).dataset.role ?? "").toLowerCase();
        if (role === "user" || role === "human") dCollected.push({ el, role: "user" });
        else if (!hasDAsst() && (role === "assistant" || role === "ai" || role === "bot")) dCollected.push({ el, role: "assistant" });
      });
    }

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
      'rich-textarea .ql-editor',
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

  // ── Gemini (Quill / Angular contenteditable) ─────────────────────────────
  if (platform === 'gemini' && input.isContentEditable) {
    input.innerHTML = '';
    const inserted = document.execCommand('insertText', false, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (inserted && (input.textContent?.trim().length ?? 0) > 0) return { ok: true };
    input.textContent = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: (input.textContent?.trim().length ?? 0) > 0 };
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

// Self-contained Gemini injector with shadow-DOM piercing — serialised via
// chrome.scripting.executeScript. ZERO imports / outer-scope references allowed.
//
// Root cause of previous failures: Gemini 2026 uses Angular ViewEncapsulation.ShadowDom
// on <rich-textarea>, so document.querySelector("rich-textarea .ql-editor") silently
// returns null — it cannot cross the shadow root boundary. All 5 attempts found nothing.
//
// Fix: pierce the shadow root explicitly before falling back to direct queries.
async function injectIntoGeminiPage(
  text: string
): Promise<{ ok: boolean; selector?: string; length?: number; reason?: string }> {
  // ── Inline helpers (must be inside the function for executeScript serialisation) ──

  // Recursively walk open shadow roots to find a matching element.
  function shadowDeepQuery(root: Element | ShadowRoot, sels: string[]): HTMLElement | null {
    for (const sel of sels) {
      const el = root.querySelector<HTMLElement>(sel);
      if (el) return el;
    }
    for (const child of Array.from(root.querySelectorAll('*'))) {
      const sr = (child as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
      if (sr) {
        const found = shadowDeepQuery(sr, sels);
        if (found) return found;
      }
    }
    return null;
  }

  // Find the Gemini text input using three strategies (shadow first, then direct, then deep).
  function findGeminiEl(): { el: HTMLElement; label: string } | null {
    const SHADOW_INNER = [
      '.ql-editor[contenteditable="true"]',
      '.ql-editor',
      '[contenteditable="true"]',
    ];
    const DIRECT = [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'rich-textarea .ql-editor',
      'rich-textarea [contenteditable]',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][data-lexical-editor]',
      'div[contenteditable="true"].ProseMirror',
      '[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
    ];

    // Strategy 1: pierce rich-textarea shadow root
    for (const rt of Array.from(document.querySelectorAll('rich-textarea'))) {
      const sr = (rt as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
      if (sr) {
        for (const sel of SHADOW_INNER) {
          const el = sr.querySelector<HTMLElement>(sel);
          if (el) return { el, label: `rich-textarea>#shadow>${sel}` };
        }
      }
    }

    // Strategy 2: direct document query (catches non-shadow layouts)
    for (const sel of DIRECT) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) return { el, label: sel };
    }

    // Strategy 3: deep recursive shadow walk (nested custom elements)
    const deep = shadowDeepQuery(document.body, SHADOW_INNER);
    if (deep) return { el: deep, label: 'deep-shadow-walk' };

    return null;
  }

  // Inject text into a found element using 4 fallback strategies.
  function doInject(el: HTMLElement): { ok: boolean; error?: string } {
    try {
      el.focus();
      el.click();

      // A. Quill JS API on shadow host
      type QuillLike = { setText(t: string): void; setSelection(n: number): void };
      const rt = document.querySelector('rich-textarea') as (HTMLElement & { __quill?: QuillLike }) | null;
      if (rt?.__quill) {
        rt.__quill.setText(text);
        rt.__quill.setSelection(text.length);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true };
      }

      // B. execCommand selectAll + insertText
      el.innerHTML = '';
      document.execCommand('selectAll', false, undefined);
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) {
        console.error('[CM] execCommand error:', e);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (ok && (el.textContent?.trim().length ?? 0) > 0) return { ok: true };

      // C. Synthetic beforeinput + InputEvent (Angular change-detection path)
      try {
        const ev = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text });
        el.dispatchEvent(ev);
        if (!ev.defaultPrevented) el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        if ((el.textContent?.trim().length ?? 0) > 0) return { ok: true };
      } catch (e) {
        console.error('[CM] beforeinput event error:', e);
      }

      // D. Direct textContent fallback
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const finalLen = (el.textContent?.trim().length ?? 0);
      return { ok: finalLen > 0, error: finalLen === 0 ? 'text_not_set' : undefined };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error('[CM] doInject error:', errMsg);
      return { ok: false, error: errMsg };
    }
  }

  // ── Retry loop ──────────────────────────────────────────────────────────────
  const ATTEMPT_DELAYS = [0, 300, 800, 1500, 2000];
  let lastError = 'no_input_found_after_retries';

  try {
    for (let attempt = 0; attempt < ATTEMPT_DELAYS.length; attempt++) {
      if (attempt > 0) await new Promise<void>((r) => setTimeout(r, ATTEMPT_DELAYS[attempt]));

      console.log(`[CM] Gemini inject attempt ${attempt + 1}/${ATTEMPT_DELAYS.length} (delay=${ATTEMPT_DELAYS[attempt]}ms)`);

      const found = findGeminiEl();
      if (!found) {
        console.warn(`[CM] Gemini inject attempt ${attempt + 1}: no input found`);
        lastError = 'no_input_element_found';
        continue;
      }

      const { el, label } = found;
      console.log(`[CM] Gemini inject attempt ${attempt + 1}: found via "${label}"`);

      const injectResult = doInject(el);
      const length = el.textContent?.trim().length ?? 0;
      if (injectResult.ok || length > 0) {
        console.log(`[CM] Gemini inject succeeded (attempt ${attempt + 1}, length=${length})`);
        return { ok: true, selector: label, length };
      }
      lastError = injectResult.error ?? 'injection_failed';
      console.warn(`[CM] Gemini inject attempt ${attempt + 1}: element found but injection failed — ${lastError}`);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error('[CM] injectIntoGeminiPage error:', errMsg);
    lastError = errMsg;
  }

  return { ok: false, reason: lastError };
}

/**
 * Resolves to true when tab.status === 'complete', false on timeout.
 * Event-driven via chrome.tabs.onUpdated — no polling loop.
 */
function waitForTabComplete(tabId: number, timeoutMs = 15_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) { resolve(false); return; }
      if (tab.status === "complete") { resolve(true); return; }
      const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
        if (id !== tabId || info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve(true);
      };
      chrome.tabs.onUpdated.addListener(listener);
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }, timeoutMs);
    });
  });
}

/**
 * Two-phase readiness check before INJECT_CONTEXT:
 * Phase 1 — waits for tab.status === 'complete' (event-driven via onUpdated, 15 s cap).
 * Phase 2 — pings the content script 8 times at uniform 1500ms intervals.
 * Returns true when the script responds, false when all 8 pings are exhausted.
 */
async function waitForTabContentScript(tabId: number): Promise<boolean> {
  // Phase 1: wait for the tab to finish its initial navigation.
  const complete = await waitForTabComplete(tabId, 15_000);
  console.log(
    complete
      ? `[CM:sw] Tab ${tabId} reached 'complete' status`
      : `[CM:sw] Tab ${tabId} did not reach 'complete' within 15 s — proceeding with pings`
  );

  // Phase 2: ping at uniform 1500ms intervals (delay runs BEFORE each attempt).
  const PING_RETRIES = 8;
  const PING_DELAY_MS = 1_500;
  for (let i = 0; i < PING_RETRIES; i++) {
    await new Promise<void>((r) => setTimeout(r, PING_DELAY_MS));
    console.log(`[CM:ping] Tab ${tabId} attempt ${i + 1}/${PING_RETRIES} (+${PING_DELAY_MS}ms)`);
    const alive = await new Promise<boolean>((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, { type: "PING" }, (resp) => {
          resolve(!chrome.runtime.lastError && !!resp);
        });
      } catch { resolve(false); }
    });
    if (alive) {
      console.log(`[CM:sw] Tab ${tabId} content script ready (attempt ${i + 1}/${PING_RETRIES})`);
      return true;
    }
    console.log(`[CM:sw] Tab ${tabId} ping ${i + 1}/${PING_RETRIES} — no response`);
  }
  return false;
}

async function sendMessageToTab(
  tabId: number,
  message: { type: "INJECT_CONTEXT"; prompt: string; platform: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS_MS = [2_000, 4_000]; // exponential backoff between attempts
  // Per-attempt timeout reduced from 10s → 5s: waitForTabContentScript already
  // confirmed the content script is alive via PING, so 5s is ample for an
  // INJECT_CONTEXT ack and reduces user-perceived hang on slow target tabs.
  const ATTEMPT_TIMEOUT_MS = 5_000;

  let lastError = "Unknown injection error";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Race the tab message against the per-attempt timeout.
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, message) as Promise<unknown>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Injection timed out after ${ATTEMPT_TIMEOUT_MS / 1000}s`)), ATTEMPT_TIMEOUT_MS)
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

      // Timeout or other transient error — exponential backoff before retry.
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? 4_000;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
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
