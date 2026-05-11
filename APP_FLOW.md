# ContextMover App Flow

This file explains how the application works in the order things happen at runtime.

The goal of ContextMover is:

1. Capture conversations from AI web apps.
2. Store them locally in the browser extension.
3. Optionally enrich them with current VS Code context and project files.
4. Repackage that context for another target AI platform.
5. Inject the migrated prompt into the target platform's input box.

## 1. Big Picture

There are two separate apps working together:

1. `packages/browser-extension`
2. `packages/vscode-extension`

The browser extension is the main product the user sees.
The VS Code extension is a local helper that exposes IDE state over `http://127.0.0.1:49152`.

High-level flow:

```text
AI website tab
  -> content script runs capture pipeline (selector registry → validate → structural fallback)
  -> extension service worker receives conversation data
  -> IndexedDB stores sessions locally
  -> sidebar lists saved sessions with health alert banner
  -> user optionally pre-computes Attention Engine summary in sidebar
  -> user chooses a target platform and clicks Migrate
  -> service worker resolves summarization tier (1 / 2 / 3)
  -> service worker optionally fetches IDE context from VS Code bridge
  -> service worker optionally injects project file context
  -> priority-ordered prompt cap trims to 120k chars if needed
  -> target tab receives INJECT_CONTEXT
  -> content script pastes prompt into target site's input
```

## 2. Browser Extension Structure

The browser extension is split into four runtime parts:

1. `content/`
2. `background/`
3. `popup/`
4. `sidebar/`

### `content/`

These scripts run inside supported AI websites:

1. `chatgpt.ts`
2. `claude.ts`
3. `gemini.ts`
4. `grok.ts`
5. `deepseek.ts`
6. `perplexity.ts`

Their job is:

1. Run the capture pipeline via `runCapturePipeline()` from `shared.ts`.
2. Convert visible chat messages into a normalized internal format.
3. Send those messages back to the extension via `startSessionCapture()`.
4. Listen for `INJECT_CONTEXT` and paste text into the site's input.

### `background/`

The service worker is the central orchestrator:

1. receives messages from content scripts and UI
2. saves and reads sessions from IndexedDB
3. talks to the VS Code bridge
4. auto-detects summarization tier via `capabilityDetector`
5. summarizes and translates context (tier 1/2/3)
6. applies priority-ordered prompt cap (120k chars, equal for all platforms)
7. sends migrated prompts into target tabs

Main file:

1. `packages/browser-extension/src/background/service-worker.ts`

### `popup/`

The popup is the compact control room opened from the extension icon.

It lets the user:

1. see captured sessions
2. check bridge status
3. choose a target platform
4. trigger migration
5. delete saved sessions

### `sidebar/`

The side panel is a fuller UI for browsing transcripts and migrating from a detail view.

It adds:

1. capture health alert banner (amber warning when capture quality drops)
2. session filtering by platform
3. transcript browsing with expandable messages
4. semantic search across sessions
5. a detail screen with full transcript
6. Attention Engine pre-computation (AttentionModal)
7. project file context panel (FileSystem Access API)
8. file copy / download / platform-format export
9. IDE context visibility state

## 3. Supported Platforms

Six platforms are fully supported for both capture and injection:

| Platform | Capture file | Injection target |
|---|---|---|
| Claude | `claude.ts` | ProseMirror contenteditable |
| ChatGPT | `chatgpt.ts` | `#prompt-textarea` |
| Google Gemini | `gemini.ts` | `rich-textarea [contenteditable]` |
| xAI Grok | `grok.ts` | `textarea` / contenteditable |
| DeepSeek | `deepseek.ts` | `#chat-input` / contenteditable |
| Perplexity | `perplexity.ts` | `textarea` / contenteditable |

## 4. Shared Message Shape

All platform-specific content scripts normalize messages into the same structure:

```ts
type Message = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

type ContextSession = {
  id: string;
  platform: "claude" | "chatgpt" | "gemini" | "grok" | "deepseek" | "perplexity";
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
};
```

This normalization is what makes cross-platform migration possible.

## 5. Capture Pipeline (Resilience Layer)

Every content script now calls `runCapturePipeline(platform, scrapeMessages)` from `content/shared.ts` instead of calling `scrapeMessages` directly. This adds a multi-step resilience wrapper around every capture attempt.

### Step 1 — Selector Registry

File: `packages/browser-extension/src/lib/capture/selector-registry.ts`

Contains a versioned cascade of 4–6 CSS selectors per role per platform (user, assistant, streaming, codeBlock). `findElements(platform, role)` tries each in order and returns the first non-empty result. Never throws — all queries are try/caught.

### Step 2 — Capture Validation

File: `packages/browser-extension/src/lib/capture/capture-validator.ts`

`validateCapture(messages, platform, detectionMethod)` checks:

1. at least one message was found
2. at least one assistant message is present
3. role balance is reasonable (no extreme skew)
4. no excessively empty message content
5. no long run of consecutive same-role messages

Returns `{ valid, errors, warnings, stats }`.

### Step 3 — Structural Fallback

File: `packages/browser-extension/src/lib/capture/structural-detector.ts`

Only activated when Step 1 + Step 2 together produced zero assistant messages AND there is meaningful page content. Tries three strategies in order:

1. Alternating sibling containers inside the chat root
2. Visual alignment heuristic (right-biased = user; full-width = assistant)
3. Content characteristics (code/markdown/length → assistant)

Zero dependency on class names or testids — works even after a complete platform UI overhaul.

### Step 4 — Health Recording

File: `packages/browser-extension/src/lib/capture/health-monitor.ts`

`healthMonitor.record(...)` is called fire-and-forget after every capture attempt. It:

1. keeps a sliding window of the last 10 captures per platform
2. calculates success rate
3. writes a `CaptureAlert` to `chrome.storage.local` when the rate drops below 80%
4. auto-expires alerts after 24 hours

The sidebar reads these alerts on mount and shows an amber warning banner with a dismiss button.

### Full pipeline flow

```text
rawScrape() runs
  → validateCapture()
  → if 0 assistant messages AND page has chat content:
      detectByStructure() runs as last resort
      → validateCapture() again
  → healthMonitor.record() (fire-and-forget)
  → return messages
```

## 6. How Capture Starts

Every content script calls `startSessionCapture(...)` from `content/shared.ts`, with `scrapeMessages` now wrapped by `runCapturePipeline`.

That helper does four things:

1. creates a stable session id from the page URL via `resolveSessionId()`
2. watches the page with a `MutationObserver` (debounced 300ms)
3. re-runs the capture pipeline whenever the DOM changes
4. sends `CAPTURE_SESSION` only when the snapshot actually changed (hash check)

## 7. How Data Reaches the Service Worker

After scraping, the content script sends:

```ts
chrome.runtime.sendMessage({
  type: "CAPTURE_SESSION",
  payload: { platform, sessionId, title, messages },
});
```

The service worker routes these message types:

1. `CAPTURE_SESSION` — store/update session in IndexedDB
2. `GET_SESSIONS` — return all sessions
3. `GET_SESSION` — return one session by id
4. `DELETE_SESSION` — remove a session
5. `SYNC_OPEN_TABS` — snapshot all currently open AI tabs
6. `MIGRATE_CONTEXT` — full summarize + translate + inject pipeline
7. `FETCH_IDE_CONTEXT` — pull snapshot from VS Code bridge
8. `AUTH_GET_USER` — read auth state
9. `VAULT_GET_STATUS` — check Vault connectivity

## 8. Local Storage Layer

Storage lives in IndexedDB through `idb`.

File: `packages/browser-extension/src/lib/db.ts`

1. database name: `contextmover`
2. database version: `2`
3. object store: `sessions` (key: `id`, indexes: `platform`, `updatedAt`)

Local-first: all core features work without any server or VS Code running.

## 9. Summarization Tiers

File: `packages/browser-extension/src/lib/summarizer.ts`

The service worker picks a tier automatically using `capabilityDetector.getEffectiveTier()` unless the sidebar pre-computes and passes `precomputedSummary`.

### Tier 1 — Classic heuristic

Simple rule-based summarizer. Keeps last 6 messages verbatim, compresses older messages by extracting goals, code blocks, and key decisions. Always fast (<100ms). Offline.

### Tier 2 — Smart Summary (`summarizeIntelligent`)

Structured regex extraction. Produces:

1. `goal` — first user message (up to 600 chars)
2. `currentState` — last 6 user messages joined
3. `decisions` — verbatim decision sentences from assistant
4. `bugsFixed` — sentences matching bug/fix patterns
5. `completed` / `pending` — task tracking
6. `codeBlocks` — all fenced code blocks with language + path
7. `tail` — last 8 messages verbatim

Synchronous, no ML. ~100ms for 500 messages.

### Tier 3 — Attention Engine (`summarizeWithAttention`)

File: `packages/browser-extension/src/lib/attention-engine.ts`

Uses ONNX embeddings (all-MiniLM-L6-v2) to score every message chunk against a user task string. High-score messages are kept verbatim; low-score messages are compressed to one sentence. Code blocks above the attention threshold are preserved in full.

Because the Attention Engine requires browser APIs (window, document, WebGPU) it cannot run in the service worker. The correct path is:

1. User opens the sidebar's Attention tab (AttentionModal).
2. Attention Engine pre-computes summary + attentionMap inside the sidebar.
3. On migrate, sidebar passes `precomputedSummary` + `precomputedAttentionMap` to the service worker.
4. Service worker uses the fast path directly — no re-computation.

If the SW ever tries to run it directly, it falls back to tier 2 automatically.

### Tier auto-detection

`capabilityDetector` benchmarks the device on first run:

1. `minimal` → tier 2
2. `balanced` → tier 3
3. `full` → tier 3 (WebGPU-accelerated)

A load watchdog monitors CPU during tier-3 work and can downgrade to tier-2 mid-flight if the device is under pressure.

## 10. Translation Logic

File: `packages/browser-extension/src/lib/translator.ts`

`buildMigrationPrompt(payload)` formats the summarized context for the destination platform.

Guard: throws only when `payload.summary === undefined` AND `payload.intelligentSummary` is absent. An empty string `""` is valid (used internally for shell-size measurement during the prompt cap step).

### Platform formats

| Target | Format |
|---|---|
| Claude | XML: `<context_migration>`, `<meta>`, `<goal>`, `<progress>`, `<code>`, `<conversation_tail>` |
| ChatGPT | Markdown sections with structured headings |
| Gemini | Plain text with `[CONTEXTMOVER MIGRATION]` delimiters |
| Grok | Markdown (same as ChatGPT with Grok heading) |
| DeepSeek | Markdown (same as ChatGPT) |
| Perplexity | Markdown (same as ChatGPT) |

All platforms get:

1. anti-injection preamble (`ANTI_INJECTION_PREAMBLE`) to prevent prompt injection attacks
2. session metadata (source platform, date, message count, compression ratio)
3. goal / current state
4. decisions + bugs fixed
5. code blocks (newest first)
6. last N verbatim messages as conversation tail
7. optional IDE context block
8. optional project file context block
9. optional Attention Engine relevance block (tier 3 only)
10. optional Prompt Engine template injection

## 11. Priority-Ordered Prompt Cap

After translation, the prompt may exceed the editor's capacity. The cap is applied in this priority order:

1. **P1** — metadata, goal, current state, decisions (always kept)
2. **P2** — code blocks (oldest dropped first until it fits)
3. **P3** — last 6 verbatim messages + instructions (always kept)
4. **Tier-3 trim** — if still over cap, summary is head/tail trimmed with a `[trimmed]` marker
5. **Last resort** — flat string slice if all else fails

**Cap: 120,000 chars for all platforms equally. No platform discrimination.**

## 12. Project File Context (File System Access API)

File: `packages/browser-extension/src/lib/file-system/`

The sidebar lets the user open a local project folder via the browser File System Access API. Files are indexed into memory by `projectReader`. The user selects files for context, and `fileContextBuilder` formats them per target platform:

1. Claude: `<project_files>` XML
2. ChatGPT / Grok: Markdown code blocks
3. Gemini: plain `[PROJECT FILES]` section
4. Others: raw with `=== path ===` separators

Token estimate (`chars / 4`) is shown with a color-coded warning (green <50k, amber 50–100k, red >100k).

### File actions in sidebar

1. Copy raw / Copy for platform (clipboard)
2. Copy path
3. Download file (single)
4. Download as ZIP (multi, JSZip)
5. Context menu + inline copy button on hover
6. Keyboard shortcuts: Ctrl+C copy, Ctrl+D download, Ctrl+A select all, Ctrl+Shift+C Claude format

Selected files are passed as `projectContext` in the `MIGRATE_CONTEXT` payload. The service worker appends them after the VS Code bridge context.

## 13. Vault (Optional Cloud Sync)

The sidebar checks for a connected personal Supabase Vault instance. If connected, session storage can be synced to the cloud. Without Vault, all sessions are local-only (IndexedDB). Vault is always opt-in and user-owned.

## 14. Popup Flow

File: `packages/browser-extension/src/popup/Popup.tsx`

When the popup opens:

1. it sends `SYNC_OPEN_TABS`
2. the service worker scans all open AI tabs
3. injects one-time scrapers with `chrome.scripting.executeScript`
4. discovered sessions are stored immediately
5. the popup loads saved sessions
6. checks bridge health at `http://localhost:49152/health`

User picks a target platform and clicks `Migrate`. The popup finds an open tab for that platform, focuses it, and sends `MIGRATE_CONTEXT`.

## 15. Sidebar Flow

File: `packages/browser-extension/src/sidebar/Sidebar.tsx`

On open:

1. reads `chrome.storage.local` for any active `CaptureAlert` — shows amber banner if found
2. loads all sessions (polls every 30s, instant on `SESSIONS_UPDATED` broadcast)
3. checks VS Code bridge + Vault connectivity
4. loads Attention Engine pre-computation state if available

User can:

1. filter sessions by platform
2. search semantically via the Attention Engine
3. open a session detail screen (last 6 messages shown, expandable)
4. pre-compute Attention Engine summary (AttentionModal)
5. open project folder and select files
6. migrate with one click from the detail screen

## 16. Full Migration Flow

When the UI sends `MIGRATE_CONTEXT`:

```
Stage 1 — validate payload
Stage 2 — locate source session in IndexedDB
Stage 3 — check for streaming (abort if target is mid-stream)
Stage 4 — load full session messages
Stage 5 — resolve tier and summarize:
          fast path if precomputedSummary present
          otherwise: tier 3 → tier 2 → tier 1 cascade with fallbacks
Stage 6 — fetch IDE context from VS Code bridge (fire-and-forget)
          append project file context (from payload.projectContext)
          build prompt via buildMigrationPrompt()
          apply priority-ordered 120k cap
          optionally inject Prompt Engine template
Stage 7 — domain-whitelist check on target tab URL
          send INJECT_CONTEXT to target tab content script
Stage 8 — return { success: true } to UI
```

## 17. Injecting Into the Target Tab

The service worker sends:

```ts
{ type: "INJECT_CONTEXT", prompt, platform: targetPlatform }
```

The content script writes the text into the site's input using the most compatible method available:

1. React synthetic event (nativeInputValueSetter + dispatchEvent)
2. `document.execCommand("insertText")`
3. direct `.value` assignment
4. clipboard paste as last resort

**The app never auto-submits.** The user reviews and sends manually.

## 18. VS Code Extension Flow

File: `packages/vscode-extension/src/extension.ts`

On activation:

1. creates `ContextCollector`
2. reads `contextmover.bridgePort` (default 49152)
3. starts `BridgeServer`
4. registers commands: `contextmover.captureContext`, `contextmover.startBridge`
5. shows status bar item

### IDE Snapshot

`ContextCollector` builds an `IDESnapshot` containing:

1. active file (path, language, full content, selection, cursor line)
2. open tabs (up to `contextmover.maxFilesInContext`)
3. workspace name + root
4. git branch (`git rev-parse --abbrev-ref HEAD`)
5. git diff summary (`git diff --stat HEAD`)
6. up to 20 diagnostics (errors + warnings)

`formatAsText()` turns this into prompt-friendly plain text embedded in the migration context.

### Bridge API

`GET /health` → `{ status: "ok", port: 49152 }`
`GET /context` → `{ ideContext, snapshot, browserContext }`
`POST /context` → stores browser session mirror as `lastBrowserContext`

## 19. End-to-End Example

1. You open `deepseek.com` and have a 300-message coding session.
2. `deepseek.ts` runs `runCapturePipeline("deepseek", scrapeMessages)` on every DOM change.
3. Capture is validated — 150 user + 150 assistant messages found via registry selectors.
4. Health monitor records success (100% in window).
5. `CAPTURE_SESSION` is sent; service worker stores the session in IndexedDB.
6. You open the sidebar — session appears in the list.
7. You open the Attention tab, type your task, click "Compute" — Attention Engine pre-computes the summary.
8. You open your project folder, select 3 files to include.
9. You pick `Claude` as target and click `Migrate`.
10. Service worker uses the pre-computed summary (fast path, tier 3).
11. Bridge is offline — IDE context skipped.
12. Project file context (27k chars) is appended.
13. Prompt is built at 138k chars → priority cap trims to 120k (oldest code blocks dropped first).
14. Claude tab is found and verified by domain whitelist.
15. `INJECT_CONTEXT` is sent to `claude.ts`.
16. Prompt is pasted into Claude's ProseMirror editor.
17. You review and hit Enter.

## 20. Design Choices That Matter

### Local-first
Sessions live in IndexedDB. The VS Code bridge and Vault are additive, never required.

### Six-platform parity
All platforms get identical capture resilience, identical prompt cap limits, and identical format quality.

### Resilient capture
Four-layer capture pipeline means a CSS class rename on any platform cannot break capture entirely.

### Three-tier summarization
Tier selection is automatic based on device capability. The sidebar can always pre-compute to guarantee the best possible quality without blocking the service worker.

### Safe migration
Prompts are injected but never auto-sent. The user is always the last step.

### Equal prompt limits
All six platforms share the same 120k char cap. No platform gets less context than another.

### Anti-injection security
Every migration prompt begins with `ANTI_INJECTION_PREAMBLE` to block prompt-injection attacks embedded in captured conversations.

## 21. Key File Map

```
packages/browser-extension/src/
  background/
    service-worker.ts           — central orchestrator
  content/
    shared.ts                   — runCapturePipeline, startSessionCapture, setPromptInputValue
    claude.ts / chatgpt.ts / gemini.ts / grok.ts / deepseek.ts / perplexity.ts
  lib/
    capture/
      selector-registry.ts      — versioned CSS selector fallback cascade
      structural-detector.ts    — DOM-structure last-resort detection
      capture-validator.ts      — per-capture validation + stats
      health-monitor.ts         — sliding-window health tracking + alerts
    attention-engine.ts         — ONNX embedding scorer
    summarizer.ts               — tier 1/2/3 summarization
    translator.ts               — per-platform prompt formatter
    prompt-sanitizer.ts         — anti-injection + XML/MD sanitization
    capability-detector.ts      — device tier auto-detection
    db.ts                       — IndexedDB (idb) wrapper
    types.ts                    — Message, ContextSession, MigrationPayload, etc.
    file-system/
      project-reader.ts         — File System Access API folder indexer
      context-builder.ts        — per-platform project file formatter
      file-copier.ts            — copy / download / zip / token estimate
  sidebar/
    Sidebar.tsx                 — main sidebar UI
    MigrationModal.tsx          — migration options modal

packages/vscode-extension/src/
  extension.ts                  — VS Code activation
  context-collector.ts          — IDE snapshot builder
  bridge-server.ts              — local HTTP bridge (port 49152)
```

## 22. Short Mental Model

ContextMover captures AI chat sessions from six platforms using a resilient multi-layer pipeline, stores them in browser IndexedDB, optionally enriches them with VS Code IDE context and local project files, then compresses and reformats the context using a three-tier summarization system before injecting it into any target AI platform — all locally, with no required cloud backend.
