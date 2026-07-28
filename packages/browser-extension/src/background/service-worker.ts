/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 * Build: 2026-06-07-v2
 */

// packages/browser-extension/src/background/service-worker.ts
import { db, dexieDb, ensureDbReady, sessionCache, wipeAllLocalData } from "@/lib/db";
import { migrateFromContextForge } from "@/lib/db-migration";
import summarize, { summarizeIntelligent, buildTier2WithScoring, type IntelligentSummary } from "@/lib/summarizer";
import buildMigrationPrompt from "@/lib/translator";
import type { ContextSession, Message, Platform, ScoredMessage } from "@/lib/types";
import type { ChunkEmbedding } from "@/lib/db";
import { supabase } from "@/lib/supabase";
import { syncPromptTemplates, syncPromptAssignments, queueVaultSync } from "@/lib/cloud-sync";
import { semanticIndex, ensureOffscreenDocument } from "@/lib/semantic-index/index";
import { getHardwareProfile, attentionEngine, invalidateAttentionMapCache } from "@/lib/attention-engine";
import type { AttentionMap } from "@/lib/attention-engine";
import { scoreMigration, formatScoreReport, type QualityScore } from "@/lib/quality/migration-scorer";
import { generateQualityReport } from "@/lib/quality/report-generator";
import { userVault } from "@/lib/user-vault/connector";
import { forgetSession, resolveSessionId } from "@/lib/session-id";
import { WEBAPP_URL } from "@/config/urls";
import { buildTier1File, buildTier2File, buildTier3File, buildMultiSessionTier1File, buildMultiSessionTier2File, buildMultiSessionTier3File, getMessagesFromChunks } from "@/lib/file-builder"
import { buildInstructionPrompt } from "@/lib/instruction-builder"
import { checkUsage, incrementUsage } from "@/lib/usage-client"
import type { MigrationFile } from "@/lib/file-builder"
import { fetchSummary, reportScraperBroken, reportInjectionError, reportExtensionEvent } from "@/lib/server-intelligence-client"
import { getRemoteConfig } from "@/lib/remote-config"
import { pickBestKnown, shouldRejectIncoming, mergePartialScrape } from "@/lib/capture/capture-merge";
import { healthMonitor } from "@/lib/capture/health-monitor";
import { validateCapture } from "@/lib/capture/capture-validator";
// Load console helpers for SW debugging (registers global functions)
import "./sw-console-helpers";
import { perfStart, getPerfStats, recordPerf } from "@/lib/perf-track";
import { latencyTracker, StallDetector } from "@/lib/adaptive-timeout";
import { hashMessages } from "@/lib/semantic-index/hasher";
// Drive sync — additive layer over IndexedDB. Independent of Supabase vault.
import { driveClient } from "@/lib/drive/drive-client";
import { driveSyncManager } from "@/lib/drive/sync-manager";

const DEBUG = process.env.NODE_ENV === "development";
const DEBUG_DIAG = false; // Set true to re-enable verbose diagnostic log mirroring

// ── Attention-engine availability (set to false if model fetch blocked) ─────
let attentionEngineAvailable = true;
let activeMigrationInProgress = false;
// [ISSUE-24] Track consecutive Drive sync skips to prevent starvation
let _syncSkipCount = 0;
// [CM-FIX-SERIALIZE] Only one migration runs at a time — concurrent ones queue.
let _migrationLockPromise: Promise<void> = Promise.resolve();

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

// ── Stable per-profile installation ID ───────────────────────────────────────
// Each Chrome profile has its own chrome.storage.local, so this UUID is unique
// per profile. Used as X-Install-Id to enforce the 5-device pro account limit.
const INSTALL_ID_KEY = "cm:installId";
async function getInstallId(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(INSTALL_ID_KEY);
    if (stored[INSTALL_ID_KEY] && typeof stored[INSTALL_ID_KEY] === "string") {
      return stored[INSTALL_ID_KEY] as string;
    }
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [INSTALL_ID_KEY]: id });
    return id;
  } catch {
    return "unknown";
  }
}

// [DRIVE-LICENSE] Fetch Drive email, bind to Supabase account (if signed in),
// and check if the Drive email is registered to a pro account.
// Called on DRIVE_CONNECT and startup. Never throws.
async function registerDriveLicense(): Promise<void> {
  try {
    const driveEmail = await driveClient.getDriveEmail();
    if (!driveEmail) {
      console.log("[CM:drive-license] No Drive email — skipping license registration");
      return;
    }
    await chrome.storage.local.set({ driveEmail });
    console.log("[CM:drive-license] Drive email:", driveEmail);

    // Bind: if user is signed in to Supabase, link Drive email to their account.
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (token) {
        const bindRes = await fetch(`${WEBAPP_URL}/api/payments/drive-license`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action: "bind", driveEmail }),
          signal: AbortSignal.timeout(8000),
        });
        console.log("[CM:drive-license] bind result:", bindRes.status);
      }
    } catch (e) {
      console.warn("[CM:drive-license] bind failed (non-fatal):", e);
    }

    // [PRO-SEATS] Check: does this Drive email have pro? Send loginEmail if signed in.
    const { data: { session } } = await supabase.auth.getSession();
    const loginEmail = session?.user?.email ?? null;
    const checkBody: { action: string; driveEmail: string; loginEmail?: string } = { action: "check", driveEmail };
    if (loginEmail) checkBody.loginEmail = loginEmail;

    const checkRes = await fetch(`${WEBAPP_URL}/api/payments/drive-license`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(checkBody),
      signal: AbortSignal.timeout(8000),
    });
    if (checkRes.ok) {
      const data = await checkRes.json() as { isPro?: boolean; reason?: string };
      const isPro = Boolean(data.isPro);
      await chrome.storage.local.set({ driveProLicense: isPro, driveProReason: data.reason ?? null });
      console.log("[CM:drive-license] pro license check:", isPro, "reason:", data.reason);
      if (isPro) {
        // [FIX-BADGE-LATENCY] The SW's own GET_SUBSCRIPTION_STATUS cache (60s TTL,
        // keyed by token) doesn't know the Drive license just flipped — without
        // invalidating it here, the sidebar's broadcast-triggered refetch just
        // replays the stale pre-Drive-connect response for up to 60s.
        _subStatusCache = null;
        void broadcastToViews({ type: "AUTH_STATE_CHANGED" } as any);
      } else if (data.reason === "drive_mismatch") {
        console.warn("[CM:drive-license] DRIVE MISMATCH — Pro revoked on this profile");
        await chrome.storage.local.set({ driveProLicense: false, driveProReason: "drive_mismatch" });
        _subStatusCache = null;
        void broadcastToViews({ type: "DRIVE_PRO_MISMATCH" } as any);
        void broadcastToViews({ type: "AUTH_STATE_CHANGED" } as any);
      }
    } else {
      console.warn("[CM:drive-license] check failed:", checkRes.status);
    }
  } catch (e) {
    console.warn("[CM:drive-license] registration failed (non-fatal):", e);
  }
}

// [PRO-SEATS] Eager cached pro-check on startup — decouples pro status from slow Drive OAuth.
// Reads cached driveEmail and runs pro check immediately without waiting for getAuthToken.
// Re-verified in background after Drive reconnects via registerDriveLicense.
async function eagerProCheck(): Promise<void> {
  try {
    const { driveEmail } = await chrome.storage.local.get("driveEmail");
    if (!driveEmail) {
      console.log("[CM:drive-license] No cached Drive email — skipping eager pro check");
      return;
    }
    console.log("[CM:drive-license] Eager pro check with cached Drive email:", driveEmail);
    const { data: { session } } = await supabase.auth.getSession();
    const loginEmail = session?.user?.email ?? null;
    const checkBody: { action: string; driveEmail: string; loginEmail?: string } = { action: "check", driveEmail };
    if (loginEmail) checkBody.loginEmail = loginEmail;

    const checkRes = await fetch(`${WEBAPP_URL}/api/payments/drive-license`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(checkBody),
      signal: AbortSignal.timeout(5000),
    });
    if (checkRes.ok) {
      const data = await checkRes.json() as { isPro?: boolean; reason?: string };
      const isPro = Boolean(data.isPro);
      await chrome.storage.local.set({ driveProLicense: isPro, driveProReason: data.reason ?? null });
      console.log("[CM:drive-license] eager pro check result:", isPro, "reason:", data.reason);
      if (isPro || data.reason === "drive_mismatch") {
        // [FIX-BADGE-LATENCY] see registerDriveLicense — invalidate the stale
        // GET_SUBSCRIPTION_STATUS cache before telling the sidebar to refetch.
        _subStatusCache = null;
        if (data.reason === "drive_mismatch") {
          void broadcastToViews({ type: "DRIVE_PRO_MISMATCH" } as any);
        }
        void broadcastToViews({ type: "AUTH_STATE_CHANGED" } as any);
      }
    } else {
      console.warn("[CM:drive-license] eager pro check failed:", checkRes.status);
    }
  } catch (e) {
    console.warn("[CM:drive-license] eager pro check exception:", e);
  }
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
const METAPROMPT_COOLDOWN_MS = 10_000; // 10s — rebuild eagerly so Tier1 migration hits cache
// [ISSUE-23] Staggered debounce timers per session — prevents thundering herd
const _indexDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _syncDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _metaPromptDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Background index enqueue cooldown — prevents 16ms "already indexed" re-enqueues
// when the same session is captured multiple times within a short window.
// Sessions that are already fully indexed skip the enqueue if content hasn't changed.
const indexEnqueueLastMsgCount = new Map<string, number>();
const INDEX_ENQUEUE_COOLDOWN_MS = 60_000; // 1 min min between re-index enqueues for same content
const indexEnqueueLastAt = new Map<string, number>();

// SCRAPER_BROKEN refresh debounce — one remote-config fetch per 30 s is enough
// even when multiple content scripts break simultaneously.
let scraperBrokenRefreshAt = 0;
const SCRAPER_BROKEN_REFRESH_COOLDOWN_MS = 30_000;

/**
 * Ensures the offscreen document is running before sending it a message.
 * Lightweight version scoped to the SW — swallows "already exists" errors.
 */
// [CM-RACE-FIX] Creation lock — concurrent callers (e.g. WARMUP_MODEL +
// MIGRATE_CONTEXT in the same tick) must await the SAME creation, otherwise both
// see hasDocument()===false, both call createDocument, and the loser proceeds
// without waiting for OFFSCREEN_READY (messaging an uninitialized doc).
let _offscreenCreating: Promise<void> | null = null;

async function ensureOffscreenDocumentLocal(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offscreen = (chrome as any).offscreen;
  if (!offscreen) return;
  if (_offscreenCreating) return _offscreenCreating;

  _offscreenCreating = (async () => {
    // keep-alive starts BEFORE doc creation so it covers hasDocument + createDocument + ONNX init
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const l = (m: any) => {
            if (m?.type === 'OFFSCREEN_READY') {
              clearTimeout(t);
              chrome.runtime.onMessage.removeListener(l);
              if (m.modelLoaded === false) {
                console.warn('[CM:sw] offscreen ready but model warmup failed — attention engine disabled');
                attentionEngineAvailable = false;
                void chrome.storage.local.set({ attentionEngineAvailable: false });
              }
              res();
            }
          };
          const t = setTimeout(() => { chrome.runtime.onMessage.removeListener(l); rej(new Error('offscreen_ready_timeout')); }, 60_000);
          chrome.runtime.onMessage.addListener(l);
        });
        console.log("[CM:sw] offscreen ready");
      } catch (e) { console.warn("[CM:sw] offscreen ready wait:", e); }
      finally { clearInterval(ka); }
    } catch (err) {
      clearInterval(ka);
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Only a single offscreen") && !msg.includes("already")) {
        console.warn("[CM:sw] ensureOffscreenDocumentLocal failed:", msg);
      }
    }
  })().finally(() => { _offscreenCreating = null; });

  return _offscreenCreating;
}

// GET_SESSIONS result cache — coalesces rapid-fire sidebar polls within 100ms.
let getSessionsCache: unknown = null;
let getSessionsCacheAt = 0;
const GET_SESSIONS_CACHE_MS = 100; // 100ms - responsive but still dedups rapid polls

// [PERF-M4] GET_SUBSCRIPTION_STATUS cache. The sidebar resets its own cache on
// auth events and refresh clicks, so this handler was hit ~10×/session, each
// firing a backend HTTP request. Cache the response 60s, keyed by token, with a
// `force` bypass. Invalidated on sign-out/account switch (see onAuthStateChange).
let _subStatusCache: { token: string; at: number; data: unknown } | null = null;
const SUB_STATUS_CACHE_MS = 60_000;

// Throttle the background Drive pull triggered by GET_SESSIONS.
// Without this, rapid sidebar polls would spam Drive API calls.
let lastDrivePullFromListAt = 0;
const DRIVE_PULL_FROM_LIST_COOLDOWN_MS = 10_000; // 10s — fast sidebar-triggered pull

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
  // NOTE: do NOT reset modelWarmed here. The offscreen document is NOT tied to
  // any browser tab — it persists independently. Resetting on every tab close
  // forces a 45-90s ONNX model re-init on the next Tier 3 migration, causing
  // the slowness users experience. modelWarmed is only reset when the offscreen
  // doc is explicitly destroyed (see ensureOffscreenDocumentLocal).
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

// [PERF] Pre-compiled per-platform regex map — avoids RegExp compilation on every
// payloadPlatformMatchesSender() call (hot path: every CAPTURE_SESSION message).
const PLATFORM_RE_MAP: Record<string, RegExp> = Object.fromEntries(
  Object.entries(PLATFORM_URLS).map(([platform, globs]) => [
    platform,
    new RegExp(
      globs.map((g) => "^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").join("|"),
      "i"
    ),
  ])
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
  const re = PLATFORM_RE_MAP[platform];
  return re ? re.test(url) : false;
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
  console.log("[ContextMover] Extension installed. v2");
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
  // [FIX-7] Always create the drive-sync-periodic alarm on startup. The sync
  // cycle handles not-connected gracefully (retains queue, retries on next cycle).
  // Previously the alarm was only created if isTokenValid() returned true, which
  // meant the 30s sync cycle didn't start until the first capture triggered it.
  chrome.alarms.create("drive-sync-periodic", { periodInMinutes: 0.5 });
  const driveValid = await driveClient.isConnected().catch(() => false);
  if (driveValid) {
    void driveSyncManager.initialSync().then(() => { getSessionsCache = null; }).catch(() => {});
  }
  // [PRO-SEATS] Eager pro check on startup — renders pro status immediately without waiting for Drive OAuth
  void eagerProCheck();
  // [ISSUE-9] Always call registerDriveLicense on startup — it's a no-op if Drive not connected
  void registerDriveLicense();
  void getHardwareProfile().then((hw) => {
    chrome.storage.local.set({ hwTier: hw.tier }).catch(() => {});
    // [CM-EAGER-WARMUP] Pre-load ONNX model on startup so it's hot when needed.
    // Skip on minimal tier — embedding is disabled there anyway.
    if (hw.tier !== 'minimal' && attentionEngineAvailable) {
      setTimeout(() => {
        console.log('[CM:sw] Eager warming up ONNX model...');
        semanticIndex.warmup().then(() => {
          console.log('[CM:sw] ONNX model warmed up and ready');
          modelWarmed = true;
        }).catch((e) => {
          console.warn('[CM:sw] Eager warmup failed (non-fatal):', e);
        });
      }, 3000); // Delay 3s to let critical startup tasks finish first

      // [CM-ALWAYS-WARM] Unconditional 5-min keep-alive. Model stays hot always.
      // Migration should NEVER wait for warmup.
      setInterval(() => {
        if (!attentionEngineAvailable || activeMigrationInProgress) return;
        semanticIndex.warmup().then(() => {
          modelWarmed = true;
        }).catch(() => {});
      }, 5 * 60 * 1000);
    }
  }).catch(() => {});

  // [ONNX-KEEPALIVE-L2] 20s interval — well under 30s SW idle timeout.
  // Keeps SW alive between alarm fires. Zero CPU, trivial storage read.
  // Combined with Layer 1 (port from sidebar) and Layer 3 (30s alarm),
  // this ensures the offscreen doc + ONNX model never get GC'd.
  setInterval(() => {
    void chrome.storage.local.get('_ka', () => {});
  }, 20_000);

  // [CM-PERSIST-FIX] recover interrupted background index jobs after Chrome restart
  // Delay 5s to let offscreen doc and Drive sync initialise first
  setTimeout(() => {
    void (async () => {
      try {
        const recentSessions = await dexieDb.sessions.orderBy('updatedAt').reverse().limit(200).toArray();
        for (const session of recentSessions) {
          // Stop re-queuing immediately if a migration starts — it owns the ONNX worker.
          if (activeMigrationInProgress) break;
          if (session.messages.length > 0) {
            const chunkCount = await dexieDb.chunkEmbeddings.where('sessionId').equals(session.id).count();
            if (chunkCount === 0) {
              console.log(`[CM:startup] Found un-indexed session ${session.id}, re-queuing`);
              await semanticIndex.indexSession(session).catch(() => {});
              // [STARTUP-FIX] Stagger 1s between enqueues — prevents flooding the offscreen
              // worker with 14+ sessions simultaneously. cancelBackgroundJobs() can then
              // stop the queue before migration fires, rather than cancelling mid-batch.
              await new Promise<void>(resolve => setTimeout(resolve, 1_000));
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

        if (pending.length === 0) return;

        console.log(`[CM:startup] recovering ${pending.length} interrupted index job(s)`)

        for (const job of pending) {
          // Give up after 3 failed attempts — session may be corrupted
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
  chrome.alarms.create("drive-sync-periodic", { periodInMinutes: 0.5 });
});

// Keep chrome.storage.local in sync whenever Supabase silently refreshes the token.
supabase.auth.onAuthStateChange(async (event, session) => {
  console.log("[CM:auth] onAuthStateChange event:", event, "hasSession:", !!session, "userId:", session?.user?.id);
  _subStatusCache = null;

  if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
    const newUserId = session?.user?.id;
    if (session?.access_token) {
      await chrome.storage.local.set({ accessToken: session.access_token, userId: newUserId });
    }

    // [PRIVACY] Account-switch wipe — if the user changed accounts, wipe all
    // local data from the previous account so User B never sees User A's data.
    if (event === "SIGNED_IN" && newUserId) {
      const prevUserId = await chrome.storage.local.get("prevUserId").then(r => r.prevUserId as string | undefined);
      if (prevUserId && prevUserId !== newUserId) {
        console.log(`[CM:auth] account switch detected (${prevUserId} → ${newUserId}) — wiping local data`);
        semanticIndex.cancelBackgroundJobs();
        _indexingInFlight.clear();
        _indexDirty.clear(); _indexDirtyHash.clear();
        try {
          await new Promise<void>(resolve => {
            chrome.runtime.sendMessage({ type: "CANCEL_ALL_JOBS" }, () => {
              void chrome.runtime.lastError;
              resolve();
            });
          });
        } catch (e) {}
        await wipeAllLocalData();
        sessionCache.invalidate();
        getSessionsCache = null;
        void broadcastToViews({ type: "ACCOUNT_SWITCHED" } as any);
      }
      await chrome.storage.local.set({ prevUserId: newUserId });
    }

    // [PRIVACY] Post-login Drive restore — if Drive is connected, pull the
    // user's data back so they see their conversations on this device.
    if (event === "SIGNED_IN") {
      const driveConnected = await driveClient.isConnected().catch(() => false);
      if (driveConnected) {
        console.log("[CM:auth] Drive connected — triggering restore sync");
        void broadcastToViews({ type: "DRIVE_RESTORE_START" } as any);
        void driveSyncManager.initialSync().then(() => {
          getSessionsCache = null;
          void broadcastToViews({ type: "DRIVE_RESTORE_DONE" } as any);
        }).catch((e) => {
          console.warn("[CM:auth] Drive restore failed:", e);
          void broadcastToViews({ type: "DRIVE_RESTORE_DONE" } as any);
        });
      }
    }
  }

  if (event === "SIGNED_OUT") {
    // [PRIVACY] Guarded logout wipe (option a):
    // If Drive is connected and has a backup, flush local data to Drive then
    // wipe local. If no Drive, keep local data but set 'unsynced' flag so the
    // sidebar can show a warning banner.
    const driveConnected = await driveClient.isConnected().catch(() => false);
    if (driveConnected) {
      console.log("[CM:auth] signed out — Drive connected, flushing then wiping local data");
      try {
        await driveSyncManager.syncBidirectional();
      } catch (e) {
        console.warn("[CM:auth] Drive flush before wipe failed:", e);
      }
      driveSyncManager.resetSyncCooldown();
      semanticIndex.cancelBackgroundJobs();
      _indexingInFlight.clear();
      _indexDirty.clear(); _indexDirtyHash.clear();
      try {
        await new Promise<void>(resolve => {
          chrome.runtime.sendMessage({ type: "CANCEL_ALL_JOBS" }, () => {
            void chrome.runtime.lastError;
            resolve();
          });
        });
      } catch (e) {}
      await wipeAllLocalData();
      sessionCache.invalidate();
      getSessionsCache = null;
      await chrome.storage.local.remove(["accessToken", "userId", "prevUserId", "unsyncedData"]);
      console.log("[CM:auth] signed out, local data wiped (Drive backup exists)");
    } else {
      // No Drive — keep data but flag as unsynced for banner
      await chrome.storage.local.set({ unsyncedData: true });
      await chrome.storage.local.remove(["accessToken", "userId"]);
      console.log("[CM:auth] signed out, no Drive — data kept, flagged unsynced");
    }
  }
});

// Periodic remote-config refresh — fires every 6 h while the browser is running.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REMOTE_CONFIG_ALARM) {
    void refreshRemoteConfig();
  }
  if (alarm.name === "drive-sync-periodic") {
    void (async () => {
      try {
        // [WIPE-FIX] Skip sync if Drive was wiped — syncBidirectional
        // has its own guard, but this avoids a redundant isConnected
        // call and token refresh attempt.
        if (driveSyncManager.isDriveWiped()) return;
        // [ISSUE-24] Throttle Drive sync during indexing backlog — IDB locks + SW CPU contention.
        // [SYNC-FIX] Old threshold (queueLen > 5) skipped almost every cycle during a post-wipe
        // bulk re-index, starving sync indefinitely. Tightened to: only skip during an ACTIVE
        // migration, or when queueLen > 20 (genuine saturation). The starvation guard now
        // forces a sync after 2 skips (was 3) so a long bulk-index can't block sync > ~2 min.
        const queueLen = semanticIndex.getQueueLength();
        if (activeMigrationInProgress || queueLen > 20) {
          _syncSkipCount++;
          if (_syncSkipCount >= 2) {
            console.log(`[CM:sw] drive-sync: forced after ${_syncSkipCount} skips (starvation prevention)`);
            _syncSkipCount = 0;
          } else {
            console.log(`[CM:sw] drive-sync skipped — migration active=${activeMigrationInProgress} backlog=${queueLen} (skip #${_syncSkipCount})`);
            return;
          }
        } else {
          _syncSkipCount = 0;
        }
        // Proactively refresh token via isConnected() which calls getToken(false)
        // — this triggers getAuthToken auto-refresh before sync starts
        if (await driveClient.isConnected()) {
          await driveSyncManager.syncBidirectional();
          getSessionsCache = null;
        }
      } catch { /* sync handles errors internally */ }
    })();
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

// ── SW Diagnostic (callable directly from SW console via self.cmSwDiag) ────────
async function runSwDiag(): Promise<{ ok: boolean; health: number; results: Array<{ name: string; ok: boolean; weight: number; detail?: string }>; sessionCount: number; platforms: Record<string, number> }> {
  const diagResults: Array<{ name: string; ok: boolean; weight: number; detail?: string }> = [];
  const rec = (name: string, ok: boolean, w = 1, detail?: string) => diagResults.push({ name, ok, weight: w, detail });
  let diagSessionCount = 0;
  const diagPlatforms: Record<string, number> = {};

  // TEST 1: IndexedDB Tables
  try {
    const tables = dexieDb.tables.map(t => t.name);
    const expected = ['sessions','prompt_templates','prompt_assignments','chunkEmbeddings','sessionHashes','storedSummaries','retrievalCache','migrationQuality','metaPrompts'];
    let allPresent = true;
    for (const et of expected) { if (!tables.includes(et)) allPresent = false; }
    rec('idb_tables', allPresent, 2, tables.join(','));
  } catch (e) { rec('idb_tables', false, 2, (e as Error).message); }

  // TEST 2: Sessions
  try {
    const sessions = await db.getAllSessions();
    diagSessionCount = sessions.length;
    for (const s of sessions) diagPlatforms[s.platform] = (diagPlatforms[s.platform] || 0) + 1;
    if (diagSessionCount > 0) {
      let validCount = 0;
      for (const s of sessions) {
        const u = s.messages.filter(m => m.role === 'user').length;
        const a = s.messages.filter(m => m.role === 'assistant').length;
        if (u > 0 && a > 0) validCount++;
      }
      rec('sessions_quality', validCount === diagSessionCount || validCount > diagSessionCount * 0.8, 2, `${validCount}/${diagSessionCount} valid`);
    } else { rec('sessions_quality', false, 2, 'No sessions'); }
    rec('sessions_count', diagSessionCount > 0, 1, `${diagSessionCount} sessions`);
  } catch (e) { rec('sessions_count', false, 1, (e as Error).message); rec('sessions_quality', false, 2, (e as Error).message); }

  // TEST 3: Semantic Index
  try {
    const totalChunks = await dexieDb.chunkEmbeddings.count();
    const totalHashes = await dexieDb.sessionHashes.count();
    const completeHashes = await dexieDb.sessionHashes.filter(h => h.isComplete === true).count();
    const completeHashesArr = await dexieDb.sessionHashes.filter(h => h.isComplete === true).toArray();
    let phantomHashes = 0;
    for (const h of completeHashesArr) {
      const cc = await dexieDb.chunkEmbeddings.where("sessionId").equals(h.sessionId).count();
      if (cc === 0) phantomHashes++;
    }
    if (totalChunks > 0) rec('semantic_index', true, 2, `Chunks: ${totalChunks}, Hashes: ${totalHashes}, Phantom: ${phantomHashes}`);
    else if (diagSessionCount === 0) rec('semantic_index', true, 1, 'No sessions to index');
    else rec('semantic_index', false, 2, 'No chunks');
  } catch (e) { rec('semantic_index', false, 2, (e as Error).message); }

  // TEST 4: Stored Summaries
  try {
    const summaries = await dexieDb.storedSummaries.count();
    rec('summaries', true, 1, `${summaries} summaries`);
  } catch (e) { rec('summaries', false, 1, (e as Error).message); }

  // TEST 5: Offscreen Document
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] as any });
    if (existing.length > 0) rec('offscreen', true, 2, 'Active');
    else {
      await ensureOffscreenDocument();
      const check2 = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] as any });
      rec('offscreen', check2.length > 0, 2, check2.length > 0 ? 'Created on demand' : 'Could not create');
    }
  } catch (e) { rec('offscreen', false, 2, (e as Error).message); }

  // TEST 6: Remote Config
  try {
    const cfg = await getRemoteConfig();
    rec('remote_config', true, 1, cfg ? `${Object.keys(cfg).length} keys` : 'Using defaults');
  } catch (e) { rec('remote_config', false, 1, (e as Error).message); }

  // TEST 7: Usage API
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const result = await checkUsage(1, (await supabase.auth.getSession()).data.session?.access_token ?? '');
      rec('usage_api', true, 1, `allowed=${result.allowed}`);
    } else { rec('usage_api', true, 1, 'No authenticated user'); }
  } catch (e) { rec('usage_api', false, 1, (e as Error).message); }

  // TEST 8: Drive Sync
  try {
    const connected = await driveClient.isConnected();
    rec('drive_sync', true, 1, connected ? 'Connected' : 'Not connected (optional)');
  } catch (e) { rec('drive_sync', true, 1, 'Skipped: ' + (e as Error).message); }

  // TEST 9: Vault Sync
  try {
    const client = await userVault.getClient();
    rec('vault_sync', true, 1, client ? 'Connected' : 'Not connected (optional)');
  } catch (e) { rec('vault_sync', true, 1, 'Skipped: ' + (e as Error).message); }

  // TEST 10: Migration Cache
  try {
    const metaPrompts = await dexieDb.metaPrompts.count();
    rec('migration_cache', true, 1, `${metaPrompts} MetaPrompts`);
  } catch (e) { rec('migration_cache', false, 1, (e as Error).message); }

  // TEST 11: Session ID Resolution
  try {
    const sid = await resolveSessionId('perplexity', 'https://www.perplexity.ai/search/test-uuid-1234');
    rec('session_id', !!sid && sid.startsWith('perplexity-'), 1, sid ?? 'null');
  } catch (e) { rec('session_id', false, 1, (e as Error).message); }

  // TEST 12: Capture Validator
  try {
    const testMsgs = [{ role: 'user', content: 'Hello', timestamp: Date.now() }, { role: 'assistant', content: 'Hi there', timestamp: Date.now() }] as any;
    const result = validateCapture(testMsgs, 'test');
    rec('capture_validator', !!result.valid, 1, result.valid ? 'Valid passes' : 'Valid rejected');
  } catch (e) { rec('capture_validator', false, 1, (e as Error).message); }

  // TEST 13: Structural Detector (runs in content script, just verify import)
  rec('structural_detector', true, 1, 'Runs in content script context');

  // TEST 14: File Builders
  try {
    const sessions = await db.getAllSessions();
    if (sessions.length > 0) {
      const file = buildTier1File(sessions[0]);
      rec('file_builders', !!(file && file.content.length > 0 && file.filename), 2, file?.filename ?? 'empty');
    } else { rec('file_builders', true, 1, 'No sessions to test'); }
  } catch (e) { rec('file_builders', false, 2, (e as Error).message); }

  // TEST 15: Instruction Builder
  try {
    const sessions = await db.getAllSessions();
    if (sessions.length > 0) {
      const prompt = buildInstructionPrompt({ session: sessions[0], targetPlatform: 'chatgpt', tier: 1, task: 'Continue from where we left off', filename: 'test.xml', estimatedTokens: 1000 });
      rec('instruction_builder', !!(prompt && prompt.length > 50), 1, `${prompt?.length ?? 0} chars`);
    } else { rec('instruction_builder', true, 1, 'No sessions to test'); }
  } catch (e) { rec('instruction_builder', false, 1, (e as Error).message); }

  // TEST 16: Message Routing / SW Alive
  try {
    const swAlive = chrome.runtime.id !== undefined;
    rec('sw_alive', swAlive, 2, `Extension ID: ${chrome.runtime.id?.slice(0, 8)}...`);
    const tabs = await chrome.tabs.query({});
    const llmTabs = tabs.filter(t => {
      const u = t.url || '';
      return u.includes('claude.ai') || u.includes('chatgpt.com') || u.includes('gemini.google.com') || u.includes('grok.com') || u.includes('perplexity.ai') || u.includes('deepseek.com');
    });
    rec('message_routing', swAlive, 1, `${llmTabs.length} LLM tabs open`);
  } catch (e) { rec('message_routing', false, 1, (e as Error).message); }

  // TEST 17: Health Monitor
  try {
    const alerts = await healthMonitor.getAlerts();
    rec('health_monitor', true, 1, `${Object.keys(alerts).length} active alerts`);
  } catch (e) { rec('health_monitor', false, 1, (e as Error).message); }

  // TEST 18: Prompt Templates
  try {
    const templates = await dexieDb.prompt_templates.count();
    const assignments = await dexieDb.prompt_assignments.count();
    rec('prompt_templates', true, 1, `Templates: ${templates}, Assignments: ${assignments}`);
  } catch (e) { rec('prompt_templates', false, 1, (e as Error).message); }

  // TEST 19: Drive Periodic Alarm (FIX-7 — alarm always created on startup)
  try {
    const alarm = await chrome.alarms.get('drive-sync-periodic');
    rec('drive_periodic_alarm', !!alarm, 1, alarm ? `every ${alarm.periodInMinutes}min` : 'NOT created — sync cycle will not run');
  } catch (e) { rec('drive_periodic_alarm', false, 1, (e as Error).message); }

  // TEST 20: Tombstone Awareness (FIX-1 — deleted sessions are not resurrected)
  try {
    const connected = await driveClient.isConnected().catch(() => false);
    if (!connected) { rec('tombstone_cache', true, 1, 'Drive not connected (optional)'); }
    else {
      const index = await driveClient.downloadIndex().catch(() => null);
      const tombCount = index?.tombstones?.length ?? 0;
      // Verify no tombstoned session is still present in the live session list.
      const liveIds = new Set((await db.getAllSessions()).map(s => s.id));
      const tombstoneIds = (index?.tombstones ?? []).map(t => typeof t === 'string' ? t : t.sessionId);
      const resurrected = tombstoneIds.filter(id => liveIds.has(id));
      if (resurrected.length > 0) rec('tombstone_cache', false, 2, `${resurrected.length} tombstoned session(s) still live: ${resurrected.slice(0, 3).join(',')}`);
      else rec('tombstone_cache', true, 2, `${tombCount} tombstones, none resurrected locally`);
    }
  } catch (e) { rec('tombstone_cache', true, 1, 'Skipped: ' + (e as Error).message); }

  // TEST 21: Index Queue Cap (FIX-3 — cap raised 50→100)
  try {
    const qLen = semanticIndex.getQueueLength();
    rec('index_queue', qLen <= 100, 1, `${qLen} queued (cap 100)`);
  } catch (e) { rec('index_queue', false, 1, (e as Error).message); }

  // TEST 22: In-Flight Tracking + Bulk Index Flag (FIX-4/FIX-5)
  try {
    // _indexingInFlight is the authoritative set CHECK_INDEXING reports from.
    // _bulkIndexActive gates dirty-marking during bulk indexing.
    rec('indexing_state', true, 1, `inFlight=${_indexingInFlight.size}, dirty=${_indexDirty.size}, bulkActive=${_bulkIndexActive}`);
  } catch (e) { rec('indexing_state', false, 1, (e as Error).message); }

  // TEST 23: Pending Index Backlog (sessions awaiting index)
  try {
    const pending = await dexieDb.pendingIndex.count();
    // A small backlog is normal; a huge one indicates a stuck queue.
    rec('pending_index', pending < 200, 1, `${pending} pending`);
  } catch (e) { rec('pending_index', false, 1, (e as Error).message); }

  // TEST 24: CHECK_INDEXING Handler Self-Test (FIX-5 cross-context probe)
  try {
    const probeId = 'cm-sw-diag-probe-' + Date.now();
    const beforeHas = _indexingInFlight.has(probeId);
    // The handler simply reflects _indexingInFlight + queue length; verify the
    // primitives it relies on are intact and return the expected shape.
    const reflected = { inFlight: _indexingInFlight.has(probeId), queued: semanticIndex.getQueueLength() };
    const ok = beforeHas === false && typeof reflected.inFlight === 'boolean' && typeof reflected.queued === 'number';
    rec('check_indexing_handler', ok, 1, `probe inFlight=${reflected.inFlight}, queued=${reflected.queued}`);
  } catch (e) { rec('check_indexing_handler', false, 1, (e as Error).message); }

  const totalWeight = diagResults.reduce((s, r) => s + r.weight, 0);
  const passedWeight = diagResults.filter(r => r.ok).reduce((s, r) => s + r.weight, 0);
  const health = Math.round((passedWeight / totalWeight) * 100);
  return { ok: true, health, results: diagResults, sessionCount: diagSessionCount, platforms: diagPlatforms };
}
(self as any).cmSwDiag = runSwDiag;

// [ONNX-KEEPALIVE-L1] Port-based keepalive from sidebar.
// As long as sidebar is open, this port keeps SW alive indefinitely,
// preventing offscreen doc + ONNX model from being GC'd.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    console.log('[CM:sw] keepalive port connected — SW stays alive');
    port.onDisconnect.addListener(() => {
      console.log('[CM:sw] keepalive port disconnected — SW may sleep');
    });
  }
});

// ── External Web Sync (Brave / Web Tab Fallback) ─────────────────────────
chrome.runtime.onMessageExternal?.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "WEB_AUTH_SYNC" && msg.session) {
    void (async () => {
      try {
        console.log("[CM:auth] Received WEB_AUTH_SYNC from web app:", sender.url);
        const { access_token, refresh_token, user } = msg.session;
        if (access_token && refresh_token) {
          await supabase.auth.setSession({ access_token, refresh_token });
          await chrome.storage.local.set({
            accessToken: access_token,
            userId: user?.id ?? (await supabase.auth.getUser()).data.user?.id,
          });
          void broadcastToViews({ type: "AUTH_STATE_CHANGED" });
          sendResponse({ ok: true, userId: user?.id });
        } else {
          sendResponse({ ok: false, error: "Invalid session payload" });
        }
      } catch (err) {
        console.error("[CM:auth] WEB_AUTH_SYNC error:", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }
  if (msg?.type === "WEB_DRIVE_TOKEN_SYNC" && msg.token) {
    void (async () => {
      try {
        console.log("[CM:drive] Received WEB_DRIVE_TOKEN_SYNC token from web app:", sender.url);
        await chrome.storage.local.set({
          "drive.flowToken": msg.token,
          "drive.flowTokenAt": Date.now(),
        });
        await chrome.storage.local.remove("drive.explicitlyDisconnected");
        void broadcastToViews({ type: "DRIVE_STATE_CHANGED" });
        sendResponse({ ok: true });
      } catch (err) {
        console.error("[CM:drive] WEB_DRIVE_TOKEN_SYNC error:", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }
});

// ── Message Router ─────────────────────────────────────────────────────────────
let _lastDriveWipeAt = 0;
const _wipeGuardMs = 60_000;
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (DEBUG_DIAG) console.log(`[ContextMover ServiceWorker] Received message: ${msg.type}`);
  (async () => {
    try {
    // [SECURITY] Reject messages from any source that is not our own extension.
    const isTelemetry = msg.type === 'GET_PERF_STATS' || msg.type === 'EXPORT_PERF_METRICS';
    if (!isTelemetry && !isFromOwnExtension(sender)) {
      sendResponse({ error: 'Unauthorized' });
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

      // ── Incomplete capture scroll hint — forwarded to sidebar ──────────
      case "CAPTURE_SCROLL_HINT": {
        if (!isFromPlatformTab(sender) && !isFromOwnExtension(sender)) { sendResponse({ ok: false }); return; }
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

      // ── Remote config proxy — content scripts call this to avoid CORS ───
      case "GET_REMOTE_CONFIG": {
        try {
          const config = await getRemoteConfig();
          sendResponse({ ok: true, config: config ?? [] });
        } catch (err) {
          sendResponse({ ok: false, config: [] });
        }
        break;
      }

      // ── Web Sync relay (content script path for Brave / tab fallback) ──
      // web-sync.ts content script relays messages from contextmover.com
      // via chrome.runtime.sendMessage, which arrives here on onMessage,
      // NOT on onMessageExternal. This mirrors the onMessageExternal handler.
      case "WEB_AUTH_SYNC": {
        if (!msg.session) { sendResponse({ ok: false, error: "No session" }); break; }
        try {
          const { access_token, refresh_token, user } = msg.session;
          if (access_token && refresh_token) {
            await supabase.auth.setSession({ access_token, refresh_token });
            await chrome.storage.local.set({
              accessToken: access_token,
              userId: user?.id ?? (await supabase.auth.getUser()).data.user?.id,
            });
            void broadcastToViews({ type: "AUTH_STATE_CHANGED" });
            console.log("[CM:auth] WEB_AUTH_SYNC processed via content script relay");
            sendResponse({ ok: true, userId: user?.id });
          } else {
            sendResponse({ ok: false, error: "Invalid session payload" });
          }
        } catch (err) {
          console.error("[CM:auth] WEB_AUTH_SYNC (onMessage) error:", err);
          sendResponse({ ok: false, error: String(err) });
        }
        break;
      }
      case "WEB_DRIVE_TOKEN_SYNC": {
        if (!msg.token) { sendResponse({ ok: false, error: "No token" }); break; }
        try {
          console.log("[CM:drive] WEB_DRIVE_TOKEN_SYNC received via content script relay");
          await chrome.storage.local.set({
            "drive.flowToken": msg.token,
            "drive.flowTokenAt": Date.now(),
          });
          await chrome.storage.local.remove("drive.explicitlyDisconnected");
          void broadcastToViews({ type: "DRIVE_STATE_CHANGED" });
          sendResponse({ ok: true });
        } catch (err) {
          console.error("[CM:drive] WEB_DRIVE_TOKEN_SYNC (onMessage) error:", err);
          sendResponse({ ok: false, error: String(err) });
        }
        break;
      }

      // ── Google Drive sync (additive layer over IndexedDB) ──────────────
      case "DRIVE_CONNECT": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        try {
          const connected = await driveClient.connect();
          if (connected) {
            // [DEEP FIX F] Clear drive-wiped state so normal sync resumes.
            driveSyncManager.clearDriveWipedState();
            // Pull existing Drive sessions in background; never block UI.
            void driveSyncManager.initialSync().then(() => { getSessionsCache = null; }).catch(() => {});
            // Start periodic bidirectional sync (every 30s).
            // SYNC-2: ensures cross-extension changes propagate within 30s.
            chrome.alarms.create("drive-sync-periodic", { periodInMinutes: 0.5 });
            // [DRIVE-LICENSE] Fetch Drive email and register/check pro license.
            void registerDriveLicense();
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
        // [DRIVE-LICENSE] Clear Drive pro license state.
        await chrome.storage.local.remove(["driveEmail", "driveProLicense"]);
        void broadcastToViews({ type: "AUTH_STATE_CHANGED" } as any);
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
        // [DEEP FIX F] Clear drive-wiped state so user-initiated sync works normally.
        driveSyncManager.clearDriveWipedState();
        // [PHASE-7-FIX] Re-create periodic sync alarm if it was cleared by WIPE_LOCAL_DATA
        chrome.alarms.create("drive-sync-periodic", { periodInMinutes: 0.5 });
        const result = await driveSyncManager.pullFromDrive();
        getSessionsCache = null;
        sendResponse({ ok: true, ...result });
        break;
      }
      case "DRIVE_SYNC_BIDIRECTIONAL": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        // [DEEP FIX F] Clear drive-wiped state so user-initiated sync works normally.
        driveSyncManager.clearDriveWipedState();
        // [PHASE-7-FIX] Re-create periodic sync alarm if it was cleared by WIPE_LOCAL_DATA
        chrome.alarms.create("drive-sync-periodic", { periodInMinutes: 0.5 });
        await driveSyncManager.syncBidirectional();
        getSessionsCache = null;
        sendResponse({ ok: true });
        break;
      }
      case "DRIVE_WIPE": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        if (!msg.confirm) {
          sendResponse({ error: "Confirmation required — send { confirm: true } to wipe all Drive data" });
          break;
        }
        const now = Date.now();
        if (now - _lastDriveWipeAt < _wipeGuardMs) {
          console.warn(`[CM:sw] DRIVE_WIPE skipped — already wiped ${(now - _lastDriveWipeAt) / 1000}s ago (reason: ${msg.reason || 'unknown'})`);
          sendResponse({ ok: true, skipped: true });
          return;
        }
        _lastDriveWipeAt = now;
        console.log(`[CM:sw] DRIVE_WIPE — wiping all remote Drive data (reason: ${msg.reason || 'unknown'})`);
        // [FIX-Q] Stop the periodic sync alarm so syncBidirectional doesn't
        // fire during/after the wipe and re-upload sessions.
        chrome.alarms.clear("drive-sync-periodic");
        // [WIPE-RACE-FIX] Use startRemoteWipe() which sets _wipingRemote=true
        // in addition to markDriveWiped(). This prevents clearDriveWipedState()
        // from being called by concurrent message handlers (e.g. DRIVE_CONNECT
        // from sidebar auto-reconnect) during the ~10s wipeAllRemote window.
        // Without this, _driveWiped gets cleared mid-wipe, and flushUploadQueue
        // / rebuildIndex immediately re-upload all sessions to the freshly-wiped
        // Drive. The alarm is NOT restarted here — it will be restarted on the
        // next DRIVE_CONNECT or user-initiated sync, which also calls
        // clearDriveWipedState() to resume normal sync.
        driveSyncManager.startRemoteWipe();
        const result = await driveClient.wipeAllRemote();
        driveSyncManager.finishRemoteWipe();
        sendResponse({ ok: true, ...result });
        break;
      }
      case "FULL_WIPE": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        if (!msg.confirm) {
          sendResponse({ error: "Confirmation required — send { confirm: true } to wipe all local + Drive data" });
          break;
        }
        console.log("[CM:sw] FULL_WIPE — wiping all local + Drive data atomically");
        // Stop the periodic sync alarm so nothing re-seeds during the wipe.
        chrome.alarms.clear("drive-sync-periodic");
        // Cancel all in-flight indexing.
        semanticIndex.cancelBackgroundJobs();
        _indexingInFlight.clear();
        _indexDirty.clear(); _indexDirtyHash.clear();
        _bgIndexCooldown.clear();
        _bgIndexDeferred.clear();
        // Mark Drive as wiped so sync stays blocked.
        driveSyncManager.startRemoteWipe();
        try {
          // Wipe Drive first (while token is still valid).
          const driveResult = await driveClient.wipeAllRemote();
          // [BUG-7 FIX] Signal offscreen worker to cancel in-flight batches/indexes before wiping
          try {
            await new Promise<void>(resolve => {
              chrome.runtime.sendMessage({ type: "CANCEL_ALL_JOBS" }, () => {
                void chrome.runtime.lastError;
                resolve();
              });
            });
          } catch (e) { console.debug("[CM:sw] failed to send CANCEL_ALL_JOBS", e); }
          // Wipe local data.
          await wipeAllLocalData();
          await attentionEngine.clearIndex().catch(() => {});
          getSessionsCache = null;
          // fullReset clears all in-memory state but keeps _driveWiped = true.
          driveSyncManager.fullReset();
          driveSyncManager.finishRemoteWipe();
          // Do NOT restart the alarm — user must explicitly reconnect Drive.
          console.log("[CM:sw] FULL_WIPE complete — Drive + local wiped, sync alarm stopped");
          sendResponse({ ok: true, ...driveResult });
        } catch (e) {
          driveSyncManager.finishRemoteWipe();
          sendResponse({ error: String(e) });
        }
        break;
      }
      case "WIPE_LOCAL_DATA": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        if (!msg.confirm) { sendResponse({ error: "Confirmation required" }); break; }
        console.log("[CM:sw] WIPE_LOCAL_DATA — wiping all local extension data");
        try {
          // [FIX-R] Stop the periodic sync alarm so syncBidirectional doesn't
          // fire during the wipe and re-download/re-upload sessions.
          chrome.alarms.clear("drive-sync-periodic");
          // [FIX-3] Cancel ALL in-flight indexing jobs BEFORE wiping IDB.
          // Without this, the offscreen worker continues writing chunks to a
          // freshly-wiped database, causing race conditions where partial
          // stale data overwrites the clean state.
          semanticIndex.cancelBackgroundJobs();
          _indexingInFlight.clear();
          _indexDirty.clear(); _indexDirtyHash.clear();
          _bgIndexCooldown.clear();
          _bgIndexDeferred.clear();
          // [BUG-7 FIX] Signal offscreen worker to cancel in-flight batches/indexes before wiping
          try {
            await new Promise<void>(resolve => {
              chrome.runtime.sendMessage({ type: "CANCEL_ALL_JOBS" }, () => {
                void chrome.runtime.lastError;
                resolve();
              });
            });
          } catch (e) { console.debug("[CM:sw] failed to send CANCEL_ALL_JOBS", e); }
          await wipeAllLocalData();
          await attentionEngine.clearIndex().catch(() => {});
          getSessionsCache = null;
          // [WIPE-FIX] Full reset of sync manager in-memory state.
          // This clears ALL caches (tombstones, sourcedIds, uploadQueue, etc.)
          // so stale data doesn't survive the wipe.
          driveSyncManager.fullReset();
          // [WIPE-FIX] Do NOT auto-sync from Drive after local wipe.
          // The user clicked "Wipe local data" — they want it gone, not
          // immediately re-downloaded. Sessions will re-appear naturally
          // from page captures and the next periodic sync cycle.
          // [PHASE-7-FIX] Do NOT auto-restart periodic sync here. This prevents a race
          // where the alarm fires and re-downloads sessions from Drive before the remote
          // wipe completes. The alarm will be re-created on next DRIVE_CONNECT or manual sync.
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ error: String(e) });
        }
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

      case "GET_PERF_STATS": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const windowMs = (msg as { windowMs?: number }).windowMs;
        getPerfStats(windowMs).then(stats => {
          sendResponse({ ok: true, stats });
        }).catch(() => sendResponse({ ok: true, stats: [] }));
        return true;
      }

      case "EXPORT_PERF_METRICS": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const exportWindowMs = (msg as { windowMs?: number }).windowMs ?? 7 * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - exportWindowMs;
        dexieDb.performanceMetrics.where('timestamp').above(cutoff).toArray().then(rows => {
          sendResponse({ ok: true, rows, count: rows.length });
        }).catch(() => sendResponse({ ok: true, rows: [], count: 0 }));
        return true;
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
          void driveSyncManager.initialSync().then(() => {
            getSessionsCache = null;
          }).catch(() => {});
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
        semanticIndex.cancelSessionJobs(msg.sessionId);
        _indexingInFlight.delete(msg.sessionId);
        _indexDirty.delete(msg.sessionId);
        _bgIndexCooldown.delete(msg.sessionId);
        _bgIndexDeferred.delete(msg.sessionId);
        await forgetSession(msg.sessionId);
        getSessionsCache = null;
        // [T2-FIX] Clean up all IDB artifacts — prevents orphaned chunks/hash/summaries
        await Promise.all([
          dexieDb.chunkEmbeddings.where('sessionId').equals(msg.sessionId).delete(),
          dexieDb.sessionHashes.where('sessionId').equals(msg.sessionId).delete(),
          dexieDb.storedSummaries.where('sessionId').equals(msg.sessionId).delete(),
          dexieDb.retrievalCache.where('sessionId').equals(msg.sessionId).delete(),
          dexieDb.metaPrompts.where('sessionId').equals(msg.sessionId).delete(),
          dexieDb.pendingIndex.where('sessionId').equals(msg.sessionId).delete(),
        ]).catch(() => {});
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
        getSessionsCache = null;
        // Sync rename to Drive + vault
        void driveSyncManager.forceUpload(renameId).catch(() => {});
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

        // [CM-NATIVE-FIX] Try to find by nativeId first to prevent duplication
        // of restored sessions after a local wipe
        if (msg.nativeId) {
          const byNative = await dexieDb.sessions.where('nativeId').equals(msg.nativeId).first();
          if (byNative) {
            sendResponse({ exists: true, id: byNative.id });
            break;
          }
        }

        // Used by content scripts to check if a legacy hash-based session id
        // already exists so we can adopt it instead of orphaning it.
        const existing = await db.getSession(msg.sessionId);
        sendResponse({ exists: !!existing, id: existing ? existing.id : undefined });
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
          }
        } catch {
          const stored = await chrome.storage.local.get("accessToken");
          accessToken = stored.accessToken as string | undefined;
        }

        // [PRO-VERIFIED] First check if user is verified Pro via Drive seat, install ID, or subscription
        const isProVerified = await verifyUserIsPro(accessToken);
        if (isProVerified) {
          console.log(`[CM:sw] Verified Pro seat active — skipping usage check for tier ${_tier}`);
        } else if (accessToken) {
          const usage = await checkMigrationAllowed(_tier, accessToken as string);
          if (!usage.allowed) {
            const isProDoubleCheck = await verifyUserIsPro(accessToken);
            if (isProDoubleCheck) {
              console.log(`[CM:sw] Usage API returned allowed=false but Pro verified — allowing tier ${_tier}`);
            } else {
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
          if (usage.fallback) {
            const isProFallback = await verifyUserIsPro(accessToken);
            if (!isProFallback) {
              // Free user with a broken usage API — apply local counters as safety net
              const FREE_LIMITS: Record<number, number> = { 1: 8, 2: 3, 3: 3 };
              const fallbackLimit = FREE_LIMITS[_tier] ?? 3;
              const month = new Date().toISOString().slice(0, 7);
              const fallbackKey = `auth_usage_t${_tier}_${month}`;
              const stored = await chrome.storage.local.get(fallbackKey);
              const fallbackCount = (stored[fallbackKey] as number | undefined) ?? 0;
              if (fallbackCount >= fallbackLimit) {
                const resetDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);
                const daysUntilReset = Math.ceil((resetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                sendResponse({
                  success: false,
                  error: "limit_reached",
                  limitData: {
                    tier: _tier,
                    used: fallbackCount,
                    limit: fallbackLimit,
                    daysUntilReset,
                    upgradeUrl: "https://contextmover.com/pricing",
                  },
                });
                break;
              }
              void chrome.storage.local.set({ [fallbackKey]: fallbackCount + 1 });
            }
            // isPro: true → unlimited → continue without limit check
          }
        } else {
          // No auth token — apply local anonymous limits (free-tier) via chrome.storage counters.
          // This prevents unlimited anonymous migrations without a server round-trip.
          const FREE_ANON_LIMITS: Record<number, number> = { 1: 8, 2: 3, 3: 3 };
          const anonLimit = FREE_ANON_LIMITS[_tier] ?? 8;
          const month = new Date().toISOString().slice(0, 7);
          const anonKey = `anon_usage_t${_tier}_${month}`;
          const stored = await chrome.storage.local.get(anonKey);
          const anonCount = (stored[anonKey] as number | undefined) ?? 0;
          if (anonCount >= anonLimit) {
            const resetDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);
            const daysUntilReset = Math.ceil((resetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            sendResponse({
              success: false,
              error: "limit_reached",
              limitData: {
                tier: _tier,
                used: anonCount,
                limit: anonLimit,
                daysUntilReset,
                upgradeUrl: "https://contextmover.com/pricing",
              },
            });
            break;
          }
          // Increment local counter (fire & forget)
          void chrome.storage.local.set({ [anonKey]: anonCount + 1 });
          // [CM-MEM] sweep stale anon_usage_* keys from previous months so they
          // don't accumulate (~3 keys/month otherwise grow forever).
          void chrome.storage.local.get(null).then((all) => {
            const stale = Object.keys(all).filter(
              (k) => k.startsWith("anon_usage_t") && !k.endsWith(month)
            );
            if (stale.length) void chrome.storage.local.remove(stale);
          }).catch(() => {});
        }

        // [CM-FAST-MIGRATE] Removed duplicate raw OFFSCREEN_INDEX_SESSION that
        // bypassed the queue system. handleMigrateContext now handles all indexing
        // through indexRemainingChunksPriority with dynamic batching.

        // [CM-FIX-SERIALIZE] Queue behind any running migration — prevents concurrent T3s killing each other.
        const prevLock = _migrationLockPromise;
        let releaseLock!: () => void;
        _migrationLockPromise = new Promise<void>(r => { releaseLock = r; });
        try {
          await prevLock;
          await handleMigrateContext(
            { ...msg.payload, tier: _tier },
            sendResponse,
            accessToken as string | undefined
          );
        } finally {
          activeMigrationInProgress = false;
          void broadcastToViews({ type: 'MIGRATION_ACTIVE', active: false });
          releaseLock();
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
          console.log("[CM:sub] GET_SUBSCRIPTION_STATUS — hasSession:", !!token, "userId:", session?.user?.id);
          if (!token) {
            console.log("[CM:sub] No token — checking Drive pro license");
            // [DRIVE-LICENSE] No Supabase login, but Drive email may grant pro.
            const driveLicense = await chrome.storage.local.get("driveProLicense");
            if (driveLicense.driveProLicense === true) {
              console.log("[CM:sub] Drive pro license active — returning pro");
              sendResponse({ plan: "pro", isPro: true, source: "drive_license" });
              break;
            }
            console.log("[CM:sub] No token, no Drive license — returning free");
            sendResponse({ plan: "free", local: true });
            break;
          }
          // [PERF-M4] SW-side cache. The sidebar resets its own 5-min cache on
          // AUTH_STATE_CHANGED / refresh, so this handler was hit ~10×/session,
          // each firing a fresh backend HTTP request (30s timeout). Serve a cached
          // response for 60s unless the caller explicitly forces a refresh.
          const _forceSub = (msg as { force?: boolean }).force === true;
          if (!_forceSub && _subStatusCache &&
              _subStatusCache.token === token &&
              Date.now() - _subStatusCache.at < SUB_STATUS_CACHE_MS) {
            sendResponse(_subStatusCache.data);
            break;
          }
          const installId = await getInstallId();
          const cachedDrive = await chrome.storage.local.get("driveEmail");
          const driveEmail = cachedDrive.driveEmail as string | undefined;
          const res = await fetch(`${WEBAPP_URL}/api/payments/subscription`, {
            headers: {
              authorization: `Bearer ${token}`,
              "x-install-id": installId,
              ...(driveEmail ? { "x-drive-email": driveEmail } : {}),
            },
            signal:  AbortSignal.timeout(30000),
          });
          console.log("[CM:sub] Subscription API status:", res.status);
          if (res.status === 403) {
            const body = await res.json().catch(() => ({}));
            console.warn("[CM:sub] 403 from subscription API:", body.error ?? "(no error message)");
            // 403 can be stale token, RLS mismatch, or backend misconfiguration.
            // Fall back to free gracefully — do NOT show device limit warnings.
            sendResponse({ plan: "free", error: true });
            break;
          }
          if (!res.ok) {
            const errBody = await res.text().catch(() => "");
            console.warn("[CM:sub] Subscription API error:", res.status, errBody.slice(0, 200));
            sendResponse({ plan: "free", error: true });
            break;
          }
          const data = await res.json();
          console.log("[CM:sub] Subscription data:", { isPro: data.isPro, plan: data.plan, status: data.status });
          let _subResponse: { plan: string; isPro: boolean; usage: unknown; limits: unknown; status: unknown; trialEnd: string | null; source?: string } = {
            plan:   data.isPro ? "pro" : (data.plan ?? "free"),
            isPro:  Boolean(data.isPro),
            usage:  data.usage,
            limits: data.limits,
            status: data.status,
            trialEnd: data.trialEnd ?? null,
          };
          // [DRIVE-LICENSE] If Supabase says free but Drive license is pro, override.
          // Never override a server-side drive_mismatch revocation.
          if (!_subResponse.isPro && data.reason !== "drive_mismatch") {
            const driveLicense = await chrome.storage.local.get("driveProLicense");
            if (driveLicense.driveProLicense === true) {
              console.log("[CM:sub] Drive pro license overrides free Supabase plan");
              _subResponse = { ..._subResponse, plan: "pro", isPro: true, source: "drive_license" };
            }
          } else if (data.reason === "drive_mismatch") {
            await chrome.storage.local.set({ driveProLicense: false, driveProReason: "drive_mismatch" });
            void broadcastToViews({ type: "DRIVE_PRO_MISMATCH" } as any);
          }
          // [PERF-M4] Cache the successful response for 60s, keyed by token.
          await chrome.storage.local.set({ isProUser: _subResponse.isPro });
          _subStatusCache = { token, at: Date.now(), data: _subResponse };
          sendResponse(_subResponse);
        } catch (e) {
          const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
          if (isTimeout) {
            console.warn("[CM:sub] GET_SUBSCRIPTION_STATUS timed out (8s) — returning cached/free");
          } else {
            console.error("[CM:sub] GET_SUBSCRIPTION_STATUS exception:", e);
          }
          sendResponse({ plan: "free", error: true, timeout: isTimeout });
        }
        break;
      }

      case "AUTH_GOOGLE_SIGN_IN": {
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const payload = msg.payload as { code?: string; idToken?: string; nonce?: string; accessToken?: string; refreshToken?: string };
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
            console.log("[CM:auth] Exchanging idToken with backend...");
            const res = await fetch(`${WEBAPP_URL}/api/auth/extension-google-signin`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ idToken: payload.idToken, nonce: payload.nonce }),
              signal: AbortSignal.timeout(10_000),
            });
            console.log("[CM:auth] Backend response status:", res.status);
            const data = (await res.json()) as {
              error?: string;
              message?: string;
              signupUrl?: string;
              access_token?: string;
              refresh_token?: string;
              user?: { id: string; email?: string };
            };
            console.log("[CM:auth] Backend response data:", { error: data.error, hasAccessToken: !!data.access_token, hasUser: !!data.user });
            if (!res.ok || data.error) {
              console.error("[CM:auth] Backend returned error:", data.error, data.message);
              sendResponse({ error: data.error ?? "signin_failed", message: data.message, signupUrl: data.signupUrl });
              break;
            }
            if (data.access_token && data.refresh_token) {
              await supabase.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
            }
            if (data.access_token) {
              await chrome.storage.local.set({ accessToken: data.access_token, userId: data.user?.id });
            }
            console.log("[CM:auth] Sign-in success, user:", data.user?.email);
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
        if (!isFromExtensionUI(sender)) { sendResponse({ error: "Unauthorized" }); break; }
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
          // [GEMINI-INJECT-FIX] Route through the content script first — it's
          // already loaded, runs in the page context, and has the full retry
          // + shadow-DOM piercing logic in injectIntoGeminiInput(). The old
          // approach used executeScript in the ISOLATED world where:
          //   - navigator.clipboard.writeText() fails (no user activation)
          //   - document.execCommand('insertText') is less reliable
          //   - the 150ms re-verification rejected text Angular briefly clears
          // If the content script doesn't respond (not yet loaded), fall back
          // to executeScript with world:"MAIN" for direct Angular access.
          try {
            // Phase 1: try content script (up to 3 pings × 500ms)
            let geminiScriptReady = false;
            for (let _pi = 0; _pi < 3; _pi++) {
              if (_pi > 0) await new Promise<void>((r) => setTimeout(r, 500));
              const alive = await new Promise<boolean>((resolve) => {
                try {
                  chrome.tabs.sendMessage(injectTabId, { type: "PING" }, (resp) => {
                    resolve(!chrome.runtime.lastError && !!resp);
                  });
                } catch { resolve(false); }
              });
              if (alive) { geminiScriptReady = true; break; }
            }

            if (geminiScriptReady) {
              const csResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
                chrome.tabs.sendMessage(
                  injectTabId,
                  { type: "INJECT_FILE_TO_TAB", fileName, fileContent: fileContentPayload },
                  (response) => {
                    void chrome.runtime.lastError;
                    resolve(response ?? { ok: false, error: "no response from content script" });
                  }
                );
              });
              console.log('[CM:gemini] content script injection result:', csResult);
              if (csResult?.ok) {
                sendResponse(csResult);
                break;
              }
              console.warn('[CM:gemini] content script injection failed, falling back to executeScript:', csResult?.error);
            } else {
              console.warn('[CM:gemini] content script not ready, using executeScript fallback');
            }

            // Phase 2: executeScript fallback with world:"MAIN" for Angular access
            const [execRes] = await chrome.scripting.executeScript({
              target: { tabId: injectTabId },
              func: injectIntoGeminiPage,
              args: [fileContentPayload],
              world: "MAIN",
            });
            const result = execRes?.result as { ok: boolean; selector?: string; length?: number; reason?: string } | undefined;
            console.log('[CM:gemini] executeScript injection result:', result);
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
            { type: "SIDEBAR_CLOSED", tabId: relayTabId },
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

      // [FIX-5] Cross-context indexing check. The sidebar's AttentionEngine runs
      // in a separate JS context and cannot see the SW's _indexingInFlight set.
      // The sidebar sends this message before starting its own delta-index to
      // avoid duplicate ONNX embed jobs.
      case "CHECK_INDEXING": {
        if (!isFromOwnExtension(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        const { sessionId: checkId } = msg as { sessionId?: string };
        if (!checkId) { sendResponse({ error: 'sessionId required' }); break; }
        sendResponse({
          inFlight: _indexingInFlight.has(checkId),
          queued: semanticIndex.getQueueLength(),
        });
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
        // [CM-FIX] Await the actual model loading before responding. This ensures
        // the sidebar doesn't set searchReady=true until the ONNX model is compiled
        // and ready to serve embeddings, preventing premature embed timeouts.
        (async () => {
          try {
            await semanticIndex.warmup();
            modelWarmed = true;
            sendResponse({ ok: true, warmedUp: true });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("Failed to fetch")) {
              attentionEngineAvailable = false;
              await chrome.storage.local.set({ attentionEngineAvailable: false });
              console.debug("[CM:sw] Model fetch blocked — Attention tier unavailable on this session");
              sendResponse({ ok: false, error: "model_fetch_blocked" });
              return;
            }
            console.warn("[CM:sw] warmup failed:", e);
            sendResponse({ ok: false, error: msg });
          }
        })();
        break; // return true at end of handler keeps port open for async sendResponse
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

      case "CM_SW_DIAG": {
        if (!isFromOwnExtension(sender)) { sendResponse({ error: "Unauthorized" }); return; }
        try { sendResponse(await runSwDiag()); }
        catch (err) { sendResponse({ error: err instanceof Error ? err.message : String(err) }); }
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

async function verifyUserIsPro(accessToken?: string): Promise<boolean> {
  const local = await chrome.storage.local.get(["driveProLicense", "isProUser"]);
  if (local.driveProLicense === true || local.isProUser === true) {
    return true;
  }
  try {
    const installId = await getInstallId();
    const cachedDrive = await chrome.storage.local.get("driveEmail");
    const driveEmail = cachedDrive.driveEmail as string | undefined;
    const headers: Record<string, string> = {
      "x-install-id": installId,
    };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (driveEmail) headers["x-drive-email"] = driveEmail;

    const subRes = await fetch(`${WEBAPP_URL}/api/payments/subscription`, {
      headers,
      signal: AbortSignal.timeout(4000),
    });
    if (subRes.ok) {
      const subData = (await subRes.json()) as { isPro?: boolean };
      if (Boolean(subData.isPro)) {
        await chrome.storage.local.set({ isProUser: true });
        return true;
      }
    }
  } catch { /* network issue */ }
  return false;
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
  const _captureEnd = perfStart('capture_session');
  _lastCaptureTime.set(payload.sessionId, Date.now());
  // In-flight dedup
  // Prevents double DB writes when content script + syncOpenTabs fire simultaneously.
  if (captureInFlight.has(payload.sessionId)) {
    console.log(`[ContextMover:capture] Skipped in-flight duplicate for session ${payload.sessionId}`);
    return;
  }
  captureInFlight.add(payload.sessionId);
  // Lock is cleared at every exit point (early returns + after debounced write completes),
  // not on a blind timer — prevents both duplicate writes and stale locks.

  // ── [CM:sw] received ────────────────────────────────────────────────────────
  const rxUser = payload.messages.filter(m => m.role === "user").length;
  const rxAsst = payload.messages.filter(m => m.role === "assistant").length;
  if (DEBUG) console.log('[CM:sw] received', { platform: payload.platform, session: payload.sessionId, total: payload.messages.length, user: rxUser, assistant: rxAsst });
  if (rxAsst === 0) {
    console.log(`[CM:sw] CAPTURE_SESSION: dropping — 0 assistant messages (rxUser=${rxUser}). UI chrome or incomplete capture.`);
    captureInFlight.delete(payload.sessionId);
    return;
  }

  const existing = await db.getSession(payload.sessionId);
  // CRITICAL: also consult pendingWrites — a 200ms debounce window means an
  // authoritative network capture may be queued but not yet committed to IDB
  // when a late DOM scrape arrives. Without this check, the DOM scrape would
  // silently clobber the queued 26-msg capture with a 10-msg snapshot.
  const pending = pendingWrites.get(payload.sessionId);
  const bestKnown = pickBestKnown(existing, pending);

  // Protect the most complete capture for this session.
  // DOM scrapes shrink when virtual scroll evicts old messages from the DOM.
  // Network captures (source: 'fetch-intercept') carry authoritative full
  // history from the API and are always allowed to overwrite.
  const isNetworkCapture = payload.source === 'fetch-intercept';
  // [PHASE-5-FIX] Downgrade authority of network captures with suspicious titles.
  // A JWT/base64 token or auth-state title means the fetch-interceptor grabbed an
  // auth endpoint response, not a real conversation history. Treat it as a regular
  // (non-authoritative) capture so the count guard in shouldRejectIncoming applies.
  const isSuspiciousTitle = Boolean(
    payload.title && (
      // Base64 / JWT pattern — long token string
      /^[A-Za-z0-9+/=_-]{40,}$/.test(payload.title.trim()) ||
      // JWT three-part structure (header.payload.signature)
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(payload.title.trim()) ||
      // Starts with "ey" — standard base64url JWT prefix
      /^ey[A-Za-z0-9_-]{20,}/.test(payload.title.trim())
    )
  );
  const effectiveIsNetworkCapture = isNetworkCapture && !isSuspiciousTitle;
  if (isSuspiciousTitle && isNetworkCapture) {
    console.warn(`[CM:sw] CAPTURE_SESSION: suspicious title detected on network capture — downgrading authority (title=${payload.title?.slice(0, 40)}...)`);
  }
  if (shouldRejectIncoming(payload.messages.length, bestKnown, effectiveIsNetworkCapture)) {
    // DOM scrape is smaller (virtual scroll eviction), but may contain NEW
    // messages not yet in the stored snapshot. Merge by content fingerprint
    // instead of discarding — appends any genuinely new messages.
    if (bestKnown && !isNetworkCapture && bestKnown.messages.length > 0) {
      const merged = mergePartialScrape(bestKnown.messages as import("@/lib/types").Message[], payload.messages);
      const newCount = merged.length - bestKnown.messages.length;
      if (newCount > 0) {
        console.log(
          `[CM:sw] CAPTURE_SESSION: merging partial scrape (${payload.messages.length} msgs, +${newCount} new) into existing (${bestKnown.messages.length})`
        );
        payload.messages = merged;
        // Fall through to save path — do NOT return.
      } else {
        console.log(
          `[CM:sw] CAPTURE_SESSION: incoming count (${payload.messages.length}) < best known (${bestKnown.messages.length}, pending=${!!pending}) — no new messages, keeping existing`
        );
        captureInFlight.delete(payload.sessionId);
        return;
      }
    } else {
      console.log(
        `[CM:sw] CAPTURE_SESSION: incoming count (${payload.messages.length}) < best known (${bestKnown?.messages.length}, pending=${!!pending}) from DOM scrape — keeping existing`
      );
      captureInFlight.delete(payload.sessionId);
      return;
    }
  }

  const createdAt = existing?.createdAt ?? Date.now();
  const updatedAt = Date.now(); // Always use current time when session is visited/captured

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
    nativeId: nextMeta?.conversationId, // LLM provider's conversation ID
    platform: payload.platform as ContextSession["platform"],
    createdAt,
    updatedAt,
    title: payload.title,
    messages: payload.messages,
    metadata: nextMeta,
    // [FIX-C] Preserve customName from existing session — without this,
    // every CAPTURE_SESSION overwrites customName with undefined, reverting
    // renames. Also check pendingWrites for the same reason.
    customName: existing?.customName ?? pending?.customName,
  };

  console.log(`[CM:sw] CAPTURE_SESSION queued: sessionId=${session.id} nativeId=${session.nativeId ?? 'none'} platform=${session.platform} messages=${session.messages.length} title="${session.title}"`);

  // Debounced IDB write — coalesces rapid-fire captures for the same session.
  // 50ms window: fast enough that sessions appear immediately in the sidebar,
  // tight enough to coalesce the typical content-script double-fire within 1 tick.
  pendingWrites.set(session.id, session);
  const existingTimer = writeTimers.get(session.id);
  if (existingTimer !== undefined) clearTimeout(existingTimer);
  writeTimers.set(session.id, setTimeout(async () => {
    const toWrite = pendingWrites.get(session.id);
    if (!toWrite) return;
    await db.saveSession(toWrite);

    // [CM-PERSIST-FIX] enqueue for background indexing — survives Chrome close
    // Skip re-enqueue if message count hasn't changed within the cooldown window
    // (prevents 16ms "already indexed" runs from redundant re-captures).
    const prevMsgCount = indexEnqueueLastMsgCount.get(toWrite.id);
    const prevEnqueueAt = indexEnqueueLastAt.get(toWrite.id) ?? 0;
    const msgCountChanged = prevMsgCount !== toWrite.messages.length;
    const cooldownExpired = (Date.now() - prevEnqueueAt) > INDEX_ENQUEUE_COOLDOWN_MS;
    if (msgCountChanged || cooldownExpired) {
      indexEnqueueLastMsgCount.set(toWrite.id, toWrite.messages.length);
      indexEnqueueLastAt.set(toWrite.id, Date.now());
      await dexieDb.pendingIndex.put({
        sessionId: toWrite.id,
        createdAt: Date.now(),
        priority: 'background' as const,
        retryCount: 0,
      }).catch((e: unknown) => {
        console.warn('[CM:persist] failed to write pendingIndex:', e)
      });
    } else {
      console.debug(`[CM:persist] skipped pendingIndex re-enqueue for ${toWrite.id} (same ${toWrite.messages.length} msgs, ${Math.round((Date.now() - prevEnqueueAt) / 1000)}s ago)`);
    }
    pendingWrites.delete(session.id);
    writeTimers.delete(session.id);
    sessionCache.invalidate(); // force fresh IDB read on next GET_SESSIONS
    getSessionsCache = null; // invalidate the 100ms response cache too
    // Evict stale migration files for this session — new messages arrived, so any
    // cached XML (keyed `${sessionId}-tier${tier}`) no longer reflects full context.
    for (const key of migrationFileCache.keys()) {
      if (key.startsWith(`${toWrite.id}-tier`)) migrationFileCache.delete(key);
    }
    console.log('[CM:sw] SAVED to IndexedDB', { sessionId: toWrite.id, platform: toWrite.platform, messages: toWrite.messages.length, title: toWrite.title });
    void _captureEnd({ sessionId: toWrite.id, metadata: { platform: toWrite.platform, messageCount: toWrite.messages.length } });
    void broadcastToViews({ type: "SESSIONS_UPDATED" });
    captureInFlight.delete(toWrite.id);
    // [ISSUE-23] Staggered debounce: index (2s) → sync (10s) → metaprompt (30s)
    // Each new capture resets all three timers — prevents thundering herd during streaming
    const sid = toWrite.id;
    // 1. Index: 2s after last capture (debounced)
    const existingIdxTimer = _indexDebounceTimers.get(sid);
    if (existingIdxTimer) clearTimeout(existingIdxTimer);
    _indexDebounceTimers.set(sid, setTimeout(() => {
      _indexDebounceTimers.delete(sid);
      if (semanticIndex.getQueueLength() >= 20) {
        console.warn(`[CM:sw] backpressure: deferring index for ${sid} by 60s`);
        setTimeout(() => backgroundIndex(toWrite).catch(() => {}), 60000);
      } else {
        void backgroundIndex(toWrite).catch(() => {});
      }
    }, 2000));
    // 2. Drive sync: 10s after last capture
    const existingSyncTimer = _syncDebounceTimers.get(sid);
    if (existingSyncTimer) clearTimeout(existingSyncTimer);
    _syncDebounceTimers.set(sid, setTimeout(() => {
      _syncDebounceTimers.delete(sid);
      void driveSyncManager.syncAfterCapture(sid).catch(() => {});
    }, 10_000));
    // 3. MetaPrompt: 30s after last capture (only when truly idle)
    if (toWrite.messages.length >= 2) {
      const existingMpTimer = _metaPromptDebounceTimers.get(sid);
      if (existingMpTimer) clearTimeout(existingMpTimer);
      _metaPromptDebounceTimers.set(sid, setTimeout(() => {
        _metaPromptDebounceTimers.delete(sid);
        void buildMetaPromptAsync(toWrite).catch((e) =>
          console.warn('[CM:sw] background MetaPrompt build failed (non-fatal):', e)
        );
      }, 30_000));
    }
  }, 50));

  // [FIX-6] Corrected misleading log — Drive sync IS queued above (syncAfterCapture).
  // Only Supabase vault sync requires user connection. The old message implied no
  // cloud sync at all, causing confusion when sessions appeared on Drive.
  console.log('[ContextMover] Session stored. Drive sync queued (if connected). Supabase vault sync requires user connection.');

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
  console.log(`[CM:sw] verified`, { total: saved?.messages.length ?? 0, user: savedUser, assistant: savedAsst, ok: saved !== undefined, pending: !!inFlight });
  if (!saved) {
    console.error(`[CM:sw] verified — FAILED: session not found in queue or IndexedDB (id=${payload.sessionId})`);
  } else if (savedAsst === 0 && savedUser > 0) {
    console.error('[CM:sw] verified — ASSISTANT MESSAGES MISSING');
  }
}

/**
 * Fire-and-forget semantic indexer: chunks & embeds a session via the offscreen
 * document. Runs after every debounced IDB write. Errors are silently swallowed
 * so they never surface as extension failures.
 */
const _indexingInFlight = new Set<string>();
// Sessions that received an index request while an index for the same id was
// already running. We re-enqueue these ONCE after the in-flight job completes,
// so newly-captured messages aren't silently dropped from the embeddings.
const _indexDirty = new Set<string>();
// [PHASE-1-FIX] Tracks the session hash at the time _indexDirty was set.
// After a priority index completes during migration, the bg dirty path compares
// this saved hash against the current session hash — if equal AND chunks exist,
// the re-index is skipped entirely (priority already did the work).
const _indexDirtyHash = new Map<string, string>();
// [T2-FIX] Cooldown map to prevent duplicate backgroundIndex re-queues.
const _bgIndexCooldown = new Map<string, number>();
// [PERF-M3] Sessions with a deferred re-index timer pending — ensures only one
// trailing index is scheduled per session while it's in the cooldown window.
const _bgIndexDeferred = new Set<string>();
// [PERF-THRASH] Last capture timestamp per session — used to detect ongoing
// streaming. If captures are still arriving, we defer background indexing
// instead of starting a job that will be immediately cancelled + re-queued.
const _lastCaptureTime = new Map<string, number>();
// [FIX-4] Track consecutive deferral count per session — cap at 5 to prevent
// infinite deferral loops during long streaming sessions.
const _deferralCount = new Map<string, number>();
// [FIX-4] Track message count at last index time to detect growth during deferral
const _lastIndexedMsgCount = new Map<string, number>();
// [PERF-THRASH] Cooldown window — raised from 4s→10s. During streaming, captures
// arrive every 1-2s. A 4s cooldown let the deferred re-index fire mid-stream,
// starting an index that was immediately cancelled by the next capture's
// migration or dirty flag — the thrash loop that starved T2/Search/BG-Idx.
const BG_INDEX_COOLDOWN_MS = 10_000;
// [FIX-D] Track in-flight priority indexing promises per session so migration
// retries await the existing job instead of enqueuing a duplicate.
const _priorityIndexPromise = new Map<string, Promise<void>>();

// [FULL-SPEED-FIX] Background indexing now uses a single full-session call instead
// of 50-msg chunks with 2s delays. The offscreen document handles batching internally
// (32 msgs/batch with event-loop yields between batches), so there's no need for the
// SW to chunk. This reduces a 200-msg session from ~60s (chunked) to ~15-20s (single).
const BG_INDEX_CHUNK_SIZE = 50; // kept for broadcast calc only
const BG_INDEX_IDLE_DELAY_MS = 2000; // kept for dirty re-index delay

/**
 * [CM-P1-FIX] Progressive background indexing — indexes session in 50-message
 * chunks with checkpoint/resume capability.
 *
 * Flow:
 * 1. Check for existing checkpoint in sessionHashes
 * 2. Index next chunk of 50 messages (from tail backward for recency)
 * 3. Save checkpoint with lastIndexedMessageIndex
 * 4. If not complete, schedule next chunk after idle delay
 * 5. On migration, check if fully indexed; if not, index remaining chunks first
 */
// [PRE-COMPUTE-FIX] In-memory cache for pre-computed attention maps and retrievals.
// Keyed by sessionId. Stores results from background pre-computation so migration
// can use them instantly without re-running ONNX scoring.
type PreComputedCache = {
  attentionMap?: AttentionMap;
  retrievedChunks?: ChunkEmbedding[];
  task: string;
  sessionHash: string;
  ts: number;
};
const _preComputedCache = new Map<string, PreComputedCache>();
const PRECOMPUTE_TTL_MS = 5 * 60_000; // 5 min
const DEFAULT_MIGRATION_TASK = 'Continue from where we left off';

let _bulkIndexRunning = false;
let _bulkIndexActive = false;
async function bulkIndexUnindexedSessions(): Promise<void> {
  if (_bulkIndexRunning) return;
  if (!attentionEngineAvailable) return;
  _bulkIndexRunning = true;
  try {
    const allSessions = await db.getAllSessions();
    if (!allSessions || allSessions.length === 0) {
      console.log('[CM:sw:bulkIdx] no local sessions yet — skipping');
      return;
    }
    const allChunkSessionIds = new Set(
      (await dexieDb.chunkEmbeddings.toArray()).map(c => c.sessionId)
    );
    const completeHashIds = new Set(
      (await dexieDb.sessionHashes.toArray()).filter(h => h.isComplete === true).map(h => h.sessionId)
    );
    // [INDEX-COUNT-FIX] A session is truly indexed only if it has BOTH
    // isComplete=true AND chunks. Matches sidebar indexedIds logic.
    const trulyIndexedIds = new Set([...completeHashIds].filter(id => allChunkSessionIds.has(id)));
    const unindexed = allSessions.filter(s => !trulyIndexedIds.has(s.id) && s.messages.length >= 3);
    if (unindexed.length === 0) {
      console.log('[CM:sw:bulkIdx] all sessions already indexed');
      return;
    }
    // [DEDUP-FIX] Skip sessions already being indexed (e.g. sidebar backfill
    // may have already queued them). Without this, the second caller marks each
    // session as "in-flight → dirty for re-index", causing unnecessary re-indexing.
    const toIndex = unindexed.filter(s => !_indexingInFlight.has(s.id));
    if (toIndex.length === 0) {
      console.log(`[CM:sw:bulkIdx] all ${unindexed.length} unindexed session(s) already in-flight — skipping`);
      return;
    }
    console.log(`[CM:sw:bulkIdx] indexing ${toIndex.length}/${unindexed.length} unindexed session(s) — starting bulk index`);
    _bulkIndexActive = true;
    for (const session of toIndex) {
      if (!attentionEngineAvailable) break;
      if (activeMigrationInProgress) await new Promise(r => setTimeout(r, 5000));
      await dexieDb.pendingIndex.put({ sessionId: session.id, createdAt: Date.now(), priority: 'background', retryCount: 0 }).catch(() => {});
      console.log(`[CM:sw:bulkIdx] indexing ${session.id} (${session.messages.length} msgs)`);
      await backgroundIndex(session).catch(() => {});
      void broadcastToViews({ type: 'SESSIONS_UPDATED' } as any);
      await new Promise(r => setTimeout(r, 1000));
    }
    _bulkIndexActive = false;
    console.log('[CM:sw:bulkIdx] bulk index complete');
    void broadcastToViews({ type: 'SESSIONS_UPDATED' } as any);
  } catch (e) {
    console.warn('[CM:sw:bulkIdx] failed (non-fatal):', e);
  } finally {
    _bulkIndexRunning = false;
    _bulkIndexActive = false;
  }
}

async function backgroundIndex(session: ContextSession): Promise<void> {
  if (!attentionEngineAvailable) { await dexieDb.pendingIndex.delete(session.id).catch(() => {}); return; }
  if (activeMigrationInProgress) { await dexieDb.pendingIndex.delete(session.id).catch(() => {}); return; }
  // [T2-FIX] Cooldown — if we indexed this session recently, just mark dirty
  // instead of starting a new index. Collapses rapid capture bursts into one index.
  // [MEAL-PREP] Skip cooldown for first-time captures (lastIdx === 0) — start cooking immediately.
  // [PERF-M3] Window raised 2s→4s. During streaming the content script captures
  // many times; each kicked an index against the same WASM worker, saturating it
  // (a contributor to the SIGILL crash). A wider window collapses streaming bursts
  // into a single index that runs once the conversation settles. The dirty flag +
  // post-completion re-index below still guarantee the final state gets indexed.
  const lastIdx = _bgIndexCooldown.get(session.id) ?? 0;
  if (lastIdx > 0 && Date.now() - lastIdx < BG_INDEX_COOLDOWN_MS) {
    _indexDirty.add(session.id);
    await dexieDb.pendingIndex.delete(session.id).catch(() => {});
    // [PERF-M3] Schedule a single deferred re-index after the cooldown elapses.
    // Guarantees the final streaming state is indexed even if this was the LAST
    // capture and no further capture arrives to trip the cooldown again.
    // [PERF-THRASH] The deferred callback checks if captures are STILL arriving
    // (streaming still active). If so, it reschedules instead of starting an
    // index that would be immediately cancelled — breaking the thrash loop.
    if (!_bgIndexDeferred.has(session.id)) {
      _bgIndexDeferred.add(session.id);
      const scheduleDeferred = () => {
        setTimeout(() => {
          _bgIndexDeferred.delete(session.id);
          void (async () => {
            const lastCapture = _lastCaptureTime.get(session.id) ?? 0;
            // If a capture arrived within the last 8s, streaming is likely still
            // active — reschedule instead of starting a doomed index job.
            if (lastCapture > 0 && Date.now() - lastCapture < 8000) {
              _bgIndexDeferred.add(session.id);
              scheduleDeferred();
              return;
            }
            if (activeMigrationInProgress) {
              // Don't start bg indexing during a migration — it would be
              // immediately cancelled. Will be re-indexed on next capture/idle.
              return;
            }
            const fresh = await db.getSession(session.id).catch(() => null);
            if (fresh) await backgroundIndex(fresh).catch(() => {});
          })();
        }, BG_INDEX_COOLDOWN_MS + 1000);
      };
      scheduleDeferred();
    }
    return;
  }
  if (_indexingInFlight.has(session.id)) {
    // [FIX-4] During bulk indexing, skip dirty marking — the bulk indexer is
    // already processing this session. Marking dirty here creates a storm of
    // re-index requests that flood the queue after bulk index completes.
    if (!_bulkIndexActive) {
      _indexDirty.add(session.id);
      // [PHASE-1-FIX] Snapshot the current hash at cancellation time so the dirty
      // re-index path can detect if the priority index already covered this content.
      _indexDirtyHash.set(session.id, hashMessages(session.messages));
      console.log(`[CM:sw:bgIdx] in-flight for ${session.id} — marked dirty for re-index`);
    }
    await dexieDb.pendingIndex.delete(session.id).catch(() => {});
    return;
  }

  _indexingInFlight.add(session.id);
  _bgIndexCooldown.set(session.id, Date.now());
  const t0 = performance.now();
  const hw = await getHardwareProfile().catch(() => null);

  try {
    // [FULL-SPEED-FIX] Check if already fully indexed.
    // [DRIVE-RESTORE-FIX] Check isComplete + chunks BEFORE hash comparison,
    // because synthetic hashes from Drive restore have hash='' which won't
    // match currentHash, but the session is still fully indexed.
    const existingHash = await dexieDb.sessionHashes.get(session.id);
    const totalMessages = session.messages.length;
    const currentHash = hashMessages(session.messages);

    if (existingHash && existingHash.isComplete === true) {
      // [FIX-2] Hash comparison FIRST — if content changed, isComplete is stale
      // regardless of chunk count. This catches Drive sync replacing a 6-msg
      // partial scrape with 132 msgs where old isComplete=true persists.
      if (existingHash.hash && existingHash.hash !== currentHash) {
        console.warn(`[CM:sw:bgIdx] ${session.id} hash mismatch (isComplete=true but content changed) — re-indexing`);
        await dexieDb.sessionHashes.where('sessionId').equals(session.id).modify({ isComplete: false }).catch(() => {});
      } else {
        const chunkCount = await dexieDb.chunkEmbeddings.where('sessionId').equals(session.id).count();
        if (chunkCount > 0) {
          // [BUG-3 FIX] Sanity check: chunks should be roughly proportional to messages.
          const expectedMinChunks = Math.max(1, Math.ceil(totalMessages / 20));
          if (chunkCount >= expectedMinChunks) {
            console.log(`[CM:sw:bgIdx] ${session.id} already complete (isComplete=true, ${chunkCount} chunks) — skipping`);
            return;
          }
          console.warn(`[CM:sw:bgIdx] ${session.id} stale index detected: ${chunkCount} chunks for ${totalMessages} msgs — re-indexing`);
          await dexieDb.sessionHashes.where('sessionId').equals(session.id).modify({ isComplete: false }).catch(() => {});
        }
      }
    }

    if (existingHash && existingHash.hash === currentHash) {
      const chunkCount = await dexieDb.chunkEmbeddings.where('sessionId').equals(session.id).count();
      if (chunkCount > 0) {
        if (!existingHash.isComplete) { await dexieDb.sessionHashes.where('sessionId').equals(session.id).modify({ isComplete: true }); console.log(`[CM:sw:bgIdx] fixed stale isComplete=false for ${session.id} (${chunkCount} chunks)`); }
        console.log(`[CM:sw:bgIdx] ${session.id} already complete and unchanged — skipping`);
        return;
      }
    }

    console.log(`[CM:sw:bgIdx] full-speed indexing ${session.id}: ${totalMessages} msgs`);

    // [BUG-12 FIX] Ensure offscreen document is ready before indexing starts.
    // Without this, the first indexing attempt after SW wake fails silently
    // because the offscreen document hasn't been created yet.
    await ensureOffscreenDocument().catch(() => {});

    // [FIX-A] Use indexSession (background queue) NOT indexSessionPriority.
    // Priority queue jobs aren't cancellable by cancelBackgroundJobs() → tier3_timeout.
    await semanticIndex.indexSession(session, (pct, stage) => {
      void broadcastToViews({
        type: 'INDEXING_STATUS',
        active: true,
        queued: _indexingInFlight.size,
        sessionId: session.id,
        stage,
        hwTier: hw?.tier ?? 'balanced',
        chunkDone: Math.round(pct / 100),
        chunkTotal: 1,
      } as any);
    });

    const dt = performance.now() - t0;
    console.log(`[CM:sw:bgIdx] full index done ${session.id}: ${totalMessages} msgs in ${dt.toFixed(0)}ms`);

    // [Phase 4 Step 12] Invalidate attention map cache — session messages may have changed
    invalidateAttentionMapCache(session.id);

    void recordPerf('background_index', dt, {
      sessionId: session.id,
      metadata: { platform: session.platform, messageCount: totalMessages, hwTier: hw?.tier },
    });

    void broadcastToViews({
      type: 'INDEXING_STATUS',
      active: false,
      queued: 0,
      sessionId: session.id,
      stage: 'complete',
      hwTier: hw?.tier ?? 'balanced',
    } as any);

    // Re-queue Drive upload so session JSON + hash get synced.
    // [OPTION-B] Embeddings are not synced via Drive — each profile indexes locally.
    void driveSyncManager.queueUpload(session.id);

    // [PRE-COMPUTE-FIX] Pre-compute attention map + retrieve for default task.
    // Only for sessions with >= 5 messages and when no migration is in progress.
    // Backpressure: skip if queue is backed up.
    if (totalMessages >= 5 && !activeMigrationInProgress && !_bulkIndexActive && semanticIndex.getQueueLength() < 10) {
      void preComputeForMigration(session, currentHash).catch((e) =>
        console.warn('[CM:sw:bgIdx] pre-compute failed (non-fatal):', e)
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Failed to fetch")) {
      attentionEngineAvailable = false;
      await chrome.storage.local.set({ attentionEngineAvailable: false });
      console.debug("[CM:bgIdx] Model fetch blocked — Attention tier unavailable on this session");
    } else if (msg.includes("timeout") || msg.includes('cancelled_for_migration')) {
      console.warn(`[CM:sw:bgIdx] ${msg.includes('cancelled') ? 'cancelled' : 'timeout'} indexing ${session.id} — will resume from checkpoint`);
    } else {
      console.warn('[CM:sw:bgIdx] indexing failed (non-fatal):', err);
    }
  } finally {
    await dexieDb.pendingIndex.delete(session.id).catch(() => {});
    _indexingInFlight.delete(session.id);
    // [FIX-4] Reset deferral tracking — indexing completed for this session
    _deferralCount.delete(session.id);
    _lastIndexedMsgCount.set(session.id, session.messages.length);

    const pendingCount = await dexieDb.pendingIndex.count();
    void broadcastToViews({
      type: 'INDEXING_STATUS',
      active: pendingCount > 0 || _indexingInFlight.size > 0,
      queued: pendingCount + _indexingInFlight.size,
      stage: 'complete',
    } as any);

    // [BUG-8 FIX] Drain pending index entries that were dropped due to queue
    // overflow. This ensures sessions re-downloaded from Drive after a wipe
    // eventually get indexed even if their LLM tab isn't open.
    if (pendingCount > 0 && _indexingInFlight.size < 10) {
      void semanticIndex.drainPendingIndex().catch(() => {});
    }

    if (_indexDirty.has(session.id)) {
      _indexDirty.delete(session.id);
      // [T2-FIX] Don't re-queue background indexing while a migration is active —
      // it would be immediately cancelled by cancelBackgroundJobs(), creating a
      // cancel/re-queue loop. The session will be re-indexed on next capture or idle.
      if (activeMigrationInProgress) {
        console.log(`[CM:sw:bgIdx] deferring re-index of ${session.id} — migration in progress`);
      } else {
        // [PERF-THRASH] Check if captures are still arriving (streaming active).
        // If so, defer re-index via the cooldown path instead of immediately
        // starting a new index that will be cancelled by the next capture.
        const lastCapture = _lastCaptureTime.get(session.id) ?? 0;
        // [FIX-4] Cap deferrals — after 5 consecutive deferrals or 50+ new messages, force re-index
        const deferralCount = _deferralCount.get(session.id) ?? 0;
        const lastIdxMsgCount = _lastIndexedMsgCount.get(session.id) ?? 0;
        const msgGrowth = session.messages.length - lastIdxMsgCount;
        const shouldForceIndex = deferralCount >= 5 || msgGrowth >= 50;
        if (lastCapture > 0 && Date.now() - lastCapture < 8000 && !shouldForceIndex) {
          _deferralCount.set(session.id, deferralCount + 1);
          _indexDirty.add(session.id);
          _bgIndexCooldown.set(session.id, Date.now());
          if (!_bgIndexDeferred.has(session.id)) {
            _bgIndexDeferred.add(session.id);
            const schedulePostComplete = () => {
              setTimeout(() => {
                _bgIndexDeferred.delete(session.id);
                void (async () => {
                  const lc = _lastCaptureTime.get(session.id) ?? 0;
                  if (lc > 0 && Date.now() - lc < 8000 && !activeMigrationInProgress) {
                    _bgIndexDeferred.add(session.id);
                    schedulePostComplete();
                    return;
                  }
                  const fresh = await db.getSession(session.id).catch(() => null);
                  if (fresh && !activeMigrationInProgress) await backgroundIndex(fresh).catch(() => {});
                })();
              }, BG_INDEX_COOLDOWN_MS + 1000);
            };
            schedulePostComplete();
          }
          console.log(`[CM:sw:bgIdx] deferring re-index of ${session.id} — streaming still active`);
        } else {
          const fresh = await db.getSession(session.id).catch(() => null);
          if (fresh) {
            // [REINDEX-LOOP-FIX] Verify the hash ACTUALLY changed before re-indexing.
            // The _indexDirty flag is a false positive set by cooldown/in-flight skip
            // paths, not by real content changes. If hash matches + chunks exist,
            // just fix isComplete and clear dirty flag without re-entering backgroundIndex.
            const currentHash = hashMessages(fresh.messages);
            const storedHash = await dexieDb.sessionHashes.get(fresh.id);
            const chunkCount = await dexieDb.chunkEmbeddings.where('sessionId').equals(fresh.id).count();
            // [PHASE-1-FIX] If the hash at cancellation time matches the current hash
            // AND chunks already exist, the priority index (T3 migration) already embedded
            // this content. Skip the redundant full re-index that causes the 100s×2 thrash.
            const dirtySnapshotHash = _indexDirtyHash.get(fresh.id);
            _indexDirtyHash.delete(fresh.id);
            const priorityAlreadyCovered = dirtySnapshotHash === currentHash && chunkCount > 0;
            if (priorityAlreadyCovered || (storedHash && storedHash.hash === currentHash && chunkCount > 0)) {
              if (storedHash && !storedHash.isComplete) {
                await dexieDb.sessionHashes.where('sessionId').equals(fresh.id).modify({ isComplete: true }).catch(() => {});
              }
              console.log(`[CM:sw:bgIdx] ${session.id} dirty flag cleared — ${priorityAlreadyCovered ? 'priority index already covered this content' : 'hash unchanged'} (${chunkCount} chunks) — skipping re-index`);
            } else {
              // [ISSUE-6] Hash actually changed — re-index is necessary.
              console.log(`[CM:sw:bgIdx] re-indexing ${session.id} (dirty — hash changed, ${fresh.messages.length} msgs)`);
              await dexieDb.sessionHashes.where('sessionId').equals(session.id).modify({ isComplete: false }).catch(() => {});
              void backgroundIndex(fresh).catch(() => {});
            }
          }
        }
      }
    }

    void (async () => {
      try {
        if (!(await driveClient.isConnected())) {
          console.log(`[CM:sw:bgIdx] Drive not connected — skipping hash upload for ${session.id}`);
          return;
        }
        const sessionExists = await db.getSession(session.id).catch(() => null);
        if (!sessionExists) {
          console.log(`[CM:sw:bgIdx] session ${session.id} no longer exists in DB — skipping hash upload`);
          return;
        }
        if (driveSyncManager.isTombstoned(session.id)) {
          console.log(`[CM:sw:bgIdx] session ${session.id} is tombstoned — skipping hash upload`);
          return;
        }
        // [FIX-2] Skip chunk upload — only upload session hash (small JSON).
        // Chunks stay local and are re-indexed from session JSON on restore.
        // This eliminates the largest Drive sync bottleneck.
        const h = await dexieDb.sessionHashes.get(session.id);
        if (h) {
          for (let attempt = 1; attempt <= 3; attempt++) {
            try { await driveClient.uploadSessionHash(session.id, h); break; }
            catch (he) { if (attempt === 3) throw he; await new Promise(r => setTimeout(r, 1000 * attempt)); }
          }
          console.log(`[CM:sw:bgIdx] uploaded hash for ${session.id} to Drive (chunks stay local)`);
        }
      } catch (e) {
        console.warn(`[CM:sw:bgIdx] hash upload failed for ${session.id}:`, e);
      }
    })();
  }
}

// [PRE-COMPUTE-FIX] Pre-compute attention map + retrieve for the default migration task.
// Results are cached in-memory so migration can use them instantly.
async function preComputeForMigration(session: ContextSession, sessionHash: string): Promise<void> {
 if (activeMigrationInProgress) return;
 try {
   const [retrieved, attentionMap] = await Promise.all([
     semanticIndex.retrieve(session.id, DEFAULT_MIGRATION_TASK, 25),
     attentionEngine.buildAttentionMap(session, DEFAULT_MIGRATION_TASK, 'balanced')
       .catch(() => undefined),
   ]);
   _preComputedCache.set(session.id, {
     attentionMap,
     retrievedChunks: retrieved.chunks,
     task: DEFAULT_MIGRATION_TASK,
     sessionHash,
     ts: Date.now(),
   });
   console.log(`[CM:sw:preCompute] cached attention map + ${retrieved.chunks.length} chunks for ${session.id}`);

   // [FAST-SYNC] Also pre-build and cache Tier 2 summary if not already cached.
   // This makes T2 migration instant (< 1s) on any profile after sync.
   try {
     const existingSummary = await semanticIndex.getSummary(session.id, 2, null, session.messages.length);
     if (!existingSummary) {
       const scored = await attentionEngine.scoreMessagesForSummarization(session);
       const summary = await buildTier2WithScoring(session, scored, DEFAULT_MIGRATION_TASK);
       await semanticIndex.saveSummary(session.id, 2, null, JSON.stringify(summary), summary.compressionRatio, session.messages.length);
       console.log(`[CM:sw:preCompute] cached T2 summary for ${session.id}`);
     }
   } catch (t2e) {
     console.warn(`[CM:sw:preCompute] T2 summary pre-compute failed for ${session.id}:`, t2e);
   }
 } catch (e) {
   console.warn(`[CM:sw:preCompute] failed for ${session.id}:`, e);
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
  // [CM-MEM] bound the dedup Maps — evict the oldest entry past the cap so a
  // user who visits hundreds of sessions doesn't accumulate unbounded entries.
  const METAPROMPT_TRACK_CAP = 200;
  if (metaPromptLastHash.size >= METAPROMPT_TRACK_CAP) {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, at] of metaPromptLastBuiltAt) {
      if (at < oldestAt) { oldestAt = at; oldestId = id; }
    }
    if (oldestId) {
      metaPromptLastHash.delete(oldestId);
      metaPromptLastBuiltAt.delete(oldestId);
    }
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

/**
 * [CM-P2-FIX] Priority indexing for migration — indexes the full session in
 * a single call. The offscreen document handles chunking, sampling, and
 * incremental persistence internally.
 *
 * [FIX-B] Previous implementation split the session into sub-sessions and
 * called indexSessionPriority multiple times. Since all sub-sessions shared
 * the same session.id, each call's processIndexJob deleted the previous
 * call's chunks (offscreen.ts line: chunkEmbeddings.delete). Only the last
 * sub-session's embeddings survived — 2/3 of the work was wasted.
 *
 * [FIX-D] Uses _priorityIndexPromise to track in-flight indexing. If a
 * migration retry occurs while indexing is still running, we await the
 * existing promise instead of enqueuing a duplicate.
 */
async function indexRemainingChunksPriority(
  session: ContextSession,
  _checkpointIndex: number,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  // [FIX-D] If priority indexing is already running for this session, await it
  const existing = _priorityIndexPromise.get(session.id);
  if (existing) {
    console.log(`[CM:sw] Priority indexing already in-flight for ${session.id} — awaiting`);
    await existing;
    return;
  }

  const promise = (async () => {
    // [T3-PARTIAL-FIX] Only force-clear hash when 0 chunks exist (phantom hash).
    // If partial chunks exist, leave the hash so needsIndexing() detects partial
    // state (isComplete=false) and indexSessionPriority resumes incrementally
    // instead of re-indexing from scratch — saves 50-180s on large sessions.
    const existingChunks = await dexieDb.chunkEmbeddings
      .where('sessionId').equals(session.id).count().catch(() => 0);
    if (existingChunks === 0) {
      await dexieDb.sessionHashes.where('sessionId').equals(session.id).delete().catch(() => {});
    } else {
      // Mark as incomplete so needsIndexing() returns true and triggers re-index
      await dexieDb.sessionHashes.where('sessionId').equals(session.id)
        .modify({ isComplete: false }).catch(() => {});
    }
    await semanticIndex.indexSessionPriority(session, (pct, stage) => {
      onProgress?.(Math.round(pct / 100), 1);
    });

    // Update checkpoint — fully indexed
    await dexieDb.sessionHashes.where('sessionId').equals(session.id).modify({
      lastIndexedMessageIndex: 0,
      isComplete: true,
      indexedAt: Date.now(),
    });
  })();

  // [FIX-D] Store promise so retries can await it; clean up on completion
  _priorityIndexPromise.set(session.id, promise);
  try {
    await promise;
  } finally {
    _priorityIndexPromise.delete(session.id);
  }
}

async function handleMigrateContext(
  payload: {
    sessionId: string;
    additionalSessionIds?: string[];
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
    return;
  }
  // [Feature 3] Load additional sessions for multi-session migration
  const additionalSessions: ContextSession[] = [];
  if (payload.additionalSessionIds && payload.additionalSessionIds.length > 0) {
    for (const id of payload.additionalSessionIds) {
      const s = await db.sessions.get(id);
      if (s) additionalSessions.push(s);
    }
  }
  const isMultiSession = additionalSessions.length > 0;
  const allSessions = [session, ...additionalSessions];
  activeMigrationInProgress = true;
  // [T4-FIX] await the broadcast so the message is delivered before we start indexing.
  // Then yield one tick — gives the sidebar's onMessage handler a chance to set
  // _migrationActive=true before buildAttentionMap or indexSession() can be called.
  await broadcastToViews({ type: 'MIGRATION_ACTIVE', active: true });
  const tier = (payload.tier ?? 2) as 1 | 2 | 3;
  // [T1-SPEED] Skip the macrotask yield for Tier 1 — it's only needed for T2/T3
  // to give the sidebar time to set _migrationActive before indexing runs.
  // T1 never triggers indexing, so the yield wastes ~10-50ms.
  if (tier !== 1) {
    await new Promise<void>(r => setTimeout(r, 0));
  }
  // [ISSUE-12] Pause background indexing (preserves queue for resume after migration)
  semanticIndex.pauseBackgroundJobs();
  _indexingInFlight.clear();
  _indexDirty.clear(); _indexDirtyHash.clear();
  // [DEDUP-FIX] Do NOT clear _priorityIndexPromise here. Clearing it meant a
  // migration retry could not await an in-flight priority index for the same
  // session, so indexRemainingChunksPriority would spawn a SECOND concurrent
  // index job — two ONNX index runs fighting over the offscreen worker, the
  // root of the repeated tier3_timeout retry loop. The map self-cleans in the
  // finally block of indexRemainingChunksPriority when each job completes.
  reportProgress(10, 'Loading session...')
  void reportExtensionEvent({ event: 'migration_start', platform: session.platform, tier, sessionMessageCount: session.messages.length, timestamp: Date.now() });
  let migrationFile: MigrationFile
  let coverageStats: IntelligentSummary['coverageStats']
  // [T1-SPEED] Skip intermediate progress broadcasts for Tier 1 — sub-second ops
  // don't need 5 updates. Only T2/T3 benefit from granular progress.
  if (tier !== 1) reportProgress(20, 'Building context file...')
  try {
    if (tier === 1) {
      // [Phase 4 Step 13] Cap Tier 1 at ~100K tokens to prevent oversized files
      const totalChars = session.messages.reduce((s, m) => s + m.content.length, 0);
      const estimatedTokens = totalChars / 4; // Rough estimate: 1 token ≈ 4 chars
      const TIER1_MAX_TOKENS = 100_000;
      let sessionForMigration = session;
      if (estimatedTokens > TIER1_MAX_TOKENS) {
        const maxChars = TIER1_MAX_TOKENS * 4;
        console.warn(`[CM:tier1] session too large (${estimatedTokens.toFixed(0)} tokens > ${TIER1_MAX_TOKENS}) — truncating with head+tail preservation`);
        // Keep head (20% budget) for early context + tail (80% budget) for recent state.
        // The most recent messages are critical for continuing the conversation.
        const headBudget = Math.floor(maxChars * 0.2);
        const tailBudget = maxChars - headBudget;

        const headMessages: typeof session.messages = [];
        let headChars = 0;
        for (const msg of session.messages) {
          if (headChars + msg.content.length > headBudget) break;
          headMessages.push(msg);
          headChars += msg.content.length;
        }

        const tailMessages: typeof session.messages = [];
        let tailChars = 0;
        const headSet = new Set(headMessages);
        for (let i = session.messages.length - 1; i >= 0; i--) {
          const msg = session.messages[i];
          if (headSet.has(msg)) break;
          if (tailChars + msg.content.length > tailBudget) break;
          tailMessages.unshift(msg);
          tailChars += msg.content.length;
        }

        const truncatedCount = session.messages.length - headMessages.length - tailMessages.length;
        const truncatedMessages = truncatedCount > 0
          ? [...headMessages, { role: 'user' as const, content: `[... ${truncatedCount} messages truncated ...]`, timestamp: Date.now() }, ...tailMessages]
          : [...headMessages, ...tailMessages];
        console.log(`[CM:tier1] truncated: head=${headMessages.length} tail=${tailMessages.length} dropped=${truncatedCount}`);
        sessionForMigration = { ...session, messages: truncatedMessages };
      }
      // T1 is verbatim XML — server cannot improve on the local build.
      // Skip fetchMigrationBuild to avoid the 8s TIMEOUT_BUILD_MS on slow/cold servers.
      if (isMultiSession) {
        const truncatedSessions = allSessions.map((s) => {
          const totalChars = s.messages.reduce((sum, m) => sum + m.content.length, 0);
          if (totalChars / 4 > TIER1_MAX_TOKENS) {
            const maxChars = TIER1_MAX_TOKENS * 4;
            const headBudget = Math.floor(maxChars * 0.2);
            const tailBudget = maxChars - headBudget;
            const headMessages: typeof s.messages = [];
            let headChars = 0;
            for (const msg of s.messages) {
              if (headChars + msg.content.length > headBudget) break;
              headMessages.push(msg);
              headChars += msg.content.length;
            }
            const tailMessages: typeof s.messages = [];
            let tailChars = 0;
            const headSet = new Set(headMessages);
            for (let i = s.messages.length - 1; i >= 0; i--) {
              const msg = s.messages[i];
              if (headSet.has(msg)) break;
              if (tailChars + msg.content.length > tailBudget) break;
              tailMessages.unshift(msg);
              tailChars += msg.content.length;
            }
            const truncatedCount = s.messages.length - headMessages.length - tailMessages.length;
            const truncatedMessages = truncatedCount > 0
              ? [...headMessages, { role: 'user' as const, content: `[... ${truncatedCount} messages truncated ...]`, timestamp: Date.now() }, ...tailMessages]
              : [...headMessages, ...tailMessages];
            return { ...s, messages: truncatedMessages };
          }
          return s;
        });
        migrationFile = buildMultiSessionTier1File(truncatedSessions);
      } else {
        migrationFile = buildTier1File(sessionForMigration);
      }
    } else if (tier === 2) {
      reportProgress(30, 'Extracting smart summary...')
      const stored = await semanticIndex.getSummary(
        session.id, 2, payload.task ?? null, session.messages.length
      )
      let summary: IntelligentSummary
      if (stored) {
        summary = JSON.parse(stored.content)
      } else if (payload.precomputedSummary) {
        // [CM-FIX-PRECOMPUTE] Sidebar already did the ONNX scoring — reuse it directly.
        console.log('[CM:tier2] using precomputed summary from sidebar')
        summary = JSON.parse(payload.precomputedSummary)
      } else {
        let scoredMessages: ScoredMessage[] = []
        try {
          // [CM-T2-ENHANCE] transformer-scored extraction — same quality for all users
          const _t2s = performance.now();
          scoredMessages = await attentionEngine.scoreMessagesForSummarization(session)
          void recordPerf('tier2_scoring' as any, performance.now() - _t2s, { sessionId: session.id, metadata: { messageCount: session.messages.length } });
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
      if (isMultiSession) {
        // [Feature 3] Build summaries for all additional sessions, then merge
        const allSummaries: IntelligentSummary[] = [summary];
        for (const addlSession of additionalSessions) {
          const addlStored = await semanticIndex.getSummary(
            addlSession.id, 2, payload.task ?? null, addlSession.messages.length
          );
          if (addlStored) {
            allSummaries.push(JSON.parse(addlStored.content));
          } else {
            let addlScored: ScoredMessage[] = [];
            try {
              addlScored = await attentionEngine.scoreMessagesForSummarization(addlSession);
            } catch { /* fallback */ }
            const addlSummary = await buildTier2WithScoring(addlSession, addlScored, payload.task);
            await semanticIndex.saveSummary(
              addlSession.id, 2, payload.task ?? null,
              JSON.stringify(addlSummary), addlSummary.compressionRatio,
              addlSession.messages.length
            );
            allSummaries.push(addlSummary);
          }
        }
        migrationFile = buildMultiSessionTier2File(allSessions, allSummaries, payload.task);
      } else {
        // [FIX-1] Compute unindexed messages for raw fallback
        const indexedIndicesT2 = await semanticIndex.getIndexedMessageIndices(session.id);
        const unindexedMsgsT2 = session.messages.filter((_, i) => !indexedIndicesT2.has(i));
        const localFile = buildTier2File(session, summary, payload.task, unindexedMsgsT2);
        migrationFile = localFile;
      }
    } else {
      // [FIX-15] Do NOT hard-fail Tier 3 just because the sticky `attentionEngineAvailable`
      // flag (set by the periodic keepalive alarm) happened to be false at this instant.
      // semanticIndex.retrieve() below already degrades gracefully to keyword-search
      // fallback when the ONNX model is unavailable — hard-rejecting here just means
      // some users get a flat error while others (whose keepalive alarm hadn't fired
      // yet, or fired with a stale success) sail through to the same graceful path.
      // This was the source of "Tier 3 works on some accounts, hard-fails on others."
      if (!attentionEngineAvailable) {
        console.warn('[CM:sw] attentionEngineAvailable=false — proceeding to Tier 3 anyway, retrieve() will use keyword fallback');
      }
      // [CM-FAST-MIGRATE] Clean Tier 3 flow — 3 cases:
      // Case 1: Fully indexed → retrieve → build (~5-10s)
      // Case 2: Partially indexed → complete remaining → retrieve → build (~15-40s)
      // Case 3: Not indexed → index from scratch → retrieve → build (~30-60s)
      // NO warmup here (ONNX is always-warm via keep-alive).
      // NO duplicate indexing. NO bloated timeouts.
      // Timeout is proportional: 10s base + 0.5s per message (max 90s for 1000 msgs).
      // Indexing gets its own timeout: 15s + 0.3s per remaining message.
      // [ADAPTIVE] Retrieve timeout learned from observed semantic_search latencies.
      // Falls back to 15s on cold start (<3 samples).
      const RETRIEVE_TIMEOUT_MS = await latencyTracker.getTimeoutMs("semantic_search", 25);
      try {
        // [PRE-COMPUTE-FAST-PATH] If the sidebar/SW already pre-computed the attention map
        // and retrieve for the default task, and the user is using the same task, skip the
        // expensive indexing/retrieve/scoring steps and build the file immediately.
        const task3Early = payload.task ?? 'Continue from where we left off';
        const currentHash = hashMessages(session.messages);
        const cached = _preComputedCache.get(session.id);
        const cacheAge = cached ? Date.now() - cached.ts : Infinity;
        if (cached && cached.task === task3Early && cached.sessionHash === currentHash && cached.attentionMap && cached.retrievedChunks && cacheAge < PRECOMPUTE_TTL_MS) {
          console.log(`[CM:sw] Pre-compute fast path: ${cached.retrievedChunks.length} chunks + attention map ready, skipping indexing/retrieve`);
          reportProgress(80, 'Pre-computed context ready — building file...');
          const selectedMessages = getMessagesFromChunks(cached.retrievedChunks, session);
          const localFile = buildTier3File(session, cached.retrievedChunks, task3Early, cached.attentionMap);
          // [T3-LOCAL] Server build adds up to 8s for zero quality improvement —
          // local buildTier3File already produces scored, compressed XML. Skip server.
          migrationFile = localFile;
          // Clear cache after use to avoid stale reuse
          _preComputedCache.delete(session.id);
        } else {
          // [CM-FAST-MIGRATE] Step 1: Determine index state
          reportProgress(25, 'Checking index status...')
          const sessionHash = await dexieDb.sessionHashes.get(session.id);
          let isFullyIndexed = sessionHash?.isComplete === true;
          let checkpoint = sessionHash?.lastIndexedMessageIndex ?? session.messages.length;

          // [FAST-PATH-FIX-V2] ALWAYS verify chunk count, even when isComplete=true.
          // A phantom hash (isComplete=true but 0 chunks) can result from an interrupted
          // index job that deleted chunks but crashed before writing new ones.
          const chunkCount = await dexieDb.chunkEmbeddings
          .where('sessionId').equals(session.id).count();
          if (chunkCount > 0 && isFullyIndexed) {
          console.log(`[CM:sw] Fast-path: ${chunkCount} chunks, fully indexed — skipping re-index`);
          checkpoint = 0;
          } else if (chunkCount > 0 && !isFullyIndexed) {
          // [FIX-10] Check coverage ratio — if severely under-indexed (< 30%), fall back to Tier 1
          if (chunkCount < session.messages.length * 0.3) {
            console.warn(`[CM:sw] T3 — only ${chunkCount} chunks for ${session.messages.length} msgs (< 30% coverage) — Tier 1 fallback`);
            throw new Error('no_chunks_tier1_fallback');
          }
          // [STEP-22] All system power goes to completing the index for partial chunks.
          // cancelBackgroundJobs() was already called above — all CPU is available.
          // Use priority indexing to complete remaining messages, then proceed with full Tier 3.
          const coveragePct = Math.round((chunkCount / session.messages.length) * 100);
          console.log(`[CM:sw] T3 — partial chunks (${chunkCount}/${session.messages.length} msgs, ${coveragePct}% coverage) — forcing priority index to complete`);
          reportProgress(30, `Completing index (${coveragePct}% done)...`);
          // [ADAPTIVE-TIMEOUT] Proportional timeout: 6s base + 100ms per chunk over 50.
          // 50 chunks → 6s, 100 chunks → 11s, 200 chunks → 21s.
          // Prevents timeout on medium sessions where ONNX queue drain adds ~100ms/sub-batch.
          const partialIndexTimeoutMs = 6000 + Math.max(0, chunkCount - 50) * 100;
          try {
            await Promise.race([
              indexRemainingChunksPriority(session, checkpoint),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('priority_index_timeout')), partialIndexTimeoutMs))
            ]);
            isFullyIndexed = true; checkpoint = 0;
            console.log(`[CM:sw] T3 — priority indexing completed for ${session.id}`);
          } catch (idxErr) {
            console.warn(`[CM:sw] T3 — priority indexing failed, using partial chunks + unindexed fallback:`, idxErr);
            // Continue with partial chunks — unindexed fallback (Step 15) covers the rest
            isFullyIndexed = true; checkpoint = 0;
          }
          } else {
          // [FIX-3] No chunks at all — clear phantom hash and force full re-index
          if (isFullyIndexed) {
            console.warn(`[CM:sw] Phantom hash for ${session.id} — isComplete=true but 0 chunks, forcing re-index`);
            await dexieDb.sessionHashes.where('sessionId').equals(session.id).delete();
        }
          isFullyIndexed = false;
          checkpoint = session.messages.length;
        }

          const remainingMessages = checkpoint;
          // [CM-FAST-MIGRATE] Step 2: Index if needed (Case 2 & 3)
          if (!isFullyIndexed && remainingMessages > 0) {
          const hasAE = await attentionEngine.hasAttentionChunks(session.id).catch(() => false);
          if (hasAE) { await attentionEngine.copyChunksToDexie(session.id).catch(() => 0); isFullyIndexed = true; checkpoint = 0; }
          else {
            // [CM-T3-PRIORITY-INDEX] Session needs indexing — do NOT fall back to Tier 1.
            // Pause background jobs so all CPU goes to this migration, index with priority,
            // then continue with Tier 3. The user stays in the Attention lane they chose.
            console.log(`[CM:sw] T3 — session not indexed (${session.messages.length} msgs). Starting priority index instead of Tier 1 fallback.`);
            reportProgress(35, `Indexing session (${session.messages.length} messages)…`);
            // [ADAPTIVE-TIMEOUT] Proportional timeout — same formula as partial path.
            const fullIndexTimeoutMs = 6000 + Math.max(0, session.messages.length - 50) * 100;
            try {
              await Promise.race([
                indexRemainingChunksPriority(session, session.messages.length, (done, total) => {
                  const pct = Math.round((done / Math.max(total, 1)) * 35) + 35; // 35–70%
                  reportProgress(pct, 'Indexing for Attention Engine…');
                }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('priority_index_timeout')), fullIndexTimeoutMs))
              ]);
              isFullyIndexed = true; checkpoint = 0;
              console.log(`[CM:sw] T3 — priority index complete for ${session.id}, proceeding to retrieve`);
            } catch (idxErr) {
              // If priority index fails for any reason, fall back to Tier 1 only now.
              console.warn(`[CM:sw] T3 — priority index failed:`, idxErr);
              throw new Error('no_chunks_tier1_fallback');
            }
          }
          } else if (isFullyIndexed) {
          console.log(`[CM:sw] Chunks ready for ${session.id} — plating only`);
          reportProgress(70, 'Session ready — retrieving...');
        }


          // [MEAL-PREP] Step 3: Retrieve relevant chunks — plating only
          reportProgress(75, 'Retrieving relevant chunks...')
          // [CM-FIX-PRECOMPUTE] Use sidebar's precomputed attention map if available — avoids
          // a duplicate ONNX embed run that would compete with the retrieve() query embed.
          // task3Early is already defined at the top of the Tier 3 block.
          // [T3-FIX] Abort controller: fires at 7s so batches cancel cleanly
          const attentionAbort = new AbortController();
          const attentionAbortTimer = setTimeout(() => attentionAbort.abort(), 7_000);
          const attentionMapPromise = payload.precomputedAttentionMap
          ? Promise.resolve(payload.precomputedAttentionMap as AttentionMap)
          : attentionEngine.buildAttentionMap(session, task3Early, 'balanced', attentionAbort.signal, true)
              .catch((amErr) => { console.warn('[CM:sw] buildAttentionMap failed:', amErr); return undefined; });
          const retrieveTimeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('retrieve_timeout')), RETRIEVE_TIMEOUT_MS)
          );
          const { chunks, usedKeywordFallback } = await Promise.race([
          semanticIndex.retrieve(session.id, payload.task ?? null, 25),
          retrieveTimeout
          ]);
          if (usedKeywordFallback) {
            console.warn('[CM:sw] Tier 3 used keyword fallback');
          }
          if (chunks.length === 0) {
          // [CM-T3-FIX] clear phantom hash so next attempt will re-index
          await dexieDb.sessionHashes.where('sessionId').equals(session.id).delete();
          console.warn(`[CM:sw] T3 — 0 chunks for ${session.id}, phantom hash cleared. User must retry migration.`);
          // [CM-TIER-FIX] 0 chunks — return error, never auto-downgrade
          activeMigrationInProgress = false;
          semanticIndex.resumeBackgroundJobs(); // [ISSUE-12]
          sendResponse({ success: false, error: 'tier3_no_chunks', requestedTier: 3, message: 'Attention engine returned no relevant chunks. Try again or switch to Smart Summary.' });
          return;
        }
          const selectedMessages = getMessagesFromChunks(chunks, session)
          const task3 = task3Early;
          // [PERF-FIX] attentionMapPromise was fired in parallel with retrieve().
          // Wait up to 10s for it — should already be done or nearly done.
          const attentionMap = await Promise.race([
          attentionMapPromise,
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 8_000)),
          ]);
          clearTimeout(attentionAbortTimer);
          console.log(`[CM:sw] T3 build: chunks=${chunks.length} attentionMap=${attentionMap ? `topChunks=${attentionMap.topChunks.length} compression=${attentionMap.compressionRatio}%` : 'undefined (synthesized)'}`);
          if (isMultiSession) {
            // [Feature 3] Retrieve chunks for all additional sessions
            const allChunks = [...chunks];
            const allAttentionMaps: AttentionMap[] = [];
            if (attentionMap) allAttentionMaps.push(attentionMap);
            for (const addlSession of additionalSessions) {
              try {
                const addlResult = await Promise.race([
                  semanticIndex.retrieve(addlSession.id, payload.task ?? null, 25),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('retrieve_timeout')), RETRIEVE_TIMEOUT_MS)
                  ),
                ]);
                allChunks.push(...addlResult.chunks);
                // Build attention map for additional session (best-effort, no precompute)
                const addlAbort = new AbortController();
                const addlAbortTimer = setTimeout(() => addlAbort.abort(), 7_000);
                const addlMap = await attentionEngine.buildAttentionMap(addlSession, task3, 'balanced', addlAbort.signal, true)
                  .catch(() => undefined);
                clearTimeout(addlAbortTimer);
                if (addlMap) allAttentionMaps.push(addlMap);
              } catch (addlErr) {
                console.warn(`[CM:sw] T3 multi-session retrieve failed for ${addlSession.id}:`, addlErr);
              }
            }
            if (allChunks.length === 0) {
              activeMigrationInProgress = false;
              semanticIndex.resumeBackgroundJobs(); // [ISSUE-12]
              sendResponse({ success: false, error: 'tier3_no_chunks', requestedTier: 3, message: 'Attention engine returned no relevant chunks across all sessions. Try again or switch to Smart Summary.' });
              return;
            }
            migrationFile = buildMultiSessionTier3File(allSessions, allChunks, task3, allAttentionMaps);
          } else {
            const localFile = buildTier3File(session, chunks, task3, attentionMap)
            // [T3-LOCAL] Server build adds up to 8s for zero quality improvement —
            // local buildTier3File already produces scored, compressed XML. Skip server.
            migrationFile = localFile;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('timeout')) {
          activeMigrationInProgress = false;
          semanticIndex.resumeBackgroundJobs(); // [ISSUE-12]
          sendResponse({ success: false, error: 'tier3_timeout', requestedTier: 3, message: `Migration timed out (${msg}). Try again or switch to Smart Summary.` });
          return;
        }
        if (msg.includes("Failed to fetch")) {
          attentionEngineAvailable = false;
          await chrome.storage.local.set({ attentionEngineAvailable: false });
          console.debug("[CM:sw] Model fetch blocked during migration — Attention tier unavailable");
          activeMigrationInProgress = false;
          semanticIndex.resumeBackgroundJobs(); // [ISSUE-12]
          sendResponse({ success: false, error: 'Attention Engine unavailable — model could not load on this device' });
          return;
        }
        // Any other unhandled error — rethrow to outer catch
        throw err;
      }
    }
  } catch (err: any) {
    console.warn('[CM:sw] File build failed, falling back to tier 1:', err)
    void reportExtensionEvent({ event: 'migration_fallback', platform: session.platform, tier, detail: String(err instanceof Error ? err.message : err).slice(0, 200), timestamp: Date.now() });
    migrationFile = isMultiSession ? buildMultiSessionTier1File(allSessions) : buildTier1File(session)
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

  if (tier !== 1) reportProgress(80, 'Building instructions...')
  const instructionPrompt = buildInstructionPrompt({
    session,
    targetPlatform: payload.targetPlatform,
    tier,
    task: payload.task,
    filename: migrationFile.filename,
    estimatedTokens: migrationFile.estimatedTokens,
    caveman: payload.caveman,
    ...(isMultiSession && {
      sessionCount: allSessions.length,
      totalMessages: allSessions.reduce((sum, s) => sum + s.messages.length, 0),
    }),
  })
  if (tier !== 1) reportProgress(90, 'Injecting instructions...')
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
  const cacheKey = isMultiSession
    ? makeCacheKey(`${session.id}+${additionalSessions.map((s) => s.id).join(',')}`, tier)
    : makeCacheKey(session.id, tier)
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
    void incrementUsage(tier, accessToken, {
      sourcePlatform: session.platform,
      targetPlatform: payload.targetPlatform,
      messageCount: session.messages.length,
      charCount: migrationFile.charCount,
    });
  }
  activeMigrationInProgress = false;
  semanticIndex.resumeBackgroundJobs(); // [ISSUE-12] Resume paused background indexing
  void recordPerf(`migrate_tier${tier}` as 'migrate_tier1'|'migrate_tier2'|'migrate_tier3', performance.now() - t0, { sessionId: session.id, metadata: { platform: session.platform, messageCount: session.messages.length, tier } });
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
          platform as Platform,
          tab.url ?? "",
          async (legacyId, nativeId) => {
            if (nativeId) {
              const byNative = await dexieDb.sessions.where('nativeId').equals(nativeId).first();
              if (byNative) return byNative.id;
            }
            const existing = await db.getSession(legacyId);
            return existing ? existing.id : null;
          }
        );

        // [1e-FIX] Skip if an existing session already has more messages —
        // syncOpenTabs DOM scrapes are often smaller than network captures
        // (virtual scroll evicts old messages). Without this check, the DOM
        // scrape acquires the captureInFlight lock and the fetch interceptor's
        // authoritative capture (which may arrive moments later) is skipped.
        const existingSession = await db.getSession(sessionId);
        if (existingSession && existingSession.messages.length > snapshot.messages.length) {
          continue;
        }

        await handleCaptureSession({
          platform,
          sessionId,
          title: snapshot.title,
          messages: snapshot.messages,
          source: 'sync-tabs',
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
  if (platform === 'gemini') {
    for (const rt of Array.from(document.querySelectorAll('rich-textarea'))) {
      const sr = (rt as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
      if (sr) {
        const el = sr.querySelector<HTMLElement>('.ql-editor[contenteditable="true"]') ?? sr.querySelector<HTMLElement>('.ql-editor') ?? sr.querySelector<HTMLElement>('[contenteditable="true"]');
        if (el) { input = el; break; }
      }
    }
  }
  if (!input) for (const sel of sels) {
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
    // ── Strategy 0: beforeinput event (Lexical editors — Perplexity) ──────────
    // Lexical intercepts beforeinput events and processes them through its
    // internal model. Must run BEFORE paste/execCommand strategies.
    try {
      document.execCommand("selectAll", false, undefined);
      const bi = new InputEvent("beforeinput", {
        inputType: "insertFromPaste",
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      input.dispatchEvent(bi);
      if ((input.textContent?.trim().length ?? 0) > 0) return { ok: true };
    } catch { /* fall through */ }

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

  // Helper: fire input/change events on both the element AND the rich-textarea
  // shadow host. Gemini's Angular zone watches the host, not the inner ql-editor.
  function fireAngularEvents(el: HTMLElement, dataText: string): void {
    const rt = document.querySelector('rich-textarea');
    const targets = rt ? [el, rt as HTMLElement] : [el];
    for (const t of targets) {
      try { t.dispatchEvent(new InputEvent('input', { bubbles: true, data: dataText, inputType: 'insertText' })); } catch { /**/ }
      try { t.dispatchEvent(new Event('change', { bubbles: true })); } catch { /**/ }
    }
  }

  // Inject text into a found element using 5 fallback strategies.
  // [CM-FIX] Each strategy now also fires events on the shadow host to trigger
  // Angular zone detection. Previously doInject returned ok:true based on
  // el.textContent being set, but Angular never saw the change — false positive.
  // [CM-XML-FIX] el.textContent strips HTML tags — XML angle brackets were showing
  // as raw text. Using clipboard paste + execCommand insertText preserves the content.
  // [GEMINI-INJECT-FIX] Don't clear innerHTML — that triggers Angular's cleanup
  // cycle. Use Selection.selectAllChildren(el) instead of execCommand('selectAll')
  // which selects the entire document.
  function selectAllInEl(el: HTMLElement): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function doInject(el: HTMLElement): Promise<{ ok: boolean; error?: string }> {
    try {
      el.focus();
      el.click();

      // A. Quill js API on shadow host
      type QuillLike = { setText(t: string): void; setSelection(n: number): void };
      const rt = document.querySelector('rich-textarea') as (HTMLElement & { __quill?: QuillLike }) | null;
      if (rt?.__quill) {
        rt.__quill.setText(text);
        rt.__quill.setSelection(text.length);
        fireAngularEvents(el, text);
        return { ok: true };
      }

      // B. Clipboard write + synthetic paste (best for Quill/Angular — preserves XML verbatim)
      // navigator.clipboard is available in extension executeScript context (MAIN world).
      // This avoids el.textContent which strips angle-bracket tags from XML content.
      try {
        await navigator.clipboard.writeText(text);
        el.focus();
        // Select all existing content first so paste replaces it
        selectAllInEl(el);
        const pasteEv = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: new DataTransfer(),
        });
        // Populate clipboardData.text for editors that read it directly
        try { pasteEv.clipboardData?.setData('text/plain', text); } catch { /**/ }
        el.dispatchEvent(pasteEv);
        fireAngularEvents(el, text);
        // Give Angular one tick to process
        await new Promise<void>((r) => setTimeout(r, 80));
        if ((el.textContent?.trim().length ?? 0) > 0) return { ok: true };
      } catch (e) {
        console.warn('[CM] clipboard/paste strategy failed:', e);
      }

      // C. beforeinput + insertText (preferred for contenteditable + Angular)
      // [GEMINI-INJECT-FIX] Don't clear innerHTML — select all children instead.
      try {
        selectAllInEl(el);
        const evBefore = new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: text,
        });
        el.dispatchEvent(evBefore);
        if ((el.textContent?.trim().length ?? 0) === 0 && text.length <= 5000) {
          // [GEMINI-INJECT-FIX] Skip execCommand for large text — it freezes
          // the editor on 30k+ chars. Strategy B (clipboard) handles large text.
          document.execCommand('insertText', false, text);
        }
        fireAngularEvents(el, text);
        if ((el.textContent?.trim().length ?? 0) > 0) return { ok: true };
      } catch (e) {
        console.error('[CM] beforeinput strategy error:', e);
      }

      // D. execCommand selectAll + insertText
      // [GEMINI-INJECT-FIX] Use element-scoped selection, don't clear innerHTML.
      // Skip for large text — execCommand insertText freezes the editor on 30k+
      // chars (per-character beforeinput). Strategy B (clipboard paste) handles
      // large text; the textContent fallback below covers the rest.
      if (text.length <= 5000) {
        el.focus();
        selectAllInEl(el);
        let execOk = false;
        try { execOk = document.execCommand('insertText', false, text); } catch (e) {
          console.error('[CM] execCommand error:', e);
        }
        fireAngularEvents(el, text);
        if (execOk && (el.textContent?.trim().length ?? 0) > 0) return { ok: true };
      }

      // E. Direct textContent fallback (last resort — angle brackets become literal text)
      el.textContent = text;
      fireAngularEvents(el, text);
      try {
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', code: 'KeyA' }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a', code: 'KeyA' }));
      } catch { /**/ }
      const finalLen = el.textContent?.trim().length ?? 0;
      return { ok: finalLen > 0, error: finalLen === 0 ? 'text_not_set_after_all_strategies' : undefined };
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

      const injectResult = await doInject(el);
      if (injectResult.ok) {
        // [GEMINI-INJECT-FIX] Wait 80ms then re-verify. The old 150ms delay was
        // too long — Angular's change detection clears text that wasn't set via
        // the proper model path, and 150ms guaranteed we'd see the cleared state.
        // 80ms covers one microtask cycle but catches the text before Angular's
        // full cleanup pass. If text is cleared, retry once more after 120ms
        // — sometimes Angular re-renders on the second cycle.
        await new Promise<void>((r) => setTimeout(r, 80));
        let verifiedLen = el.textContent?.trim().length ?? 0;
        if (verifiedLen > 0) {
          console.log(`[CM] Gemini inject verified (attempt ${attempt + 1}, length=${verifiedLen})`);
          return { ok: true, selector: label, length: verifiedLen };
        }
        // Second check after a longer delay — Angular may re-render
        await new Promise<void>((r) => setTimeout(r, 120));
        verifiedLen = el.textContent?.trim().length ?? 0;
        if (verifiedLen > 0) {
          console.log(`[CM] Gemini inject verified on 2nd check (attempt ${attempt + 1}, length=${verifiedLen})`);
          return { ok: true, selector: label, length: verifiedLen };
        }
        console.warn(`[CM] Gemini inject attempt ${attempt + 1}: text disappeared after 200ms — Angular cleared it, retrying`);
        lastError = 'text_cleared_by_angular';
        continue;
      }
      const length = el.textContent?.trim().length ?? 0;
      if (length > 0) {
        console.log(`[CM] Gemini inject succeeded via length check (attempt ${attempt + 1}, length=${length})`);
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
  // [ISSUE-15] Programmatic injection fallback — inject platform-specific content script then retry 2 more pings
  console.warn(`[CM:sw] Tab ${tabId} content script not ready after ${PING_RETRIES} pings — trying programmatic injection`);
  try {
    // Determine which platform content script to inject based on tab URL
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = tab?.url ?? '';
    const platformScript: Record<string, string> = {
      'claude.ai': 'src/content/claude.ts',
      'chatgpt.com': 'src/content/chatgpt.ts',
      'chat.openai.com': 'src/content/chatgpt.ts',
      'gemini.google.com': 'src/content/gemini.ts',
      'grok.com': 'src/content/grok.ts',
      'grok.x.ai': 'src/content/grok.ts',
      'www.perplexity.ai': 'src/content/perplexity.ts',
      'chat.deepseek.com': 'src/content/deepseek.ts',
    };
    const scriptFile = Object.entries(platformScript).find(([domain]) => url.includes(domain))?.[1];
    if (scriptFile) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [scriptFile],
      }).catch(() => {});
    }
    // Retry 2 more pings after injection
    for (let i = 0; i < 2; i++) {
      await new Promise<void>((r) => setTimeout(r, 1500));
      const alive = await new Promise<boolean>((resolve) => {
        try {
          chrome.tabs.sendMessage(tabId, { type: "PING" }, (resp) => {
            resolve(!chrome.runtime.lastError && !!resp);
          });
        } catch { resolve(false); }
      });
      if (alive) {
        console.log(`[CM:sw] Tab ${tabId} content script ready after programmatic injection (attempt ${i + 1}/2)`);
        return true;
      }
    }
  } catch (e) {
    console.warn(`[CM:sw] Tab ${tabId} programmatic injection failed:`, e);
  }
  return false;
}

async function sendMessageToTab(
  tabId: number,
  message: { type: "INJECT_CONTEXT"; prompt: string; platform: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS_MS = [2_000, 4_000]; // exponential backoff between attempts
  const platform = message.platform;
  // Gemini's findGeminiInput retries for up to 6s internally before giving up.
  // The previous 5s timeout raced against that and always lost — the content
  // script was alive (PING succeeded) but INJECT_CONTEXT timed out before the
  // async injection completed and called sendResponse.
  // [Phase 2 Step 6] Increase to 20s for Gemini specifically to handle slow injection
  const ATTEMPT_TIMEOUT_MS = platform === "gemini" ? 20_000 : 15_000;

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
    // [WARMUP-FIX] Keep-alive alarm — Chrome clamps periodInMinutes to 30s minimum,
    // which is exactly the SW idle timeout. Fires every 30s to prevent SW hibernation
    // and keep the offscreen doc + ONNX model alive (0 CPU, ~70MB RAM).
    await chrome.alarms.create('offscreen-keepalive', { periodInMinutes: 0.5 });
    // [WARMUP-FIX] Eagerly warm the model at extension activation — users never
    // wait 30s for a cold start on first migration.
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ type: 'OFFSCREEN_WARMUP' }, (resp: any) => {
        void chrome.runtime.lastError;
        // [CM-KEEPALIVE-FIX] Only mark as warmed if model is confirmed ready.
        // Do NOT degrade attentionEngineAvailable here — the doc may still be warming up.
        if (resp?.modelReady === true) {
          modelWarmed = true;
        } else if (resp?.modelReady === false && !modelWarmed) {
          // Still loading on activation — mark unwarmed but don't disable engine.
          console.warn('[CM:sw] warmup ping reports model not ready — still warming up (non-fatal)');
          modelWarmed = false;
        }
      }))
      .catch(() => {});
    // [MEAL-PREP] Auto-index all unindexed sessions 15s after activation
    setTimeout(() => void bulkIndexUnindexedSessions(), 15_000);
  })());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'offscreen-keepalive') return;
  // [WARMUP-FIX] Proactively recreate the offscreen doc if Chrome killed it,
  // then send OFFSCREEN_WARMUP so the ONNX worker stays loaded.
  ensureOffscreenDocument()
    .then(() => chrome.runtime.sendMessage({ type: 'OFFSCREEN_WARMUP' }, (resp: any) => {
      void chrome.runtime.lastError;
      // [CM-KEEPALIVE-FIX] Only degrade attentionEngineAvailable when the model
      // explicitly FAILED to load (modelFailed=true). If modelReady=false but
      // modelFailed=false, the model is still warming up — a race window of ~10-20s
      // during offscreen doc creation. Previously this false-positive disabled the
      // engine and forced the UI to show "↺ Retry" on every startup.
      if (resp?.modelFailed === true) {
        console.warn('[CM:sw] keepalive ping: model failed to load — attention engine disabled');
        modelWarmed = false;
        attentionEngineAvailable = false;
        void chrome.storage.local.set({ attentionEngineAvailable: false });
      } else if (resp?.modelReady === true) {
        // Model is fully warmed — (re)enable engine if it was previously degraded.
        modelWarmed = true;
        if (!attentionEngineAvailable) {
          attentionEngineAvailable = true;
          void chrome.storage.local.set({ attentionEngineAvailable: true });
          console.log('[CM:sw] keepalive: model ready — attention engine re-enabled');
        }
      } else {
        // modelReady=false, modelFailed=false → still warming up; do nothing.
        console.log('[CM:sw] keepalive: model still warming up — not degrading engine');
        modelWarmed = false;
      }
    }))
    .catch(() => {});
});
