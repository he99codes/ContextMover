# ContextMover — Complete Architecture Reference
> For LLM consumption. Updated June 9, 2026. Version 2.
> This document is the single source of truth for any LLM asked to work on this codebase.
> Read it fully before making any changes.

---

## 1. What ContextMover Does

ContextMover is a **Chrome MV3 browser extension** paired with a **Next.js 14 web application**. Its purpose is to:

1. **Capture** ongoing AI chat sessions (Claude, ChatGPT, Gemini, Grok, DeepSeek, Perplexity) from the browser in real time — via DOM scraping AND network interception.
2. **Store** them locally in IndexedDB (zero cloud dependency by default).
3. **Migrate** the captured context to a different AI platform with a single click, using a 3-tier compression system that preserves the most important information while fitting within the target platform's context window.
4. **Search** across all captured sessions using in-browser semantic search (ONNX embeddings).
5. **Sync** optionally to Google Drive (bidirectional) or a user's own Supabase vault (E2E encrypted).

Business model: Free (limited migrations/month) → Pro/Team (unlimited) via Razorpay subscriptions. Web dashboard at `contextmover.com` for account management, analytics, and web-based migration.

---

## 2. Monorepo Layout

```
ContextMover/                        pnpm workspace root
├── packages/browser-extension/      Chrome MV3 extension (Vite + React 18 + TypeScript)
│   ├── manifest.json                MV3 manifest (permissions, content scripts, CSP)
│   ├── src/                         All source code (see §3)
│   ├── scripts/build-firefox.js     Firefox manifest adapter
│   ├── dist/                        Build output (loaded into chrome://extensions)
│   └── vite.config.ts
├── packages/web/                    Next.js 14 App Router web application
│   ├── src/app/                     Pages + API routes (see §5)
│   ├── src/components/              React components
│   ├── src/lib/                     Server-side utilities
│   └── middleware.ts                Auth guard for /dashboard/*
├── supabase/
│   ├── schema.sql                   Core tables: sessions, migrations, custom_agents
│   ├── migrations/                  10 migration files (plan_limits, platform_configs, etc.)
│   └── functions/                   Edge functions
├── site/                            Static marketing assets
└── pnpm-workspace.yaml
```

## 3. Browser Extension — Complete File Map

**Build:** Vite + React 18 + TypeScript. Output in `dist/`. MV3 manifest at root.

### 3.1 Manifest Highlights (`manifest.json`)
- **Permissions:** `activeTab`, `scripting`, `storage`, `unlimitedStorage`, `tabs`, `sidePanel`, `downloads`, `offscreen`, `identity`, `alarms`
- **OAuth2:** Google Drive appdata scope (`drive.appdata`)
- **Host permissions:** claude.ai, chatgpt.com, chat.openai.com, gemini.google.com, grok.com, grok.x.ai, perplexity.ai, chat.deepseek.com, contextmover.com, huggingface.co, googleapis.com, supabase.co
- **Content script injection order:** fetch-interceptor (MAIN, document_start) → interceptor-bridge (ISOLATED, document_start) → platform-specific (ISOLATED, document_start or document_idle) → sidebar-toggle (all_urls, document_idle)
- **CSP:** `wasm-unsafe-eval` for ONNX; connect-src whitelists Supabase, HuggingFace CDN, googleapis, contextmover.com

### 3.2 Source Tree
```
src/
├── background/
│   ├── service-worker.ts      Central hub: ALL message routing, capture pipeline,
│   │                          3-tier migration engine, Drive/vault sync, tab
│   │                          management, subscription checks (~3510 lines)
│   └── storage.ts             chrome.storage helpers
│
├── content/                   One ISOLATED-world content script per platform
│   ├── claude.ts              (15 KB) DOM scraper + text injector for claude.ai
│   ├── chatgpt.ts             (7 KB)  DOM scraper + text injector for chatgpt.com
│   ├── gemini.ts              (19 KB) DOM scraper + 4-strategy text injector (Quill API,
│   │                                  execCommand, beforeinput, textContent fallback)
│   ├── grok.ts                (12 KB) DOM scraper + text injector for grok.com
│   ├── deepseek.ts            (15 KB) DOM scraper + text injector for chat.deepseek.com
│   ├── perplexity.ts          (13 KB) DOM scraper + text injector for perplexity.ai
│   ├── shared.ts              (48 KB) Core capture engine: startSessionCapture(),
│   │                                  MutationObserver management, SPA navigation
│   │                                  detection, virtual-scroll shrinkage guard,
│   │                                  new-conversation detection (forceNewSession),
│   │                                  capture deduplication, streaming detection,
│   │                                  scrollback strategies, sendCapture()
│   ├── fetch-interceptor.ts   (45 KB) MAIN world: monkey-patches window.fetch,
│   │                                  XMLHttpRequest, WebSocket to intercept API
│   │                                  responses from AI platforms. Extracts messages
│   │                                  from JSON payloads and forwards via postMessage.
│   ├── interceptor-bridge.ts  (13 KB) MAIN↔ISOLATED world bridge: receives postMessage
│   │                                  from fetch-interceptor, resolves sessionId,
│   │                                  sends CAPTURE_SESSION to service worker
│   └── sidebar-toggle/        Toggle button UI injected into every AI platform page
│       └── toggle.ts
│
├── sidebar/                   React side-panel UI (chrome.sidePanel API)
│   ├── Sidebar.tsx            (138 KB) Main panel: session list with platform filtering,
│   │                                   keyword + semantic search, inline rename,
│   │                                   Drive/Vault status indicators, settings panel,
│   │                                   migration trigger, file context builder,
│   │                                   subscription/usage display
│   ├── MigrationModal.tsx     (77 KB)  3-tier migration UI: tier selection, target
│   │                                   platform picker, progress bar, file injection,
│   │                                   quality score display, caching
│   ├── AttentionModal.tsx     (22 KB)  Attention Engine visualization + manual
│   │                                   semantic search across indexed sessions
│   ├── AuthGate.tsx           (10 KB)  Auth wrapper: Supabase email/password +
│   │                                   Google OAuth (id_token flow via chrome.identity)
│   ├── CapabilitySettings.tsx (6 KB)   Hardware tier override UI
│   ├── ProGate.tsx            (5 KB)   Pro/Team plan gate component
│   ├── QualityScoreCard.tsx   (9 KB)   Post-migration quality score display (0-100)
│   ├── UpgradeModal.tsx       (6 KB)   Paywall / upgrade prompt
│   ├── main.tsx                        React entry point
│   ├── index.html                      Side panel HTML shell
│   ├── index.css                       Tailwind CSS
│   └── components/
│       └── KnowledgeSynthesizer.tsx    Custom context builder: semantic chunk
│                                       selector + "Migrate Custom Context" button
│
├── offscreen/                 Chrome Offscreen Document for ML inference
│   ├── offscreen.html         Minimal HTML shell
│   ├── offscreen.ts           Loads ONNX Runtime Web, handles EMBED/SEARCH
│   │                          messages, modelReady queue for race condition safety
│   └── ml-worker.ts           Web Worker: cosine similarity ranking
│
├── config/
│   └── urls.ts                Central URL constants (WEBAPP_URL, VAULT_URL, etc.)
│
├── testing/                   Golden session tests + test runner
│
└── lib/                       Shared libraries (imported by SW, sidebar, content scripts)
    │
    ├── types.ts               Core types: Platform, Message, ContextSession,
    │                          MigrationPayload, RequestMetadata, ToolCall,
    │                          Artifact, CodeBlock, ExtractedContext, ScoredMessage,
    │                          MetaPrompt, ScraperBrokenMessage
    │
    ├── db.ts                  (18 KB) Dexie v6 wrapper over IndexedDB "contextmover"
    │                          Tables: sessions, prompt_templates, prompt_assignments,
    │                          chunkEmbeddings, sessionHashes, storedSummaries,
    │                          retrievalCache, migrationQuality, metaPrompts,
    │                          pendingIndex. SessionCache (1s TTL in-memory layer).
    │
    ├── db-migration.ts        Legacy "contextforge" → "contextmover" one-shot migration
    │
    ├── session-id.ts          (8 KB) URL→sessionId mapping in chrome.storage.local.
    │                          Per-platform URL normalization (strips tracking params).
    │                          Gemini: strips all query params (SPA, same /app URL).
    │                          forceNew flag for SPA new-chat detection.
    │                          Legacy hash-based ID fallback for pre-rebrand sessions.
    │
    ├── summarizer.ts          (56 KB) Tier-1 (full XML) + Tier-2 (intelligent summary)
    │                          builders. Multi-window goal sampling, heuristic extraction,
    │                          ONNX-scored message selection (ScoredMessage[]).
    │
    ├── translator.ts          (42 KB) Tier-3: attention-map → translated prompt builder.
    │                          Per-platform prompt formatting.
    │
    ├── attention-engine.ts    (67 KB) In-browser transformer inference engine.
    │                          Builds attention maps, scores messages, semantic search.
    │                          Hardware-gated: skipped on "minimal" tier.
    │
    ├── capability-detector.ts (34 KB) Hardware detection: cores, RAM, WebGPU, battery,
    │                          5ms benchmark → tier classification:
    │                            minimal: cores≤2 OR RAM≤4GB OR benchmark<300 ops/ms
    │                            balanced: cores≥3, RAM≥6GB
    │                            full: cores≥6, RAM≥12GB, WebGPU available
    │                          Battery downgrade (full→balanced only).
    │                          Load watchdog for mid-migration tier downgrade.
    │                          System headroom monitor (3s polling).
    │
    ├── file-builder.ts        (15 KB) MigrationFile XML/Markdown assembler.
    │                          buildTier1File, buildTier2File, buildTier3File.
    │                          renderScoredChunks for attention engine output.
    │
    ├── instruction-builder.ts (4 KB) buildInstructionPrompt: per-platform + per-tier
    │                          instruction text prepended to migration files
    │
    ├── remote-config.ts       (4 KB) Fetches CSS selector overrides from
    │                          contextmover.com/config/selectors.json (1hr TTL cache)
    │
    ├── server-intelligence-client.ts (8 KB) fetchMigrationBuild, fetchSummary,
    │                          reportScraperBroken, reportInjectionError,
    │                          reportExtensionEvent — server API calls
    │
    ├── usage-client.ts        (5 KB) checkUsage, incrementUsage API calls
    ├── supabase.ts            (2 KB) Supabase client initialization
    ├── cloud-sync.ts          (9 KB) Cloud backup helpers, prompt sync
    ├── platform-tabs.ts       (1 KB) findTargetPlatformTab helper
    ├── math.ts                (4 KB) cosine similarity, softmax, top-k utilities
    ├── prompt-sanitizer.ts    (5 KB) Strips PII / system prompts before migration
    │
    ├── semantic-index/
    │   ├── index.ts           (35 KB) SemanticIndex class: chunks sessions → embeds
    │   │                      via offscreen ONNX → stores in chunkEmbeddings table.
    │   │                      Dual-lane priority queue (foreground > background).
    │   │                      Cosine retrieval with recency/signal/length boosts.
    │   │                      Phantom-hash guard, persistent index queue recovery.
    │   ├── chunker.ts         (5 KB) Splits messages into overlapping text chunks
    │   ├── hasher.ts          (1 KB) SHA-256 chunk dedup
    │   └── model-constants.ts (1 KB) ONNX model name + embedding dimensions (384-d)
    │
    ├── drive/
    │   ├── drive-client.ts    (16 KB) Google Drive REST API: OAuth via chrome.identity,
    │   │                      appdata folder CRUD, list/create/update/delete files
    │   └── sync-manager.ts    (20 KB) Bidirectional sync engine: conflict resolution
    │                          (higher messages.length wins), periodic alarm (5 min),
    │                          partial sync progress broadcast, delete propagation
    │
    ├── user-vault/
    │   ├── connector.ts       (19 KB) Personal Supabase vault: AES-256-GCM encrypted
    │   │                      config in chrome.storage.local, OAuth + manual setup
    │   └── schema.sql         Vault database schema (cm_sessions table)
    │
    ├── capture/
    │   ├── capture-merge.ts   (2 KB) Pure decision logic: pickBestKnown(),
    │   │                      shouldRejectIncoming() — prevents DOM scrapes from
    │   │                      clobbering authoritative network captures
    │   ├── capture-validator.ts (3 KB) Role-balance + message quality validation
    │   ├── health-monitor.ts  (4 KB) Sliding-window scraper health, emits SCRAPER_BROKEN
    │   └── structural-detector.ts (6 KB) Last-resort DOM heuristic for unknown layouts
    │
    ├── quality/
    │   ├── migration-scorer.ts (18 KB) Scores migration quality 0-100
    │   └── report-generator.ts (14 KB) Downloadable quality report text
    │
    ├── prompt-engine/
    │   ├── engine.ts          (15 KB) Template engine: variable substitution + rendering
    │   ├── default-templates.ts (14 KB) Built-in templates per platform
    │   └── types.ts           PromptTemplate + PromptAssignment types
    │
    ├── file-system/
    │   ├── project-reader.ts  FileTreeNode reader for IDE file context
    │   ├── context-builder.ts FileContextBuilder: formats project files for migration
    │   └── file-copier.ts     Clipboard/download file export
    │
    ├── inference/             ONNX session management helpers for offscreen doc
    ├── export/                JSON / Markdown / TXT session exporters
    ├── workers/               Background embedding web worker
    ├── perf/                  Performance tracking utilities
    └── mcp/                   MCP server bridge (Phase 2 — currently disabled)
```

## 4. Extension — Core Systems (Deep Dive)

### 4.1 Session Capture Pipeline

The capture system has **two independent paths** that feed into one service worker handler:

**Path A: DOM Scraping (ISOLATED world)**
1. Each platform content script (e.g., `gemini.ts`) calls `startSessionCapture()` from `shared.ts`.
2. `shared.ts` sets up a `MutationObserver` on the chat container element.
3. On each mutation, the `capture()` function:
   - Checks for URL change → clears `sessionId` if URL changed.
   - Calls the platform's `scrapeMessages()` function to extract `Message[]` from DOM.
   - Runs hash-based deduplication (`hashMessages()`) — skips if unchanged.
   - Guards against **virtual scroll shrinkage** (messages.length drops >25% → suppress).
   - Detects **SPA new-chat** (messages drops to ≤2 from >3 with new hash → sets `forceNewSession=true`, clears sessionId).
   - Resolves session ID via `ensureSessionId()` → `resolveSessionId()` from `session-id.ts`.
   - Enforces `MIN_SEND_INTERVAL_MS` (2s) between sends for the same session.
   - Sends `CAPTURE_SESSION` message to service worker.

**Path B: Fetch Interception (MAIN world)**
1. `fetch-interceptor.ts` runs in MAIN world at `document_start` — monkey-patches `window.fetch`, `XMLHttpRequest.open/send`, and `WebSocket`.
2. Intercepts API responses from AI platforms, parses JSON to extract messages.
3. Forwards via `postMessage` to `interceptor-bridge.ts` (ISOLATED world).
4. Bridge resolves session ID and sends `CAPTURE_SESSION` with `source: 'fetch-intercept'`.

**Service Worker Handler (`handleCaptureSession`)**
1. **In-flight dedup:** `captureInFlight` Set prevents concurrent writes for same sessionId. Lock released after 2s timeout.
2. **Best-known protection:** `pickBestKnown()` compares incoming message count against both IDB and pending write queue. DOM scrapes with fewer messages than the best known are rejected. Network captures (`source: 'fetch-intercept'`) bypass this check — they're authoritative.
3. **Debounced write:** 50ms debounce timer coalesces rapid-fire captures. After write:
   - `sessionCache.invalidate()` forces fresh IDB read on next `GET_SESSIONS`.
   - Broadcasts `SESSIONS_UPDATED` to sidebar.
   - Queues `backgroundIndex()` for semantic indexing (fire-and-forget).
   - Queues Drive sync via `driveSyncManager.syncAfterCapture()`.
   - Queues vault sync via `queueVaultSync()`.
   - Pre-builds MetaPrompt for sessions with ≥3 messages.

**Session ID Resolution (`session-id.ts`)**
- URL map stored in `chrome.storage.local` under key `cf:urlMap`.
- URL key format: `${platform}::${hostname}${pathname}${normalizedSearch}` (trailing slash stripped).
- Platform-specific normalization:
  - **Grok:** strips `?rid=` (request ID).
  - **ChatGPT:** keeps only `?c=` (conversation ID).
  - **Perplexity:** strips all query params.
  - **Gemini:** strips all query params (SPA — all chats live on `/app`).
- `forceNew=true` parameter: mints a random ID and overwrites URL map entry. Used when content script detects SPA new-chat.
- Legacy fallback: if no URL map entry exists, checks if a legacy hash-based ID (`${platform}-${djb2hash}`) exists in IDB, adopts it to prevent orphaning.
- Fresh ID format: `${platform}-${crypto.randomUUID().slice(0,10)}`.

### 4.2 Three-Tier Migration System

| Tier | Name | Method | Token Budget | When Used |
|------|------|---------|-------------|-----------|
| 1 | Full Context | Full XML transcript with all messages | Unbounded | Short sessions (<50 msgs), file upload capable platforms |
| 2 | Smart Summary | Intelligent summary + key facts + decisions + bugs | ~4K-8K tokens | Medium sessions, when Tier 3 unavailable |
| 3 | Attention Engine | In-browser transformer + semantic retrieval + scored chunks | ~4K-12K tokens | Long sessions (>50 msgs), Pro users, `balanced`/`full` hardware |

**Migration flow:**
```
User clicks "Migrate" → MigrationModal
  → selects target platform + tier
  → MIGRATE_CONTEXT { sessionId, targetPlatform, tier, targetTabId, task }
  → service-worker.ts handleMigrateContext()
      → db.getSession(sessionId) — full session from IDB
      → Branch by tier:
          Tier 1: buildTier1File(session) → XML
          Tier 2: summarizeIntelligent(session) → buildTier2File(session, summary)
          Tier 3: semanticIndex.warmup() → buildAttentionMap(session, task)
                  → buildTier3File(session, attentionMap)
      → Pro users: fetchMigrationBuild() from server API for enhanced quality
      → buildInstructionPrompt(platform, tier) — prepends platform-specific instructions
      → Score migration quality (0-100)
      → Inject into target tab:
          Tier 1: INJECT_FILE_AS_UPLOAD (file input upload where supported)
          Tier 2/3: INJECT_CONTEXT (text injection into chat input)
      → Cache migration file in memory (migrationFileCache)
      → Return { success, migrationFile, qualityScore }
```

**MetaPrompt pre-build:** After every capture of a session with ≥3 messages, `buildMetaPromptAsync()` runs in background — pre-computes the migration prompt for all platforms and stores in `metaPrompts` Dexie table. At migration time, if a MetaPrompt exists and the message count hasn't changed, it's returned instantly with zero computation.

### 4.3 Semantic Index (In-Browser)

- **`SemanticIndex`** (35 KB): The core indexing engine.
  - **Chunking:** `chunker.ts` splits session messages into overlapping text chunks (~512 tokens each).
  - **Embedding:** Chunks sent to offscreen document → ONNX Runtime Web → 384-dimensional float vectors.
  - **Storage:** Vectors stored in `chunkEmbeddings` Dexie table. Hash stored in `sessionHashes` to detect when re-indexing is needed.
  - **Retrieval:** Cosine similarity search with recency boost (recent messages scored higher), signal boost (code blocks, decisions), and length normalization.
  - **Priority queue:** Dual-lane — foreground (user-triggered migration/search) pauses background jobs. One job per lane maximum. Backpressure: if queue length ≥40, background indexing deferred 60s.
  - **Persistent queue:** `pendingIndex` Dexie table survives SW restart and Chrome close. Jobs re-enqueued on SW startup.
  - **Phantom-hash guard:** If `sessionHashes` entry exists but `chunkEmbeddings.count() === 0`, re-indexes.
  - **Dirty re-index:** If a session changes while being indexed (`_indexDirty` Set), re-indexes once after completion with freshest session data.

- **Hardware gating:** `capability-detector.ts` determines tier. Embedding skipped entirely on `minimal` tier — falls back to keyword search.

### 4.4 Knowledge Synthesizer

- Panel in sidebar (`KnowledgeSynthesizer.tsx`): user types a natural language query.
- Performs semantic search across ALL indexed sessions → returns ranked `AttentionChunk[]`.
- User curates chunks (select/deselect), picks target platform, clicks "Migrate Custom Context".
- Creates a virtual in-memory session from selected chunks → `MIGRATE_CONTEXT tier:1` → injects result.
- Falls back to keyword search (title + message content substring match) if semantic index unavailable.

### 4.5 Google Drive Sync

- **OAuth:** `drive-client.ts` uses `chrome.identity.getAuthToken()` with `drive.appdata` scope.
- **Storage format:** Each session is a JSON file in Drive appdata folder. Filename: `cm-session-{id}.json`.
- **Sync engine (`sync-manager.ts`):**
  - Bidirectional: local→Drive on capture, Drive→local on sidebar load.
  - Conflict resolution: session with higher `messages.length` wins.
  - Periodic alarm: every 5 minutes.
  - Delete propagation: `deleteFromDrive()` called on session delete.
  - Partial sync progress broadcast to sidebar (`PARTIAL_SYNC_PROGRESS`).
  - Throttled: `DRIVE_PULL_FROM_LIST_COOLDOWN_MS` prevents rapid-fire pulls.

### 4.6 Personal Vault (User Supabase)

- User connects their own Supabase project via `connector.ts`.
- Connection config (URL, anon key, service role key) encrypted with **AES-256-GCM** in `chrome.storage.local`.
- Sessions synced to `cm_sessions` table in user's own Supabase DB.
- Completely independent of ContextMover's Supabase — user owns their data.
- Vault sync rate-limited: 30s minimum between syncs via `queueVaultSync()`.

### 4.7 Session Management (Sidebar)

- **List view:** All sessions from IDB, sorted by `updatedAt` descending.
- **Platform filter:** Filter by Claude/ChatGPT/Gemini/Grok/DeepSeek/Perplexity.
- **Search:** Keyword (title + message content) or semantic (embedding-based).
- **Inline rename:** `customName` field, persisted via `RENAME_SESSION` → Dexie + Drive + vault.
- **Delete:** Removes from IDB + Drive + vault + semantic index.
- **Export:** JSON / Markdown / TXT download.
- **Refresh:** 2s rate-limit, force `GET_SESSIONS` (invalidates all caches), Drive pull, 5s safety timeout.
- **`SESSIONS_UPDATED` broadcasts** suppressed during active rename to prevent focus steal.
- **Session loading:** `loadSessions()` debounced 250ms, calls `GET_SESSIONS` → SW returns sessions with message content capped at 2000 chars (full content fetched on-demand via `GET_SESSION`).
- **Engagement badges:** "Dev Session" (>50% code blocks), "Marathon" (>50 messages), "Deep Dive" (>30 min duration).

### 4.8 Prompt Engine

- User-defined prompt templates with `{{variable}}` substitution.
- Assignments: bind a template to a specific session + platform combination.
- Synced to Supabase `prompt_templates` + `prompt_assignments` tables.
- Default templates per platform built-in (`default-templates.ts`).
- Templates injected during migration if a `promptTemplateId` is provided in the payload.

### 4.9 Migration Quality Scoring

- Post-migration scorer (0–100) based on:
  - Context preservation ratio (how much of the original was kept)
  - Compression efficiency
  - Message coverage (% of messages represented)
  - Code block preservation
- `QualityScoreCard` component shown after migration with grade (A/B/C/D/F).
- Downloadable quality report text (`report-generator.ts`).
- History stored in `migrationQuality` Dexie table.

### 4.10 Attention Engine

- In-browser transformer model (ONNX Runtime Web, ~23 MB, loaded in **offscreen document**).
- Offscreen document required because MV3 service workers cannot access DOM/WebGL/WebGPU.
- **Model loading:** `modelReady` flag + `pendingRuntimeEmbeds` queue in offscreen.ts. Requests arriving before model ready are queued with 25s safety timeout. Drained after `WORKER_READY`.
- **Tier-3 flow:** Service worker pre-warms model (`semanticIndex.warmup()`, 15s timeout) → `buildAttentionMap(session, task, tier)` → `buildTier3File()` with scored chunks grouped into `<scored_topics>`, `<key_decisions>`, `<architectural_context>`.
- **Hardware gating:** Skipped entirely on `minimal` tier. Background preload on `balanced`/`full`.
- **`AttentionModal.tsx`:** Visualization panel showing attention scores + manual semantic search.

### 4.11 Subscription & Usage

- **Plans:** Free (8 Tier-1, 3 Tier-2, 3 Tier-3 per month) → Pro/Team (unlimited).
- **Plan variants:** `free`, `pro` (admin-granted), `monthly`, `annual`, `monthly_earlybird`, `annual_earlybird`, `team`.
- **Server-side tracking:** `plan_limits` table in Supabase defines per-plan caps. `checkUsage()` / `incrementUsage()` API calls.
- **Sidebar display:** Subscription status cached in sidebar, refreshed via `GET_SUBSCRIPTION_STATUS` (8s timeout, falls back to `free` on failure).
- **Gate components:** `ProGate.tsx` wraps Pro-only UI. `UpgradeModal.tsx` shows upgrade prompt with pricing.

### 4.12 Auth Flow

- **Extension:** `AuthGate.tsx` wraps the entire sidebar.
  - Email/password via `AUTH_SIGN_IN` message → Supabase `signInWithPassword`.
  - Google OAuth via `chrome.identity.launchWebAuthFlow` → gets `id_token` → `AUTH_GOOGLE_SIGN_IN` → exchange with backend.
  - Session stored in Supabase client, `accessToken` persisted in `chrome.storage.local`.
  - `AUTH_STATE_CHANGED` broadcast triggers sidebar refresh.
- **Web:** Supabase Auth + middleware. `/dashboard/*` routes protected by `middleware.ts`.

### 4.13 MCP / IDE Bridge (Phase 2 — Disabled)

- Architecture in place: `lib/mcp/` module, `MCPStatusPanel` component.
- Will support IDE integration with Cursor, Windsurf, Claude Desktop, Continue.
- Embeddings sync to MCP bridge deferred.

### 4.14 Extension Update Check

- Fetches `contextmover.com/extension-version.json` on sidebar mount.
- Semver comparison with `manifest.version`.
- Shows update banner if newer version available.

---

## 5. Web App — Complete File Map & Features

### 5.1 Source Tree
```
packages/web/src/
├── app/
│   ├── layout.tsx              Root layout (Inter font, metadata, Supabase provider)
│   ├── page.tsx                Landing page redirect → /dashboard
│   ├── globals.css             Tailwind + custom CSS (12 KB)
│   ├── not-found.tsx           404 page
│   │
│   ├── (dashboard)/            Route group — auth-gated dashboard shell
│   │   ├── layout.tsx          Dashboard shell: sidebar nav, user menu
│   │   ├── dashboard/          Main dashboard: session list + components
│   │   ├── migrate/            Web-based migration UI (same 3-tier system)
│   │   ├── session/            Session detail view (full transcript)
│   │   ├── analytics/          Usage analytics charts (2 sub-files)
│   │   ├── agents/             AI agents panel (future feature)
│   │   └── settings/
│   │       ├── layout.tsx      Settings shell with sub-nav
│   │       ├── page.tsx        Settings index
│   │       ├── billing/        Subscription + invoice management
│   │       ├── prompts/        Prompt template CRUD editor
│   │       ├── vault/          Personal Supabase vault connection (2 sub-files)
│   │       └── agents/         Agent configuration (future)
│   │
│   ├── admin/                  Admin panel UI (auth-gated separately)
│   │   ├── layout.tsx          Admin layout with auth check
│   │   ├── page.tsx            (17 KB) User management, Pro grants, usage overrides,
│   │   │                       bug reports, refund workflow, per-row busy state
│   │   └── scrapers/           Scraper config admin UI
│   │
│   ├── api/                    Next.js API routes (41 sub-directories)
│   │   ├── auth/               Supabase OAuth callback
│   │   ├── migrate/            Server-side migration build (Pro quality upgrade)
│   │   ├── summarize/          Server-side summarization endpoint
│   │   ├── attention/          Server-side attention engine endpoint
│   │   ├── config/             Public endpoint: /config/selectors.json
│   │   ├── usage/
│   │   │   ├── status/         GET user usage stats
│   │   │   └── increment/      POST increment tier usage counter
│   │   ├── payments/
│   │   │   ├── razorpay/       5 sub-routes: order, verify, subscription, etc.
│   │   │   ├── subscription/   GET subscription status (queried by extension)
│   │   │   ├── subscription-count/ GET active subscriber count
│   │   │   ├── pricing/        GET pricing config
│   │   │   ├── cancel/         POST cancel subscription
│   │   │   ├── refund-request/ POST refund request → support email
│   │   │   ├── usage/          GET payment-linked usage
│   │   │   └── mock-upgrade/   Dev-only mock Pro upgrade
│   │   ├── admin/              Admin-only routes (12 sub-dirs)
│   │   │   ├── _guard.ts       Auth guard: ADMIN_SECRET + ADMIN_EMAIL env vars
│   │   │   ├── users/          List all users
│   │   │   ├── find-user/      Lookup user by email
│   │   │   ├── stats/          Platform-wide statistics
│   │   │   ├── grant-pro/      Manually grant Pro plan
│   │   │   ├── revoke-pro/     Revoke Pro plan
│   │   │   ├── adjust-usage/   Override usage counters
│   │   │   ├── reset-usage/    Reset usage to zero
│   │   │   ├── user-devices/   User device management
│   │   │   ├── refunds/        List refund requests
│   │   │   ├── refund-action/  Approve/deny refund
│   │   │   └── bug-reports/    List submitted bug reports
│   │   ├── scraper-admin/      Scraper config management
│   │   │   ├── configs/        CRUD for platform CSS selectors
│   │   │   └── bug-reports/    Scraper-specific bug reports
│   │   ├── telemetry/          Extension telemetry ingestion
│   │   │   ├── extension-event/ Generic extension events
│   │   │   ├── injection-error/ Injection failure reports
│   │   │   └── scraper-error/  Scraper failure reports
│   │   ├── contact/            POST contact form → ZeptoMail
│   │   ├── feedback/           POST feedback form → ZeptoMail
│   │   ├── support/bug-report/ POST bug report → ZeptoMail
│   │   └── webhooks/razorpay/  Razorpay webhook handler
│   │
│   ├── login/                  Login page
│   ├── signup/                 Signup page
│   ├── pricing/                Pricing page
│   ├── contact/                Contact page
│   ├── feedback/               Feedback page
│   ├── support/                Support page
│   ├── docs/                   Documentation
│   ├── build-with-me/          Community page
│   ├── privacy/                Privacy policy
│   ├── terms/                  Terms of service
│   └── auth/                   Auth flow pages
│
├── components/
│   ├── dashboard/              SessionCard, MigrationPanel, AnalyticsChart, etc.
│   ├── pricing/                PricingCard, PricingTable
│   ├── payments/               CheckoutButton, SubscriptionManager
│   ├── layout/                 Navbar, Sidebar, Footer
│   ├── landing/                Landing page sections
│   ├── support/                BugReportForm
│   ├── ui/                     shadcn/ui base components (~15 files)
│   └── EmailWidget.tsx         Reusable email input widget
│
├── lib/
│   ├── mailer.ts              ZeptoMail SMTP via nodemailer (smtp.zeptomail.in)
│   ├── exporter.ts            (15 KB) Session export: JSON/Markdown/TXT/XML
│   ├── rate-limiter.ts        (8 KB) In-memory rate limiter for API routes
│   ├── env-guard.ts           Validates required env vars at startup
│   ├── telemetry-sanitizer.ts Strips sensitive data from telemetry before logging
│   ├── utils.ts               Shared utils (cn, formatDate, etc.)
│   ├── supabase/              Supabase clients (server, browser, admin — 4 files)
│   ├── payments/              Razorpay client, plan config, subscription helpers (7 files)
│   ├── usage/                 Server-side usage tracking helpers
│   ├── user-vault/            Vault provisioning + connection helpers (2 files)
│   └── emails/                Email template strings
│
└── middleware.ts              Auth middleware: protects /dashboard/* routes
```

### 5.2 Web App Core Features

**Authentication:** Supabase Auth (email/password + Google OAuth). Middleware guards `/dashboard/*`. Extension exchanges `id_token` via `AUTH_GOOGLE_SIGN_IN` → service worker calls Supabase `signInWithIdToken`.

**Dashboard:** Lists captured sessions (from user's vault or server). Session detail view with full transcript. Web-based migration UI (same 3-tier system, server-side processing).

**Subscription & Payments (Razorpay):**
- Plans: Free / Pro / Team. Razorpay subscriptions + one-time payments.
- Plan variants: `monthly`, `annual`, `monthly_earlybird`, `annual_earlybird`, `team`.
- Webhook handler (`/api/webhooks/razorpay/`) processes: `subscription.activated`, `subscription.charged`, `subscription.cancelled`, `subscription.completed`, `payment.failed` → sends transactional emails.
- Extension queries `/api/payments/subscription` with JWT + install-id to get current plan/usage/limits.

**Email (ZeptoMail):** SMTP via `smtp.zeptomail.in` + `ZEPTO_SMTP_PASSWORD` env var. Senders: `noreply@contextmover.com`, `support@contextmover.com`. Triggers: contact form, feedback, bug reports, refund requests, payment lifecycle events.

**Admin Panel (`/admin`):** Internal routes (`/api/admin/*`) guarded by `_guard.ts` (requires `ADMIN_SECRET` header + `ADMIN_EMAIL` match). Capabilities: user management, Pro grant/revoke, usage adjustment/reset, device management, bug report inbox, refund approve/deny workflow. Per-row busy state prevents double-clicks.

**Telemetry Ingestion:** Extension reports scraper errors, injection failures, and generic events to `/api/telemetry/*`. Data sanitized via `telemetry-sanitizer.ts` before storage.

**Remote Scraper Config:** `/api/config/selectors.json` serves platform CSS selectors from `platform_configs` Supabase table. Extension fetches with 1hr TTL cache. Admin can update selectors via `/admin/scrapers` without extension rebuild.

---

## 6. Data Flow Diagrams

### 6.1 Capture Flow (Two Paths)
```
┌─ Path A: DOM Scraping ─────────────────────────────┐
│ Platform page (e.g. gemini.google.com/app)          │
│   → gemini.ts scrapeMessages() extracts Message[]   │
│   → shared.ts capture():                            │
│       hash dedup → shrink guard → SPA new-chat      │
│       detection → MIN_SEND_INTERVAL_MS gate          │
│   → chrome.runtime.sendMessage CAPTURE_SESSION      │
└─────────────────────────────────────────────────────┘
                         ↓
┌─ Path B: Fetch Interception ────────────────────────┐
│ fetch-interceptor.ts (MAIN world, document_start)   │
│   → monkey-patches fetch/XHR/WebSocket              │
│   → intercepts AI platform API response JSON        │
│   → postMessage to interceptor-bridge.ts (ISOLATED) │
│   → bridge resolves sessionId, sends                │
│     CAPTURE_SESSION { source: 'fetch-intercept' }   │
└─────────────────────────────────────────────────────┘
                         ↓
┌─ Service Worker (handleCaptureSession) ─────────────┐
│ 1. captureInFlight dedup (2s lock per sessionId)    │
│ 2. pickBestKnown(): compare vs IDB + pending queue  │
│ 3. shouldRejectIncoming(): block shrunken DOM scrape │
│    (network captures always accepted)               │
│ 4. 50ms debounced Dexie write:                      │
│    → sessionCache.invalidate()                      │
│    → broadcastToViews SESSIONS_UPDATED              │
│    → backgroundIndex() (semantic embedding)         │
│    → driveSyncManager.syncAfterCapture()            │
│    → queueVaultSync()                               │
│    → buildMetaPromptAsync() (if ≥3 msgs)            │
└─────────────────────────────────────────────────────┘
                         ↓
┌─ Sidebar (Sidebar.tsx) ────────────────────────────┐
│ chrome.runtime.onMessage SESSIONS_UPDATED          │
│   → loadSessions() (debounced 250ms)               │
│   → GET_SESSIONS → SW reads IDB (100ms cache)      │
│   → setSessions() → re-render session list          │
└────────────────────────────────────────────────────┘
```

### 6.2 Migration Flow
```
MigrationModal: user selects target platform + tier
  → MIGRATE_CONTEXT { sessionId, targetPlatform, tier, targetTabId, task }
  → service-worker.ts handleMigrateContext():
      1. db.getSession(sessionId) — full session from IDB
      2. Check MetaPrompt cache → return instantly if fresh
      3. Build by tier:
           Tier 1: buildTier1File() → XML
           Tier 2: summarizeIntelligent() → buildTier2File()
           Tier 3: warmup model → buildAttentionMap() → buildTier3File()
      4. Pro users: fetchMigrationBuild() from server API
      5. buildInstructionPrompt(platform, tier)
      6. scoreMigration() → 0-100 quality score
      7. Inject into target tab:
           Tier 1: INJECT_FILE_AS_UPLOAD → file input
           Tier 2/3: INJECT_CONTEXT → text injection
      8. incrementUsage(tier)
      9. Cache file in migrationFileCache
  → content script receives INJECT_CONTEXT
      → platform-specific injector (e.g. injectIntoGeminiInput)
      → tries: Quill API → execCommand → beforeinput → textContent
  → MigrationModal shows QualityScoreCard
```

### 6.3 Semantic Search Flow
```
User types query in KnowledgeSynthesizer / AttentionModal
  → attentionEngine.semanticSearch(query, topK)
  → offscreen doc: ONNX Runtime Web embeds query → 384-d vector
  → cosine similarity vs chunkEmbeddings in Dexie
  → recency + signal + length boosts applied
  → ranked AttentionChunk[] returned to sidebar
  → fallback if embeddings unavailable: keyword search on title + content
```

### 6.4 Drive Sync Flow
```
After capture (fire-and-forget):
  → driveSyncManager.syncAfterCapture(sessionId)
  → debounced 30s → driveClient.updateFile() or createFile()
  → session JSON written to Drive appdata folder

On sidebar load (throttled):
  → driveSyncManager.initialSync()
  → driveClient.listFiles() → compare with local IDB
  → conflict resolution: higher messages.length wins
  → new sessions pulled to local IDB
  → deleted sessions: checked via missing Drive file → local delete
  → PARTIAL_SYNC_PROGRESS broadcast during batch sync
```

---

## 7. Key Technologies

| Layer | Stack |
|-------|-------|
| Extension build | Vite 5 + React 18 + TypeScript 5 |
| Extension storage | Dexie v6 (IndexedDB wrapper), chrome.storage.local |
| Extension ML | ONNX Runtime Web (offscreen document), web-tree-sitter |
| Extension styling | Tailwind CSS + inline styles |
| Extension auth | Supabase JS client + chrome.identity (Google OAuth) |
| Web framework | Next.js 14 App Router (React Server Components) |
| Web DB | Supabase (PostgreSQL + Auth + RLS + Realtime) |
| Web payments | Razorpay (subscriptions + one-time) |
| Web email | ZeptoMail SMTP via nodemailer |
| Web styling | Tailwind CSS + shadcn/ui |
| Drive sync | Google Drive REST API (appdata scope) |
| Vault | User-owned Supabase project (AES-256-GCM encrypted config) |
| Monorepo | pnpm workspaces |
| Hosting | contextmover.com (Vercel assumed for Next.js) |

---

## 8. Database Schemas

### 8.1 Supabase (Server — PostgreSQL)

**Core tables** (`supabase/schema.sql`):
- `sessions` — `id text PK`, `user_id uuid FK→auth.users`, `platform text`, `title text`, `messages jsonb`, `created_at`, `updated_at`. RLS: owner-only (`auth.uid() = user_id`).
- `migrations` — `id uuid PK`, `user_id`, `session_id FK→sessions`, `source_platform`, `target_platform`, `migrated_at`. RLS: owner-only.
- `custom_agents` — `id uuid PK`, `user_id`, `name`, `url`, `input_selector`, `message_selector`, `role_detection`, `output_format`. RLS: owner-only.

**Migration-added tables** (from `supabase/migrations/`):
- `prompt_templates` — User prompt templates. Synced to extension.
- `prompt_assignments` — Template→session→platform bindings.
- `plan_limits` — Per-plan migration limits (`plan text PK`, `tier1_limit`, `tier2_limit`, `tier3_limit`, `is_unlimited`). RLS: publicly readable, service-role-only writes.
- `platform_configs` — Remote scraper CSS selectors per platform. Used by `/config/selectors.json`.
- `bug_reports` — Submitted bug reports with `dom_snippet`.
- `user_devices` — Device tracking for Pro device limits.
- `global_stats` — Platform-wide statistics.
- `subscriptions` — Razorpay subscription records.

### 8.2 IndexedDB (Extension — Dexie v6)

Database name: `contextmover` (migrated from legacy `contextforge`).

| Table | Primary Key | Purpose |
|-------|-------------|---------|
| `sessions` | `id` | Captured AI chat sessions |
| `prompt_templates` | `id` | User prompt templates |
| `prompt_assignments` | `id` (indexes: `sessionId`, `platform`) | Template bindings |
| `chunkEmbeddings` | `id` (`{sessionId}:{chunkIndex}`) | 384-d embedding vectors |
| `sessionHashes` | `sessionId` | Hash of indexed session (dedup guard) |
| `storedSummaries` | `id` (`{sessionId}:{tier}:{taskHash}`) | Cached tier summaries |
| `retrievalCache` | `id` | Cached semantic retrieval results |
| `migrationQuality` | `id` (uuid) | Migration quality scores (0-100) |
| `metaPrompts` | `[sessionId+platform+tier]` | Pre-built migration prompts |
| `pendingIndex` | `sessionId` | Persistent indexing queue (survives SW restart) |

In-memory caches (not persisted):
- `SessionCache`: 1s TTL, invalidated on every write.
- `GET_SESSIONS` result cache: 100ms TTL.
- `migrationFileCache`: Map of recent migration files.

---

## 9. Environment Variables

**Extension** (runtime via `chrome.storage.local` — no build-time env vars):
- `accessToken` — Supabase JWT
- `userId` — Supabase user ID
- `cf:urlMap` — URL→sessionId mappings
- `attentionEngineAvailable` — boolean flag
- Drive OAuth tokens — managed by `drive-client.ts` via `chrome.identity`
- Vault config (AES-256-GCM encrypted) — managed by `user-vault/connector.ts`

**Web** (`.env.local`):
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase project
- `SUPABASE_SERVICE_ROLE_KEY` — Admin access (bypasses RLS)
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — Payment processing
- `ZEPTO_SMTP_PASSWORD` — ZeptoMail SMTP credentials
- `ADMIN_SECRET` — Guards `/api/admin/*` routes
- `ADMIN_EMAIL` — Admin user email (replaces hardcoded value)
- `NEXT_PUBLIC_APP_URL` — Base URL for the web app

---

## 10. Platforms Supported

| Platform | URL | Capture Method | Text Inject | File Upload | Content Script | run_at |
|----------|-----|---------------|-------------|-------------|----------------|--------|
| Claude | claude.ai | DOM + fetch-intercept | ✅ | ✅ | `claude.ts` | document_start |
| ChatGPT | chatgpt.com, chat.openai.com | DOM + fetch-intercept | ✅ | ✅ | `chatgpt.ts` | document_start |
| Gemini | gemini.google.com | DOM + fetch-intercept | ✅ (4 strategies) | ✅ | `gemini.ts` | document_start |
| Grok | grok.com, grok.x.ai | DOM + fetch-intercept | ✅ | ✅ | `grok.ts` | document_idle |
| DeepSeek | chat.deepseek.com | DOM + fetch-intercept | ✅ | ✅ | `deepseek.ts` | document_idle |
| Perplexity | perplexity.ai | DOM + fetch-intercept | ✅ | ✅ | `perplexity.ts` | document_idle |

**SPA handling:** Gemini is a full SPA — all conversations on `/app`. Session ID resolution strips query params. "New chat" detection via message count drop + hash change → `forceNewSession` flag → fresh session ID minted via `resolveSessionId(forceNew=true)`.

---

## 11. Extension Message Protocol (SW ↔ Sidebar ↔ Content Scripts)

All messages routed through `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`.

### 11.1 Capture & Session Management
| Message | Direction | Purpose |
|---------|-----------|---------|
| `CAPTURE_SESSION` | Content→SW | Save captured messages (payload: platform, sessionId, title, messages, source) |
| `GET_SESSIONS` | UI→SW | Fetch session list (supports `force` flag to invalidate caches) |
| `GET_SESSION` | UI→SW | Fetch single session with full message content |
| `DELETE_SESSION` | UI→SW | Delete from Dexie + Drive + vault + semantic index |
| `RENAME_SESSION` | UI→SW | Update `customName`, sync to Drive + vault |
| `SESSION_EXISTS` | Content→SW | Check if a legacy session ID exists in IDB |
| `SESSION_FORGOTTEN` | SW→Content | Broadcast: session deleted, clear cached sessionId |
| `SESSIONS_UPDATED` | SW→UI | Broadcast: session list changed, trigger sidebar refresh |

### 11.2 Migration
| Message | Direction | Purpose |
|---------|-----------|---------|
| `MIGRATE_CONTEXT` | UI→SW | Run full migration pipeline (payload: sessionId, targetPlatform, tier, task) |
| `INJECT_CONTEXT` | SW→Content | Inject text prompt into platform's chat input |
| `INJECT_FILE_AS_UPLOAD` | SW→Content | Inject file via file input element (Tier 1) |
| `INJECT_FILE_TO_TAB` | UI→SW→Content | Full file injection flow |
| `MIGRATION_PROGRESS` | SW→UI | Progress percentage broadcast |
| `MIGRATION_TIER_REQUIRED` | SW→UI | Prompt user for tier selection |
| `MIGRATION_QUALITY_WARNING` | SW→UI | Notify of fallback from higher tier |
| `TIER3_SLOW_MACHINE_WARNING` | SW→UI | Warn about slow Tier 3 on weak hardware |

### 11.3 Drive & Vault Sync
| Message | Direction | Purpose |
|---------|-----------|---------|
| `DRIVE_CONNECT` / `DRIVE_DISCONNECT` | UI→SW | Drive OAuth connect/disconnect |
| `DRIVE_SYNC_NOW` | UI→SW | Force immediate Drive sync |
| `DRIVE_STATUS` | UI→SW | Get Drive connection status |
| `PARTIAL_SYNC_PROGRESS` | SW→UI | Drive sync progress (pct, done, total) |
| `VAULT_GET_STATUS` | UI→SW | Vault connection status check |

### 11.4 Semantic Index & Attention Engine
| Message | Direction | Purpose |
|---------|-----------|---------|
| `BACKGROUND_INDEX` | UI→SW | Trigger semantic indexing for a session |
| `GET_INDEX_STATS` | UI→SW | Get semantic index statistics |
| `CLEAR_SEMANTIC_INDEX` | UI→SW | Wipe all embeddings + hashes |
| `GET_ATTENTION_STATUS` | UI→SW | Check if ONNX model is available |
| `WARMUP_MODEL` | UI→SW | Pre-warm ONNX model in offscreen doc |

### 11.5 Auth & Subscription
| Message | Direction | Purpose |
|---------|-----------|---------|
| `AUTH_GET_USER` | UI→SW | Get current authenticated user |
| `AUTH_SIGN_IN` | UI→SW | Email/password sign in |
| `AUTH_SIGN_OUT` | UI→SW | Sign out |
| `AUTH_GOOGLE_SIGN_IN` | UI→SW | Google OAuth id_token exchange |
| `AUTH_STATE_CHANGED` | SW→UI | Broadcast: auth state changed |
| `GET_SUBSCRIPTION_STATUS` | UI→SW | Get plan, usage, limits (8s timeout) |

### 11.6 Diagnostics & Lifecycle
| Message | Direction | Purpose |
|---------|-----------|---------|
| `SCRAPER_BROKEN` | Content→SW→UI | CSS selector failure alert |
| `CM_DIAG` | Content→SW | Diagnostic telemetry (script-loaded, zero-scrape, etc.) |
| `SIDEBAR_CLOSED` | UI→SW | Sidebar lifecycle event |
| `GET_QUALITY_STATS` / `GET_QUALITY_REPORT` | UI→SW | Migration quality history |

---

## 12. Core Type Definitions

These are the primary types that flow through the entire system. Understanding them is essential.

```typescript
type Platform = "claude" | "chatgpt" | "gemini" | "grok" | "perplexity" | "deepseek";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];      // Tool/function calls (Claude, ChatGPT)
  artifacts?: Artifact[];      // Code blocks, documents, images
}

interface ContextSession {
  id: string;                  // e.g. "gemini-a1b2c3d4e5"
  platform: Platform;
  title: string;
  customName?: string;         // User-provided rename (persisted)
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  metadata?: RequestMetadata;  // Model, temperature, system prompt, authoritative flag
}

interface MigrationPayload {
  summary: string;
  extracted?: ExtractedContext; // Goals, decisions, facts, code blocks
  targetPlatform: Platform;
  sourceSession: ContextSession;
  tier?: 1 | 2 | 3;
  compressionRatio?: number;
  intelligentSummary?: any;    // Tier 2 structured output
  attentionMap?: any;          // Tier 3 attention scores
  projectContext?: string;     // IDE file context (optional)
  metadata?: RequestMetadata;
}

interface MetaPrompt {
  sessionId: string;
  platform: Platform;
  tier: 1 | 2 | 3;
  prompt: string;              // Pre-built migration prompt
  compressionRatio: number;
  builtAt: number;
  messageCount: number;        // Invalidation check: re-build if count changed
}
```

---

## 13. Security Posture

### 13.1 Completed Security Audit (June 2026)
- **Stored XSS in Admin Panel (High)** — Fixed. `dom_snippet` sanitized with DOMPurify.
- **Privilege Escalation in Config Endpoint (High)** — Fixed. Non-admin Supabase client + RLS.
- **Subscription Hijacking (High)** — Fixed. User ID validation on subscription records.
- **Improper Discount Validation (Medium)** — Fixed. Server-side `earlyBird` cutoff.
- **Hardcoded Admin Email (Medium)** — Fixed. `ADMIN_EMAIL` env var.
- **Bug Report Abuse (Medium)** — Fixed. Rate-limiting on public endpoints.
- **Telemetry Data Leakage (Low)** — Fixed. `telemetry-sanitizer.ts` strips PII.

### 13.2 RLS (Row Level Security)
Every Supabase table has RLS enabled. Single `FOR ALL` policies: `auth.uid() = user_id`. Service role key bypasses RLS — never exposed client-side. `plan_limits` is read-only for all users, write-only for service role.

### 13.3 Extension Security
- **CSP:** `script-src 'self' 'wasm-unsafe-eval'`. No `unsafe-eval`. Form/frame actions blocked.
- **Content scripts:** Run in ISOLATED world (except `fetch-interceptor.ts` in MAIN world for API interception).
- **`isFromExtensionUI(sender)`:** Gate on all SW message handlers — rejects messages not from extension's own views.
- **Vault encryption:** AES-256-GCM with random IV per config save.
- **No cloud dependency by default:** Sessions stored locally in IndexedDB. Cloud sync (Drive/vault) is opt-in.

---

## 14. Key Architectural Patterns

### 14.1 Capture Pipeline Guards
The capture pipeline has 7 sequential guards to prevent data corruption:
1. **URL change detection** — clears sessionId on navigation
2. **Fetch-intercept fallback gate** — suppresses DOM scrapes for 30s after network capture
3. **Zero-message gate** — skips empty scrapes with retry logic
4. **Assistant-message gate** — waits for AI response before sending
5. **Hash deduplication** — skips if content unchanged
6. **Virtual scroll shrinkage guard** — suppresses when message count drops >25%
7. **SPA new-chat detection** — overrides shrinkage guard when count drops to ≤2 from >3

### 14.2 Debounce & Cache Hierarchy
```
Content script capture:
  MIN_SEND_INTERVAL_MS = 2000ms        (per-session send rate limit)
  
Service worker:
  captureInFlight = 2000ms             (per-session write lock)
  pendingWrites debounce = 50ms        (coalesce rapid captures)
  GET_SESSIONS_CACHE_MS = 100ms        (response cache for sidebar polls)
  SessionCache TTL = 1000ms            (in-memory IDB cache)
  migrationFileCache = indefinite      (evicted on new capture for same session)
  MetaPrompt cache = indefinite        (invalidated when messageCount changes)
  
Sidebar:
  loadSessions debounce = 250ms        (coalesce SESSIONS_UPDATED bursts)
  subscription cache = 5 min           (GET_SUBSCRIPTION_STATUS poll interval)
  refresh rate-limit = 2000ms          (manual refresh button)

Remote config:
  selector cache TTL = 1 hour          (CSS selector overrides)
  
Drive sync:
  DRIVE_PULL_FROM_LIST_COOLDOWN = 60s  (throttle Drive pulls from GET_SESSIONS)
  alarm interval = 5 min               (periodic sync)
  vault sync rate-limit = 30s          (queueVaultSync minimum interval)
```

### 14.3 Error Handling Philosophy
- **Never throw in capture path:** All capture errors are logged and swallowed. A failed capture never blocks the next one.
- **Never throw in subscription check:** Timeout or error → `{ plan: "free" }`. User can still use free-tier features.
- **Never throw in Drive/vault sync:** Sync failures are fire-and-forget. Console warnings only.
- **Migration errors fallback:** Tier 3 failure → Tier 2 → Tier 1. `MIGRATION_QUALITY_WARNING` broadcast notifies user.
- **`void chrome.runtime.lastError`:** Consumed in all `sendMessage` callbacks to prevent "Unchecked runtime.lastError" DevTools noise.

### 14.4 broadcastToViews Pattern
The SW uses `chrome.runtime.getContexts()` to check if any extension views (sidebar, popup) are open before broadcasting. This eliminates "Receiving end does not exist" errors that Chrome surfaces even when the rejection is caught.

---

## 15. Known Architectural Constraints

### 15.1 Cross-Profile Drive Sync vs Local Embeddings
- Drive syncs session JSON (messages, title, metadata) but NOT semantic embeddings.
- ONNX embeddings are local to each Chrome profile's IndexedDB.
- A session pulled from Drive on Profile B has zero embeddings → Tier 3 must re-index.
- **Partial embedding risk:** If indexing was interrupted (6 of 12 chunks embedded), `needsIndexing()` returns false (hash matches, count > 0) → retrieval uses incomplete embeddings silently.
- **Mitigation:** Phantom-hash guard re-indexes if `chunkEmbeddings.count() === 0`.
- **Unresolved:** No guard for partial embeddings (count > 0 but < expected).

### 15.2 SPA Session Identity
- Gemini, and potentially future SPA platforms, don't change URLs between conversations.
- Session identity relies on `forceNewSession` detection (message count drop + hash change).
- If a user loads an old conversation (restores messages), it will merge into the current session ID unless the URL changes.
- ChatGPT and Claude change URLs per conversation (path-based IDs), so this is primarily a Gemini concern.

### 15.3 Service Worker Lifecycle
- MV3 service workers are suspended after ~30s of inactivity.
- In-memory state (`captureInFlight`, `pendingWrites`, `migrationFileCache`, `SessionCache`) is lost on suspension.
- `pendingIndex` Dexie table provides persistence for the indexing queue.
- `MetaPrompt` cache in Dexie provides persistence for pre-built migration prompts.
- Chrome alarms (5 min interval) keep the SW alive for Drive sync.

### 15.4 Offscreen Document Constraints
- Only ONE offscreen document can exist per extension at a time.
- The ONNX model (~23 MB) loads once and stays resident.
- If the offscreen doc is closed (Chrome memory pressure), the model must be re-loaded.
- `modelReady` queue prevents embed requests from failing during model load.

---

## 16. Development Quick Reference

**Build extension:**
```bash
cd packages/browser-extension && npm run build
```

**Load in Chrome:**
1. Navigate to `chrome://extensions`
2. Enable Developer mode
3. "Load unpacked" → select `packages/browser-extension/dist`

**Build web app:**
```bash
cd packages/web && npm run build
```

**Key files to modify for common tasks:**

| Task | File(s) |
|------|---------|
| Add new AI platform | `content/[platform].ts`, `shared.ts`, `manifest.json`, `types.ts` (Platform union), `session-id.ts` (URL normalization) |
| Fix broken scraper | Update `platform_configs` in Supabase OR modify `content/[platform].ts` selectors |
| Change capture behavior | `content/shared.ts` (capture function, guards, dedup) |
| Change migration output | `file-builder.ts`, `summarizer.ts` (Tier 2), `translator.ts` (Tier 3) |
| Change subscription logic | `service-worker.ts` (`GET_SUBSCRIPTION_STATUS`), `packages/web/src/app/api/payments/subscription/` |
| Add new SW message type | `service-worker.ts` (handler), sidebar/content (sender), this document (§11) |
| Change sidebar UI | `sidebar/Sidebar.tsx` (main), `MigrationModal.tsx` (migration flow) |
| Change auth flow | `sidebar/AuthGate.tsx` (UI), `service-worker.ts` (`AUTH_*` handlers) |
| Modify Drive sync | `lib/drive/sync-manager.ts`, `lib/drive/drive-client.ts` |
| Change hardware thresholds | `lib/capability-detector.ts`, `lib/attention-engine.ts` |

---

*End of architecture reference. This document should be updated whenever significant architectural changes are made.*
