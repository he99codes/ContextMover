# ContextMover

> Never lose coding context again. One layer. Any agent. Zero friction.

ContextMover is a full-stack product — a Chrome extension, a web app, a VS Code extension, and an MCP server — that captures AI conversations, compresses them intelligently, and migrates them across any AI platform with one click.

---

## Table of Contents

- [Monorepo Structure](#monorepo-structure)
- [Full Architecture Flow](#full-architecture-flow)
- [Package 1 — Browser Extension](#package-1--browser-extension)
- [Package 2 — Web App](#package-2--web-app)
- [Package 3 — MCP Server](#package-3--mcp-server)
- [Package 4 — VS Code Extension](#package-4--vs-code-extension)
- [Feature Map](#feature-map)
- [What Is Missing](#what-is-missing)
- [Improvements To Make](#improvements-to-make)
- [Missing Links & Broken Wiring](#missing-links--broken-wiring)
- [CI/CD & Release](#cicd--release)
- [Development Setup](#development-setup)

---

## Monorepo Structure

```
ContextForge/
├── packages/
│   ├── browser-extension/      # Chrome MV3 extension (React + Vite + crxjs)
│   ├── web/                    # Next.js 14 web app (contextmover.com)
│   ├── mcp-server/             # @contextmover/mcp-server (npm package)
│   └── vscode-extension/       # VS Code IDE bridge
├── .github/
│   └── workflows/
│       ├── ci.yml                    # Test + build on every push
│       ├── publish-extension.yml     # Chrome Web Store on ext-v* tags
│       └── publish-mcp.yml           # npm publish on mcp-v* tags
├── APP_FLOW.md                 # Deep runtime flow documentation
├── SECURITY.md                 # Security policy
└── pnpm-workspace.yaml
```

---

## Full Architecture Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER'S BROWSER                                  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                  CHROME EXTENSION (MV3)                          │   │
│  │                                                                  │   │
│  │  Content Scripts (per AI platform tab)                          │   │
│  │  claude.ts │ chatgpt.ts │ gemini.ts │ grok.ts │ deepseek.ts     │   │
│  │  perplexity.ts                                                  │   │
│  │      │ MutationObserver → runCapturePipeline()                  │   │
│  │      │   ├── 1. Selector Registry (versioned CSS cascade)       │   │
│  │      │   ├── 2. Capture Validator (role balance, content)       │   │
│  │      │   ├── 3. Structural Fallback (DOM geometry, class-free)  │   │
│  │      │   └── 4. Health Monitor (sliding window, alerts)         │   │
│  │      │ CAPTURE_SESSION ──────────────────────────────────────►  │   │
│  │                                                                  │   │
│  │  Service Worker (background/service-worker.ts)                  │   │
│  │      ├── IndexedDB (idb) — sessions store                       │   │
│  │      ├── Capability Detector → tier 1 / 2 / 3                   │   │
│  │      ├── Summarizer                                              │   │
│  │      │     ├── Tier 1: Heuristic (keep last 6, compress rest)   │   │
│  │      │     ├── Tier 2: Smart Summary (regex extraction)         │   │
│  │      │     └── Tier 3: Attention Engine (ONNX MiniLM-L6-v2)    │   │
│  │      ├── Translator → per-platform prompt format                │   │
│  │      │     Claude=XML │ ChatGPT=MD │ Gemini=plain │ others=MD   │   │
│  │      ├── Priority Prompt Cap (120k chars, P1→P4 order)          │   │
│  │      └── INJECT_CONTEXT ──► target tab content script           │   │
│  │                                                                  │   │
│  │  Sidebar (sidebar/Sidebar.tsx)                                  │   │
│  │      ├── Session list + filter + search                         │   │
│  │      ├── Semantic Search (vector index, ONNX)                   │   │
│  │      ├── Transcript viewer                                       │   │
│  │      ├── Attention Engine modal (pre-compute)                   │   │
│  │      ├── File System Access API (project folder)                │   │
│  │      ├── Prompt Engine (custom templates)                       │   │
│  │      ├── Migration Quality Score                                │   │
│  │      ├── Plan badge + usage meter                               │   │
│  │      ├── Vault / MCP bridge status                              │   │
│  │      └── Update banner (version check vs extension-version.json)│   │
│  │                                                                  │   │
│  │  Popup (popup/Popup.tsx) — quick migrate from icon              │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│         │ HTTP :49152                │ cloud-sync / Supabase            │
└─────────┼──────────────────────────┼──────────────────────────────────┘
          │                          │
          ▼                          ▼
┌──────────────────┐      ┌──────────────────────────────────────────────┐
│  VS Code         │      │  WEB APP  (contextmover.com)                 │
│  Extension       │      │                                              │
│                  │      │  Next.js 14 · Supabase · Tailwind            │
│  BridgeServer    │      │                                              │
│  GET /health     │      │  Pages:                                      │
│  GET /context    │      │  /             Landing page                  │
│  POST /context   │      │  /auth         Sign up / Log in              │
│                  │      │  /dashboard    Overview                      │
│  IDESnapshot:    │      │  /analytics    Usage overview                │
│  · active file   │      │  /settings     Profile + Prompts + Agents    │
│  · open tabs     │      │  /settings/billing  Subscription mgmt        │
│  · git branch    │      │  /settings/vault    Supabase vault setup     │
│  · git diff      │      │  /pricing      Plans (Free / Pro)            │
│  · diagnostics   │      │  /docs         Documentation (stub)          │
│                  │      │  /privacy  /terms                            │
└──────────────────┘      │                                              │
          │               │  API Routes:                                 │
          │               │  /api/payments/subscription  checkout        │
          │               │  /api/payments/cancel        cancel sub      │
          │               │  /api/payments/status        plan status     │
          │               │  /api/payments/portal        billing portal  │
          │               │  /api/webhooks/stripe        Stripe events   │
          │               │  /api/webhooks/razorpay      Razorpay events │
          │               │                                              │
          │               │  Payments:                                   │
          │               │  Geo-routing → South Asia = Razorpay (INR)  │
          │               │              → Rest of world = Stripe (USD)  │
          │               │  14-day trial on all plans                   │
          │               │                                              │
          │               │  Email (ZeptoMail SMTP):                     │
          │               │  · Pro activated · Cancelled · Payment failed│
          │               │  · All Supabase auth emails (custom templates│
          └───────────────┤                                              │
                          └──────────────────────────────────────────────┘
                                        │ Supabase (auth + DB)
                          ┌─────────────┘
                          ▼
              ┌──────────────────────────────┐
              │  MCP SERVER                  │
              │  @contextmover/mcp-server    │
              │                              │
              │  Tools exposed to AI agents: │
              │  · list-sessions             │
              │  · get-session               │
              │  · search-sessions           │
              │  · semantic-search           │
              │  · migrate-context           │
              │  · get-file-context          │
              │  · get-quality-report        │
              │  · apply-prompt-template     │
              └──────────────────────────────┘
```

---

## Package 1 — Browser Extension

### Supported Platforms

| Platform | Capture | Inject | Input method |
|---|---|---|---|
| Claude (`claude.ai`) | ✅ | ✅ | ProseMirror contenteditable |
| ChatGPT (`chatgpt.com`) | ✅ | ✅ | `#prompt-textarea` |
| Google Gemini (`gemini.google.com`) | ✅ | ✅ | `rich-textarea [contenteditable]` |
| xAI Grok (`grok.com`) | ✅ | ✅ | `textarea` / contenteditable |
| DeepSeek (`chat.deepseek.com`) | ✅ | ✅ | `#chat-input` / contenteditable |
| Perplexity (`perplexity.ai`) | ✅ | ✅ | `textarea` / contenteditable |

### Capture Pipeline (4 layers)

```
DOM change detected (MutationObserver, 300ms debounce)
  └─► 1. Selector Registry   — versioned CSS cascade (4–6 selectors/role/platform)
  └─► 2. Capture Validator   — role balance, min messages, content quality
  └─► 3. Structural Fallback — geometry/content heuristics, zero class-name dependency
  └─► 4. Health Monitor      — sliding 10-capture window; amber alert if <80% success
```

### Summarization Tiers

| Tier | Name | Method | Speed | Hardware |
|---|---|---|---|---|
| 1 | Heuristic | Rule-based, keep last 6 verbatim | <100ms | Any |
| 2 | Smart Summary | Regex extraction (goal, decisions, bugs, code) | ~100ms | Any |
| 3 | Attention Engine | ONNX MiniLM-L6-v2 semantic scoring | 1–5s | WebGPU / WASM |

Tier is auto-detected by `capabilityDetector` on first run. CPU watchdog can downgrade tier 3 → 2 mid-flight.

### Prompt Cap (120k chars)

Priority order when trimming:
1. **P1 kept** — metadata, goal, current state, decisions
2. **P2 trimmed first** — code blocks (oldest dropped first)
3. **P3 kept** — last 6 verbatim messages
4. **Last resort** — `[trimmed]` marker + flat string slice

### Migration Message Types

| Message | Direction | Purpose |
|---|---|---|
| `CAPTURE_SESSION` | content → SW | Store/update session |
| `GET_SESSIONS` | UI → SW | Load all sessions |
| `DELETE_SESSION` | UI → SW | Remove session |
| `MIGRATE_CONTEXT` | UI → SW | Full migrate pipeline |
| `INJECT_CONTEXT` | SW → content | Paste into target input |
| `FETCH_IDE_CONTEXT` | SW → bridge | Pull VS Code snapshot |
| `AUTH_GET_USER` | UI → SW | Read auth state |
| `VAULT_GET_STATUS` | UI → SW | Check Vault connectivity |
| `SYNC_OPEN_TABS` | popup → SW | Scan open AI tabs |

### Sidebar Features

- Session list with platform filter + text search + semantic search
- Transcript viewer (last 6 messages, expandable per message)
- Attention Engine modal (pre-compute before migrate)
- File System Access API — open local project folder, select files for context
- Export: copy raw / copy platform-formatted / download / download ZIP
- Keyboard shortcuts: `Ctrl+C` copy, `Ctrl+D` download, `Ctrl+A` select all, `Ctrl+Shift+C` Claude format
- Prompt Engine — apply reusable templates to migration
- Migration Quality Score — displayed after migration
- Plan badge (Free / Pro) + usage meter + upgrade modal
- Vault status indicator (connected / disconnected)
- MCP bridge status (running / offline)
- VS Code bridge status (online / offline)
- Capture health alert banner (amber, dismissible)
- Update-available banner (green, compares `extension-version.json`)

### Key Files

```
packages/browser-extension/src/
  background/service-worker.ts       Central orchestrator
  content/shared.ts                  runCapturePipeline, startSessionCapture
  content/{claude,chatgpt,...}.ts    Per-platform scrapers + injectors
  lib/
    capture/selector-registry.ts    Versioned CSS selector cascade
    capture/capture-validator.ts    Validation + stats
    capture/structural-detector.ts  DOM-geometry fallback
    capture/health-monitor.ts       Sliding-window health alerts
    attention-engine.ts             ONNX semantic scorer
    summarizer.ts                   Tier 1/2/3 summarization
    translator.ts                   Per-platform prompt formatter
    prompt-sanitizer.ts             Anti-injection + XML/MD sanitization
    capability-detector.ts          Device tier auto-detection
    db.ts                           IndexedDB (idb) wrapper
    semantic-index/index.ts         Vector index for semantic search
    prompt-engine/engine.ts         Reusable prompt templates
    quality/migration-scorer.ts     Post-migration quality scoring
    file-system/project-reader.ts   File System Access API indexer
    cloud-sync.ts                   Supabase vault sync
  sidebar/Sidebar.tsx                Main sidebar UI (2200+ lines)
```

---

## Package 2 — Web App

**Stack:** Next.js 14 · Supabase · TailwindCSS · shadcn/ui · Stripe · Razorpay · ZeptoMail · Vercel

### Pages

| Route | Status | Description |
|---|---|---|
| `/` | ✅ Live | Landing page — hero, features, pricing, FAQ |
| `/auth` | ✅ Live | Sign up / Log in (Supabase Auth) |
| `/login` | ✅ Live | Redirect alias |
| `/signup` | ✅ Live | Redirect alias |
| `/dashboard` | ✅ Live | Redirect to `/analytics` |
| `/analytics` | ✅ Live | Account overview + quick links |
| `/settings` | ✅ Live | Profile settings |
| `/settings/billing` | ✅ Live | Subscription + usage + cancel |
| `/settings/prompts` | ✅ Live | Prompt template management |
| `/settings/agents` | ✅ Live | Custom agent configs |
| `/settings/vault` | ✅ Live | Personal Supabase vault setup |
| `/pricing` | ✅ Live | Plan comparison + checkout |
| `/privacy` | ✅ Live | Privacy policy |
| `/terms` | ✅ Live | Terms of service |
| `/docs` | ⚠️ Stub | Documentation placeholder |
| `/migrate` | ⚠️ Stub | Web-based migration (not wired) |
| `/session/[id]` | ⚠️ Stub | Session detail view (not wired) |

### API Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/payments/subscription` | GET / POST | Read status or create checkout |
| `/api/payments/cancel` | POST | Cancel subscription |
| `/api/payments/status` | GET | Plan + usage for extension |
| `/api/payments/portal` | POST | Stripe billing portal |
| `/api/webhooks/stripe` | POST | Stripe event handler |
| `/api/webhooks/razorpay` | POST | Razorpay event handler |

### Payment System

- **Geo-routing**: IP → South Asia countries (IN, PK, BD, etc.) → Razorpay (INR) · everywhere else → Stripe (USD)
- **Plans**: Free · Pro (`$5/mo` or `₹199/mo`) · Team (defined, not launched)
- **Trial**: 14 days free on all paid plans
- **Free limits**: 50 Full Context migrations, 50 Smart Summary, 10 Attention Engine, 10 sessions, 6 prompt templates

### Email System (ZeptoMail SMTP)

| Email | Trigger |
|---|---|
| Pro activated | Stripe/Razorpay subscription created |
| Subscription cancelled | Stripe deleted / Razorpay halted |
| Payment failed | Stripe invoice failed / Razorpay payment failed |
| Confirm signup | Supabase Auth |
| Magic link / Reset password | Supabase Auth |
| Email changed / Reauthentication | Supabase Auth |
| Security notifications | Supabase Auth |

### Security

- Supabase RLS on all tables
- `env-guard.ts` blocks any `NEXT_PUBLIC_` leakage of secrets
- Rate limiter on all API routes
- HMAC signature verification on Stripe + Razorpay webhooks
- CSP headers via `next.config.mjs`

---

## Package 3 — MCP Server

**Package:** `@contextmover/mcp-server` (published to npm on `mcp-v*` tags)

Exposes ContextMover sessions and migration tools to AI agents (Claude Desktop, Cursor, Windsurf, etc.) via the Model Context Protocol.

### Tools

| Tool | Description |
|---|---|
| `list_sessions` | List all captured sessions with metadata |
| `get_session` | Get full transcript of a session by ID |
| `search_sessions` | Full-text search across all sessions |
| `semantic_search` | Vector similarity search across sessions |
| `migrate_context` | Trigger a migration to any target platform |
| `get_file_context` | Read local project files into context |
| `get_quality_report` | Score the quality of a past migration |
| `apply_prompt_template` | Apply a saved template to a migration payload |

### Setup (one-time)

```bash
npx @contextmover/mcp-server init
```

Add to your AI agent config (Claude Desktop example):
```json
{
  "mcpServers": {
    "contextmover": {
      "command": "npx",
      "args": ["-y", "@contextmover/mcp-server"]
    }
  }
}
```

---

## Package 4 — VS Code Extension

Runs a local HTTP bridge server on `127.0.0.1:49152`.

### Bridge API

| Endpoint | Description |
|---|---|
| `GET /health` | `{ status: "ok", port: 49152 }` |
| `GET /context` | Full IDE snapshot |
| `POST /context` | Store browser session mirror |

### IDE Snapshot Contents

- Active file: path, language, full content, cursor position, selection
- Open tabs (up to `contextmover.maxFilesInContext`)
- Workspace name + root path
- Git branch (`git rev-parse --abbrev-ref HEAD`)
- Git diff summary (`git diff --stat HEAD`)
- Up to 20 diagnostics (errors + warnings)

### VS Code Commands

- `ContextMover: Capture Context` — manual snapshot
- `ContextMover: Start Bridge` — start HTTP server

---

## Feature Map

### ✅ Fully Working

- 6-platform capture + injection with 4-layer resilience
- 3-tier summarization with auto capability detection
- 120k char priority prompt cap
- Per-platform prompt formatting (XML / Markdown / plain)
- Anti-injection preamble on all migrations
- Local-first IndexedDB storage
- Semantic search across sessions (ONNX vector index)
- Attention Engine pre-computation in sidebar
- File System Access API — project folder context
- Prompt Engine — reusable migration templates
- Migration Quality Scorer
- VS Code IDE bridge integration
- Personal Supabase Vault (optional cloud sync)
- MCP server with 8 tools
- Dual payment gateway (Stripe + Razorpay) with geo-routing
- 14-day free trial
- Subscription management + cancellation
- Full transactional email system (ZeptoMail)
- Supabase auth with custom branded email templates
- Freemium limit enforcement (server-side + UI)
- Update-available banner in extension
- CI/CD: tests on every push, auto-publish extension + MCP on tags

### ⚠️ Partially Working / Stubs

- `/docs` page — route exists, content is placeholder
- `/migrate` web route — exists but not wired to extension
- `/session/[id]` web route — exists but not wired
- Cloud sync (`cloud-sync.ts`) — implemented but UI toggle unclear
- Team plan — pricing types defined, no team-specific features built
- Status page — footer link present, page not built

### ❌ Not Built

- Firefox / Safari support
- Mobile UI (extension is desktop-only by design)
- Ollama / local model support
- Session sharing / export link
- Onboarding flow post-signup
- Real usage analytics dashboard (current `/analytics` is just quick links)
- Email open / click tracking
- Admin panel

---

## What Is Missing

### High Priority

1. **`/docs` page** — Empty stub. Users land here from the navbar and see nothing. Needs at minimum: getting started, platform setup, FAQ.
2. **Onboarding flow** — After signup there is no guided setup. Users don't know they need to install the extension. A 3-step onboarding (install → open → migrate) would significantly reduce churn.
3. **Real analytics dashboard** — `/analytics` shows only quick links. No migration count, no session count, no usage chart. Supabase `usage` table has the data but it is not visualized.
4. **Team plan features** — Team plan is in the pricing table and payment system but has no features differentiating it from Pro (no shared sessions, no team management, no seats).
5. **Session sharing** — No way to share a session with a teammate or export as a permalink.

### Medium Priority

6. **Error monitoring** — No Sentry / Datadog. Production errors in the extension or web app are invisible.
7. **Migration history** — No log of past migrations in the web dashboard or sidebar.
8. **Extension onboarding screen** — First-time extension open shows the full sidebar immediately. A short welcome card explaining the 3 steps would help.
9. **Status page** — Footer has a "Status ▸" link that goes nowhere (`href="#"`).
10. **Email preference center** — Users cannot unsubscribe from individual email types. Only full opt-out via Supabase.

### Low Priority

11. **Firefox / Edge support** — Uses `chrome.*` namespace exclusively. A WebExtension polyfill would cover Firefox/Edge.
12. **Dark/light theme toggle** — Dark-only throughout.
13. **Keyboard shortcut** (global) — No way to open sidebar from keyboard.
14. **ChatGPT o1 / o3 / Projects** — Newer ChatGPT UI variants may not be captured correctly.
15. **Perplexity Spaces** — Spaces UI is different from standard Perplexity chat.

---

## Improvements To Make

### Extension

| Improvement | Impact | Effort |
|---|---|---|
| Show migration history in sidebar | High | Medium |
| Add "Copy as Markdown" export for all sessions | High | Low |
| Persist Attention Engine task string across sessions | Medium | Low |
| Add session tagging / starring | Medium | Medium |
| Allow renaming sessions | Medium | Low |
| Show character count + tier used after migration | Medium | Low |
| Add "undo last migration" (re-inject previous) | Low | Medium |

### Web App

| Improvement | Impact | Effort |
|---|---|---|
| Build `/docs` with MDX content | High | Medium |
| Add real usage chart to `/analytics` | High | Medium |
| Add post-signup onboarding wizard | High | Medium |
| Build Team plan features (shared vault, seats) | High | High |
| Add Sentry error monitoring | High | Low |
| Add referral / affiliate tracking | Medium | Medium |
| Build admin panel (user list, revenue, usage) | Medium | High |
| Add email preference center | Medium | Medium |
| Add session sharing via signed URL | Medium | High |

### Infrastructure

| Improvement | Impact | Effort |
|---|---|---|
| Add Supabase DB schema migrations folder | High | Medium |
| Add `playwright` E2E tests for payment flows | High | High |
| Add feature flags (LaunchDarkly or custom) | Medium | Medium |
| Set up Vercel previews for PRs | Medium | Low |
| Add uptime monitoring (Better Uptime / Checkly) | Medium | Low |

---

## Missing Links & Broken Wiring

| Location | Issue | Fix needed |
|---|---|---|
| Footer → "Status ▸" | `href="#"` — goes nowhere | Build `/status` page or link to external uptime page |
| `/docs` navbar link | Route exists but page is empty | Add content or redirect to a hosted docs site |
| `/migrate` route | Page exists but not connected to extension sessions | Wire to extension API or remove |
| `/session/[id]` route | Page stub not linked from anywhere | Wire to extension data via Vault or remove |
| `cloud-sync.ts` | Implemented but no UI to enable/disable sync | Add toggle in `/settings/vault` |
| Team plan checkout | Pricing shows Team card, clicking it creates a payment but no team features activate | Build team features or hide the card |
| Extension → "Open Dashboard" emails | Links go to `contextmover.com/dashboard` which redirects to `/analytics` (just quick links) | Build real dashboard or update link target |
| MCP server bridge | MCP server calls `localhost:49001` but VS Code bridge runs on `49152` | Verify port alignment in `mcp-server/src/bridge/` |

---

## CI/CD & Release

### Continuous Integration (every push)

```
.github/workflows/ci.yml
  ├── pnpm install
  ├── pnpm --filter browser-extension test    (Vitest)
  ├── pnpm --filter browser-extension build
  └── pnpm --filter web build
```

### Extension Release (Chrome Web Store)

```bash
# 1. Bump version
./packages/browser-extension/scripts/release.sh 1.0.1

# This: bumps manifest.json → commits → tags ext-v1.0.1 → pushes
# CI then: tests → builds → zips → publishes to CWS → updates extension-version.json → creates GitHub Release
```

Required secrets: `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`

### MCP Server Release (npm)

```bash
git tag mcp-v1.0.1 && git push origin --tags
# CI: builds → publishes to npm → creates GitHub Release
```

Required secret: `NPM_TOKEN`

---

## Development Setup

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 10

### Install

```bash
pnpm install
```

### Browser Extension

```bash
pnpm --filter browser-extension dev
# Load packages/browser-extension/dist as unpacked extension in chrome://extensions
```

### Web App

```bash
cp packages/web/.env.example packages/web/.env.local
# Fill in: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
#          STRIPE_SECRET_KEY, RAZORPAY_KEY_SECRET, ZEPTO_SMTP_PASSWORD
pnpm --filter web dev
```

### VS Code Extension

```bash
cd packages/vscode-extension && pnpm dev
# Press F5 in VS Code to launch Extension Development Host
```

### MCP Server

```bash
pnpm --filter @contextmover/mcp-server build
node packages/mcp-server/dist/index.js
```

### Run All Tests

```bash
pnpm test
```

---

## Environment Variables (web app)

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Admin key (server-only) |
| `STRIPE_SECRET_KEY` | ✅ | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | ✅ | Stripe webhook signing secret |
| `STRIPE_PRO_PRICE_ID` | ✅ | Stripe Pro plan price ID |
| `RAZORPAY_KEY_ID` | ✅ | Razorpay key ID |
| `RAZORPAY_KEY_SECRET` | ✅ | Razorpay key secret |
| `RAZORPAY_WEBHOOK_SECRET` | ✅ | Razorpay webhook secret |
| `RAZORPAY_PRO_PLAN_ID` | ✅ | Razorpay Pro plan ID |
| `ZEPTO_SMTP_PASSWORD` | ✅ | ZeptoMail SMTP password |
| `NEXT_PUBLIC_APP_URL` | ✅ | `https://contextmover.com` |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | ✅ | Razorpay public key (client-side) |

---

## License

MIT — © 2026 ContextMover
