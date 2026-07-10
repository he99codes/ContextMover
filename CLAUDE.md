# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ContextMover captures AI chat conversations, compresses them, and re-injects them into any AI platform ("migration"). It is a full product: a Chrome MV3 extension, a Next.js web app, and an MCP server.

**Repo-root gotcha:** the repo root *is* the browser extension (`package.json` name `browser-extension`, with `src/`, `manifest.json`, `vite.config.ts`, and the built `dist/`). The `pnpm-workspace.yaml` also declares `packages/*`, which contains `web/` (Next.js app) and `mcp-server/`. `packages/browser-extension/` is a **stale nested clone with its own `.git`** — ignore it; the live extension code is the repo root's `src/`.

## Commands

Run from the repo root for the extension:

```bash
pnpm dev            # vite dev server (HMR extension build)
pnpm build          # tsc --noEmit && vite build → dist/  (load dist/ unpacked in Chrome)
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint src --ext .ts,.tsx
pnpm test           # vitest run (all)
pnpm test:watch     # vitest watch
pnpm exec vitest run src/lib/__tests__/math.test.ts   # single test file
pnpm exec vitest run -t "substring of test name"       # single test by name
```

Tests live in `__tests__/` folders and are matched by `src/**/*.test.ts` (see `vitest.config.ts`, `environment: "node"`). The `@/` alias maps to `src/`.

Web app and MCP server are separate packages with their own scripts:

```bash
pnpm --filter web dev|build|typecheck        # Next.js 14 app (contextmover.com)
pnpm --filter @contextmover/mcp-server build|dev   # MCP server (better-sqlite3, express, ws)
```

## Architecture

The extension is a message-passing system centered on the **service worker**. Everything flows through it via `chrome.runtime` messages shaped `{ type: "SCREAMING_SNAKE", ... }`.

**Capture (content scripts → SW).** One content script per platform (`src/content/{claude,chatgpt,gemini,grok,perplexity,deepseek}.ts`), plus `shared.ts` and a `fetch-interceptor.ts` (page-context network sniffing bridged via `interceptor-bridge.ts`). Capture is a resilient cascade in `src/lib/capture/`: versioned selector registry → `capture-validator` (role balance/content sanity) → `structural-detector` (class-free DOM geometry fallback) → `health-monitor` (sliding-window alerts, emits `SCRAPER_BROKEN`). Content scripts watch the DOM with MutationObserver + SPA-navigation hooks and send `CAPTURE_SESSION`.

**Service worker (`src/background/service-worker.ts`).** The hub. Persists sessions to IndexedDB (`src/lib/db.ts` uses both `idb` and `dexie`), then on migration runs: capability detection (`capability-detector.ts`) → **3-tier summarization** (`summarizer.ts`: Tier 1 heuristic keep-last-N, Tier 2 regex/scoring extraction, Tier 3 ONNX attention) → per-platform formatting (`translator.ts`: Claude=XML, ChatGPT/others=Markdown, Gemini=plain) → priority cap → `INJECT_CONTEXT` to the target tab. Tier selection can pause the SW on a gate awaiting `MIGRATION_TIER_CONFIRMED` from the sidebar.

**Offscreen ML (`src/offscreen/`).** Service workers can't run heavy WASM/ML, so `@xenova/transformers` (ONNX MiniLM-L6-v2) runs in an offscreen document / worker for embeddings and the attention engine. `src/lib/semantic-index/` builds the vector index for semantic search; `src/lib/inference/embedder.ts` wraps the model.

**UI.** `src/sidebar/` (React, the main surface: session list, semantic search, transcript viewer, attention modal, quality score, plan/usage, vault/MCP status) and a popup. Built via `@crxjs/vite-plugin`.

**Cloud & sync (all additive over local IndexedDB).** `src/lib/supabase.ts` + `cloud-sync.ts` (auth, prompt templates, usage, subscriptions, vault); `src/lib/drive/` (Google Drive appdata sync, independent of Supabase); `src/lib/user-vault/` and `src/lib/mcp/` (bridge to the local MCP server). Server-side intelligence can be delegated via `server-intelligence-client.ts` and toggled by `remote-config.ts`.

**Supabase.** SQL schema and ordered migrations in `supabase/migrations/` (`YYYYMMDD_*.sql`); edge functions in `supabase/functions/`. The web app's payments (Stripe + Razorpay) and admin/usage RPCs live here.

## Build gotchas

- WASM runtimes are **not bundled** — `vite.config.ts` has custom `closeBundle` plugins that copy `tree-sitter.wasm` to `dist/` root (must match `chrome.runtime.getURL('tree-sitter.wasm')`) and copy transformers WASM to `dist/assets/`, and strip a duplicate `dist/public/`. If ML/parsing breaks at runtime after a build change, check these plugins first.
- `manifest.json` pins `host_permissions` to the six supported AI hosts plus `contextmover.com`, `googleapis.com`, `huggingface.co`, `cdn.jsdelivr.net`, and `localhost:49152` (the local MCP server). Adding a platform means: content-script match + host permission + a content script + a selector registry entry + a translator/summarizer path.
- Release: `scripts/release.sh`; publishing is tag-driven (`ext-v*` → Chrome Web Store, `mcp-v*` → npm) via `.github/workflows/`.

## Note on AGENTS.md

`AGENTS.md` is a generic (project-agnostic) fail-fast editing workflow: grep-verify-before-and-after edits, and always run the build/typecheck after each change. Nothing in it is specific to this codebase.
