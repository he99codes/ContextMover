# ContextMover — Architecture & Feature Report
> Code-free LLM reference. May 2026.

## 1. Product Overview
Chrome MV3 extension + Next.js 14 web app. Captures AI chat sessions (Claude, ChatGPT, Gemini, Grok, DeepSeek, Perplexity), stores locally in IndexedDB (Dexie v6), migrates context between platforms via 3-tier compression. Free/Pro/Team plans via Razorpay.

## 2. Monorepo Structure
```
ContextMover/                    pnpm workspace root
├── packages/browser-extension/  Chrome MV3 — Vite + React + TypeScript
├── packages/web/                Next.js 14 App Router
├── supabase/                    DB migrations + RLS policies
├── site/                        Static marketing assets
└── pnpm-workspace.yaml
```

## 3. Browser Extension File Tree
```
src/
├── background/
│   ├── service-worker.ts   ALL message routing, capture debounce, migration (3 tiers),
│   │                       Drive sync, vault sync, tab management, usage (~2850 lines)
│   └── storage.ts          chrome.storage helpers
│
├── content/                One isolated-world content script per platform
│   ├── claude.ts           DOM scraper + injector
│   ├── chatgpt.ts          DOM scraper + injector
│   ├── gemini.ts           DOM scraper + INJECT_FILE_AS_UPLOAD→text fallback
│   ├── grok.ts             DOM scraper + injector
│   ├── deepseek.ts         DOM scraper + injector
│   ├── perplexity.ts       DOM scraper + injector
│   ├── shared.ts           extractContent, startSessionCapture, injectWithRetry,
│   │                       setPromptInputValue, sendCapture (39 KB)
│   ├── fetch-interceptor.ts  MAIN world: overrides fetch/XHR/WebSocket (43 KB)
│   ├── interceptor-bridge.ts MAIN↔ISOLATED bridge
│   └── sidebar-toggle/     Toggle button injected into every AI platform page
│
├── sidebar/                React side-panel UI
│   ├── Sidebar.tsx         Main panel: session list, filter, search, rename,
│   │                       refresh, Drive/Vault status, settings (~129 KB)
│   ├── MigrationModal.tsx  3-tier migration UI, tier selection, progress (70 KB)
│   ├── AttentionModal.tsx  Attention Engine viz + semantic search UI
│   ├── AuthGate.tsx        Auth wrapper (Supabase JWT)
│   ├── ProGate.tsx         Pro/Team plan gate
│   ├── QualityScoreCard.tsx  Post-migration quality score display
│   ├── UpgradeModal.tsx    Paywall / upgrade prompt
│   └── components/
│       ├── KnowledgeSynthesizer.tsx  Custom context builder (semantic chunk selector + migrate)
│       └── MigrationModal.tsx        (inner component reused by AttentionModal)
│
├── offscreen/              Chrome Offscreen Document for ML inference
│   ├── offscreen.html
│   ├── offscreen.ts        Loads ONNX runtime, handles EMBED/SEARCH messages
│   └── ml-worker.ts        Cosine similarity worker for semantic ranking
│
└── lib/
    ├── types.ts            Shared types: ContextSession, Message, Platform, MigrationPayload
    ├── db.ts               Dexie v6 schema: sessions, prompt_templates, prompt_assignments,
    │                       chunkEmbeddings, sessionHashes, storedSummaries,
    │                       retrievalCache, migrationQuality, metaPrompts
    ├── db-migration.ts     Schema version migration logic
    ├── summarizer.ts       Tier-1 (full XML), Tier-2 (intelligent summary) builders (47 KB)
    ├── translator.ts       Tier-3 attention-map→prompt translator (42 KB)
    ├── attention-engine.ts Attention Engine: in-browser transformer inference (61 KB)
    ├── capability-detector.ts  Hardware tier detection (minimal/balanced/performance)
    ├── file-builder.ts     MigrationFile XML/Markdown assembler
    ├── instruction-builder.ts  buildInstructionPrompt for each platform+tier
    ├── remote-config.ts    Fetches CSS selector overrides from contextmover.com (1hr TTL)
    ├── session-id.ts       URL→sessionId mapping in chrome.storage + legacy hash fallback
    ├── platform-tabs.ts    findTargetPlatformTab helper
    ├── server-intelligence-client.ts  fetchMigrationBuild + fetchSummary from server API
    ├── usage-client.ts     getUsageStatus, incrementUsage API calls
    ├── supabase.ts         Supabase client init
    ├── cloud-sync.ts       Cloud backup helpers
    ├── math.ts             cosine similarity, softmax, top-k utils
    ├── prompt-sanitizer.ts Strips PII / system prompts before migration
    │
    ├── semantic-index/
    │   ├── index.ts        SemanticIndex: embed chunks, priority queue, cosine retrieval (30 KB)
    │   ├── chunker.ts      Splits session messages into overlapping chunks
    │   ├── hasher.ts       Chunk dedup via SHA-256
    │   └── model-constants.ts  ONNX model name + dims
    │
    ├── drive/
    │   ├── drive-client.ts     Google Drive appdata OAuth + file CRUD (16 KB)
    │   └── sync-manager.ts     Bidirectional sync, conflict resolution (higher msgCount wins) (20 KB)
    │
    ├── user-vault/
    │   ├── connector.ts    Personal Supabase vault: AES-256-GCM config, OAuth + manual (19 KB)
    │   └── schema.sql      Vault DB schema
    │
    ├── capture/
    │   ├── capture-validator.ts    Role-balance + message quality validation
    │   ├── health-monitor.ts       Sliding-window scraper health alerts
    │   └── structural-detector.ts  Last-resort DOM heuristic for unknown layouts
    │
    ├── quality/
    │   ├── migration-scorer.ts     Scores migration quality 0-100 (18 KB)
    │   └── report-generator.ts     Generates downloadable quality report text (14 KB)
    │
    ├── prompt-engine/
    │   ├── engine.ts           Prompt template engine: variable substitution + rendering (15 KB)
    │   ├── default-templates.ts  Built-in templates per platform (14 KB)
    │   └── types.ts            PromptTemplate + PromptAssignment types
    │
    ├── export/
    │   └── (exporters)         JSON / Markdown / TXT session export
    │
    ├── inference/
    │   └── (onnx helpers)      ONNX session management for offscreen doc
    │
    ├── workers/
    │   └── (web worker)        Background embedding worker
    │
    ├── perf/
    │   └── (perf monitor)      Performance tracking utilities
    │
    ├── mcp/
    │   └── (mcp bridge)        MCP server bridge — Phase 2, currently disabled
    │
    └── file-system/
        └── (file context)      FileContextBuilder: reads project files for IDE context
```

## 4. Extension — Core Features

### 4.1 Session Capture Pipeline
- Two capture paths: **DOM scraping** (content scripts, MutationObserver) and **Fetch Interception** (MAIN world, overrides fetch/XHR/WebSocket).
- Captured messages sent via `CAPTURE_SESSION` → SW deduplication + shrink guard + 500ms debounce → Dexie write → broadcast `SESSIONS_UPDATED`.
- `sessionHashes` table prevents duplicate ingestion. `capture-validator.ts` checks role balance.
- `health-monitor.ts` emits `SCRAPER_BROKEN` if selectors stop working.
- Remote config (`contextmover.com/config/selectors.json`) patches CSS selectors without extension update.

### 4.2 Three-Tier Migration System
| Tier | Name | Method | When Used |
|------|------|---------|-----------|
| 1 | Full Context | Full XML transcript file | Short sessions, Pro file attach |
| 2 | Smart Summary | Intelligent summary + key facts | Medium sessions |
| 3 | Attention Engine | In-browser transformer + semantic retrieval | Long sessions, Pro |

Migration flow: `MIGRATE_CONTEXT` → `handleMigrateContext` → build `MigrationFile` → `buildInstructionPrompt` → inject via `INJECT_CONTEXT` (text) or `INJECT_FILE_AS_UPLOAD` (tier-1 file). Server API (`fetchMigrationBuild`, `fetchSummary`) upgrades quality for Pro users.

### 4.3 Semantic Index (In-Browser)
- `SemanticIndex`: chunks sessions → embeds via offscreen ONNX model → stores in `chunkEmbeddings` (Dexie).
- Cosine similarity retrieval with recency, signal, and length boosts.
- Priority queue: foreground (user-triggered) > background (auto).
- `capability-detector.ts` skips embedding on `minimal` hardware tier.

### 4.4 Knowledge Synthesizer
- Panel in sidebar: user types a query → semantic search across all indexed sessions → returns ranked `AttentionChunk[]`.
- User curates chunks, picks target platform, clicks "Migrate Custom Context".
- Creates a virtual in-memory session, sends `MIGRATE_CONTEXT tier:1`, injects result.
- Falls back to keyword search if semantic unavailable.

### 4.5 Google Drive Sync
- OAuth via `drive-client.ts` → stores sessions as JSON in Drive appdata folder.
- `sync-manager.ts`: bidirectional sync, conflict resolution (higher `messages.length` wins), periodic alarm every 5 min.
- Partial sync progress broadcast to sidebar (`PARTIAL_SYNC_PROGRESS`).

### 4.6 Personal Vault (User Supabase)
- User connects their own Supabase project via `connector.ts`.
- Config encrypted AES-256-GCM in `chrome.storage.local`.
- Sessions synced to `cm_sessions` table in user's own DB.

### 4.7 Session Management
- List, filter by platform, keyword search, semantic search.
- Inline rename (`customName` field, persisted via `RENAME_SESSION` → Dexie + Drive + vault).
- Delete, export (JSON/Markdown/TXT).
- Refresh button: 2s debounce, force GET_SESSIONS, Drive pull, 5s safety timeout, overlay while loading.
- `SESSIONS_UPDATED` broadcasts suppressed during active rename to prevent focus steal.

### 4.8 Prompt Engine
- User-defined prompt templates with variable substitution.
- Assignments per session, per platform.
- Synced to Supabase `prompt_templates` + `prompt_assignments`.
- Default templates per platform built-in.

### 4.9 Migration Quality Scoring
- Post-migration scorer (0–100) based on context preservation ratio, compression, message coverage.
- `QualityScoreCard` shown after migration. Downloadable quality report.
- History stored in `migrationQuality` Dexie table.

### 4.10 Attention Engine
- In-browser transformer model (ONNX, ~23 MB, loaded in offscreen document).
- Tier-3 migration: generates attention maps to select the most relevant conversation segments.
- Hardware gated: skipped on `minimal` tier devices. Background preload on `balanced`/`performance`.
- `AttentionModal.tsx` provides visualization and manual semantic search.

### 4.11 Subscription & Usage
- Free: limited migrations per tier per month. Pro/Team: unlimited.
- Usage tracked server-side, cached 5 min in sidebar (`GET_SUBSCRIPTION_STATUS`).
- `PaywallModal` / `UpgradeModal` gates Pro features.
- `UsageMeter` displayed at bottom of sidebar.

### 4.12 MCP / IDE Bridge
- Architecture in place (`mcp/` lib, `MCPStatusPanel`). Currently disabled — Phase 2.
- Will support Cursor, Windsurf, Claude Desktop, Continue.

### 4.13 Extension Update Check
- Fetches `contextmover.com/extension-version.json` on mount, semver compare, shows banner.

---

## 5. Web App File Tree
```
packages/web/src/
├── app/
│   ├── layout.tsx              Root layout (fonts, metadata)
│   ├── page.tsx                Landing page redirect
│   ├── globals.css
│   │
│   ├── (dashboard)/            Auth-gated dashboard shell
│   │   ├── layout.tsx          Dashboard shell with nav
│   │   ├── dashboard/          Main dashboard page + components
│   │   ├── migrate/            Web-based migration UI
│   │   ├── session/            Session detail view
│   │   ├── analytics/          Usage analytics
│   │   ├── agents/             AI agents panel (future)
│   │   └── settings/
│   │       ├── page.tsx        Settings index
│   │       ├── billing/        Subscription + invoice management
│   │       ├── prompts/        Prompt template editor
│   │       ├── vault/          Personal vault connection settings
│   │       └── agents/         Agent configuration
│   │
│   ├── api/
│   │   ├── auth/               Auth callback (Supabase OAuth)
│   │   ├── migrate/            Server-side migration build endpoint
│   │   ├── summarize/          Server-side summarization endpoint
│   │   ├── attention/          Server-side attention engine endpoint
│   │   ├── usage/
│   │   │   ├── status/         GET usage stats for a user
│   │   │   ├── increment/      POST increment tier usage counter
│   │   │   └── (usage root)
│   │   ├── payments/
│   │   │   ├── razorpay/       Razorpay order/verify/subscription routes (6 sub-routes)
│   │   │   ├── subscription/   GET subscription status
│   │   │   ├── pricing/        GET pricing config
│   │   │   ├── cancel/         POST cancel subscription
│   │   │   ├── refund-request/ POST refund request → support email
│   │   │   ├── usage/          GET payment-linked usage
│   │   │   └── mock-upgrade/   Dev-only mock Pro upgrade
│   │   ├── contact/            POST contact form → ZeptoMail
│   │   ├── feedback/           POST feedback form → ZeptoMail
│   │   ├── support/bug-report/ POST bug report → ZeptoMail
│   │   ├── admin/              Admin-only routes (guard: _guard.ts)
│   │   │   ├── users/          List users
│   │   │   ├── find-user/      Lookup user by email
│   │   │   ├── stats/          Platform stats
│   │   │   ├── grant-pro/      Manually grant Pro
│   │   │   ├── revoke-pro/     Revoke Pro
│   │   │   ├── adjust-usage/   Override usage counters
│   │   │   ├── reset-usage/    Reset usage to zero
│   │   │   ├── refunds/        List refund requests
│   │   │   ├── refund-action/  Approve/deny refund
│   │   │   └── bug-reports/    List submitted bug reports
│   │   └── webhooks/razorpay/  Razorpay webhook: subscription events → emails
│   │
│   ├── login/                  Login page
│   ├── signup/                 Signup page
│   ├── pricing/                Pricing page
│   ├── contact/                Contact page
│   ├── feedback/               Feedback page
│   ├── support/                Support page
│   ├── docs/                   Documentation page
│   ├── build-with-me/          "Build with me" page
│   ├── privacy/                Privacy policy
│   ├── terms/                  Terms of service
│   └── auth/                   Auth flow pages
│
├── components/
│   ├── dashboard/              SessionCard, MigrationPanel, AnalyticsChart, etc. (11 files)
│   ├── pricing/                PricingCard, PricingTable (2 files)
│   ├── payments/               CheckoutButton, SubscriptionManager (2 files)
│   ├── layout/                 Navbar, Sidebar, Footer (3 files)
│   ├── landing/                Landing page sections
│   ├── support/                BugReportForm
│   ├── ui/                     shadcn/ui base components (15 files)
│   └── EmailWidget.tsx         Reusable email input widget
│
├── lib/
│   ├── mailer.ts               ZeptoMail SMTP via nodemailer (smtp.zeptomail.in)
│   ├── exporter.ts             Session export: JSON/Markdown/TXT/XML (15 KB)
│   ├── rate-limiter.ts         In-memory rate limiter for API routes
│   ├── env-guard.ts            Validates required env vars at startup
│   ├── utils.ts                Shared utils (cn, formatDate, etc.)
│   ├── supabase/               Supabase client (server, browser, admin variants)
│   ├── payments/               Razorpay client, plan config, subscription helpers (7 files)
│   ├── usage/                  Server-side usage tracking helpers
│   ├── user-vault/             Vault provisioning + connection helpers
│   └── emails/                 Email template strings
│
└── middleware.ts               Auth middleware: protects /dashboard routes
```

---

## 6. Web App — Core Features

### 6.1 Authentication
- Supabase Auth (email + OAuth). Middleware guards `/dashboard/*`.
- Extension syncs `accessToken` via `chrome.storage.local`.

### 6.2 Dashboard
- Lists captured sessions (pulled from user's vault or server).
- Session detail view with full transcript.
- Web-based migration UI (same 3-tier system, server-side).

### 6.3 Subscription & Payments (Razorpay)
- Free / Pro / Team plans. Razorpay subscription + one-time payments.
- Webhook handler processes: `subscription.activated`, `subscription.charged`, `subscription.cancelled`, `subscription.completed`, `payment.failed` → sends transactional emails via ZeptoMail.
- Admin panel to grant/revoke Pro, adjust usage, manage refunds.

### 6.4 Email (ZeptoMail)
- SMTP via `smtp.zeptomail.in` + `ZEPTO_SMTP_PASSWORD` env var.
- Senders: `noreply@contextmover.com`, `support@contextmover.com`.
- Triggers: contact form, feedback, bug reports, refund requests, payment events.

### 6.5 Prompt Template Editor
- Web UI to create/edit/delete prompt templates.
- Synced to Supabase, available in extension sidebar.

### 6.6 Vault Settings
- Connect personal Supabase project for end-to-end encrypted session storage.
- Vault schema auto-provisioned via `schema.sql`.

### 6.7 Analytics
- Usage charts (migrations by tier, platform breakdown, daily counts).

### 6.8 Admin Panel
- Internal routes (`/api/admin/*`) guarded by `_guard.ts` (admin secret header).
- User management, Pro grants, usage overrides, bug report inbox, refund workflow.

---

## 7. Data Flow Summary

### Capture
```
AI Platform page
  → fetch-interceptor.ts (MAIN world, intercepts API responses)
  → interceptor-bridge.ts (postMessage MAIN→ISOLATED)
  → content script (e.g. claude.ts)
  → chrome.runtime.sendMessage CAPTURE_SESSION
  → service-worker.ts handleCaptureSession
      → dedup (sessionHashes)
      → debounced Dexie write (500ms)
      → backgroundIndex (SemanticIndex)
      → driveSyncManager.syncAfterCapture
      → vault sync
      → broadcastToViews SESSIONS_UPDATED
  → Sidebar.tsx updates session list
```

### Migration
```
User clicks "Migrate" in Sidebar
  → MigrationModal (or KnowledgeSynthesizer)
  → chrome.runtime.sendMessage MIGRATE_CONTEXT { sessionId, targetPlatform, tier, targetTabId }
  → service-worker.ts handleMigrateContext
      → db.getSession(sessionId)
      → build MigrationFile (tier 1/2/3)
      → optionally fetchMigrationBuild from server API (Pro)
      → inject:
          tier 1 → chrome.tabs.sendMessage INJECT_FILE_AS_UPLOAD
          tier 2/3 → sendMessageToTab INJECT_CONTEXT
  → content script (e.g. gemini.ts)
      → injectIntoGeminiInput(text)  [Gemini text fallback]
      → OR injectInto*Input for other platforms
  → sendResponse { success, injected, cacheKey, migrationFile }
  → MigrationModal shows result + QualityScoreCard
```

### Semantic Search
```
User types in semantic search box
  → attentionEngine.semanticSearch(query, topK)
  → offscreen doc (ONNX): embed query → cosine similarity vs chunkEmbeddings
  → ranked sessions displayed
  → fallback: keyword search on title + message content
```

---

## 8. Key Technologies

| Layer | Stack |
|-------|-------|
| Extension build | Vite + React 18 + TypeScript |
| Extension storage | Dexie v6 (IndexedDB wrapper) |
| Extension ML | ONNX Runtime Web (offscreen doc) |
| Extension styling | Tailwind CSS + shadcn/ui |
| Web framework | Next.js 14 App Router |
| Web DB | Supabase (PostgreSQL + Auth + RLS) |
| Web payments | Razorpay |
| Web email | ZeptoMail SMTP via nodemailer |
| Web styling | Tailwind CSS + shadcn/ui |
| Drive sync | Google Drive REST API (appdata scope) |
| Monorepo | pnpm workspaces |

---

## 9. Environment Variables

**Extension** (via `chrome.storage.local` at runtime — no build-time env):
- `accessToken` — Supabase JWT
- `userId` — Supabase user ID
- Drive OAuth tokens managed by `drive-client.ts`
- Vault config (AES-encrypted) managed by `user-vault/connector.ts`

**Web** (`.env.local`):
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`
- `ZEPTO_SMTP_PASSWORD`
- `ADMIN_SECRET` — guards `/api/admin/*`
- `NEXT_PUBLIC_APP_URL`

---

## 10. Platforms Supported

| Platform | Capture | Inject | File Upload |
|----------|---------|--------|-------------|
| Claude | DOM + fetch-intercept | ✅ text | ✅ (file input) |
| ChatGPT | DOM + fetch-intercept | ✅ text | ✅ (file input) |
| Gemini | DOM + fetch-intercept | ✅ text | ⚠️ removed 2026 → text fallback |
| Grok | DOM + fetch-intercept | ✅ text | ✅ |
| DeepSeek | DOM + fetch-intercept | ✅ text | ✅ |
| Perplexity | DOM + fetch-intercept | ✅ text | ✅ |

---

## 11. Extension Message Types (SW ↔ UI ↔ Content Scripts)

Key messages routed through service-worker.ts:

| Message | Direction | Purpose |
|---------|-----------|---------|
| `CAPTURE_SESSION` | Content→SW | Save captured messages |
| `GET_SESSIONS` | UI→SW | Fetch session list (supports `force` flag) |
| `GET_SESSION` | UI→SW | Fetch full single session |
| `DELETE_SESSION` | UI→SW | Delete session from Dexie + Drive + vault |
| `RENAME_SESSION` | UI→SW | Update customName, sync Drive + vault |
| `MIGRATE_CONTEXT` | UI→SW | Run migration pipeline |
| `INJECT_CONTEXT` | SW→Content | Inject text prompt into platform input |
| `INJECT_FILE_AS_UPLOAD` | SW→Content | Inject file content (text fallback on Gemini) |
| `INJECT_FILE_TO_TAB` | UI→SW→Content | Full file injection flow |
| `DRIVE_CONNECT` / `DRIVE_DISCONNECT` | UI→SW | Drive OAuth |
| `DRIVE_SYNC_NOW` / `DRIVE_STATUS` | UI→SW | Drive sync |
| `VAULT_GET_STATUS` | UI→SW | Vault connection check |
| `GET_SUBSCRIPTION_STATUS` | UI→SW | Plan + usage info |
| `SESSIONS_UPDATED` | SW→UI | Broadcast: session list changed |
| `PARTIAL_SYNC_PROGRESS` | SW→UI | Drive sync progress |
| `SCRAPER_BROKEN` | Content→UI | Selector failure alert |
| `BACKGROUND_INDEX` | UI→SW | Trigger semantic indexing |
| `GET_INDEX_STATS` | UI→SW | Semantic index stats |
| `CLEAR_SEMANTIC_INDEX` | UI→SW | Wipe embeddings cache |
| `GET_QUALITY_STATS` / `GET_QUALITY_REPORT` | UI→SW | Migration quality data |
| `WARMUP_MODEL` | UI→SW | Pre-warm ONNX model |
| `SIDEBAR_CLOSED` | UI→SW | Sidebar lifecycle event |
