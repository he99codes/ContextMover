# ContextForge App Flow

This file explains how the application works in the order things happen at runtime.

The goal of ContextForge is:

1. Capture conversations from AI web apps.
2. Store them locally in the browser extension.
3. Optionally enrich them with current VS Code context.
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
  -> content script watches DOM
  -> extension service worker receives conversation data
  -> IndexedDB stores sessions locally
  -> popup/sidebar lists saved sessions
  -> user chooses a target platform and clicks Migrate
  -> service worker summarizes + translates the session
  -> service worker optionally fetches IDE context from VS Code bridge
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

Their job is:

1. Read the website DOM.
2. Convert visible chat messages into a normalized internal format.
3. Send those messages back to the extension.
4. Listen for `INJECT_CONTEXT` and paste text into the site's input.

### `background/`

The service worker is the central orchestrator:

1. receives messages from content scripts and UI
2. saves and reads sessions from IndexedDB
3. talks to the VS Code bridge
4. summarizes and translates context
5. sends migrated prompts into target tabs

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

1. session filtering by platform
2. transcript browsing
3. a detail screen
4. IDE context visibility state

## 3. Supported Websites

The extension injects content scripts based on `manifest.json`.

Supported platforms:

1. Claude
2. ChatGPT
3. Gemini
4. Grok

The manifest also grants access to:

1. browser tabs
2. storage
3. scripting APIs
4. `http://localhost:49152/*` for the VS Code bridge

## 4. Shared Message Shape

All platform-specific content scripts normalize messages into the same structure:

```ts
type Message = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};
```

Sessions use:

```ts
type ContextSession = {
  id: string;
  platform: "claude" | "chatgpt" | "gemini" | "grok";
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
};
```

This normalization is what makes cross-platform migration possible.

## 5. How Capture Starts

Every content script calls `startSessionCapture(...)` from `content/shared.ts`.

That helper does four important things:

1. creates a stable session id from the page URL
2. watches the page with a `MutationObserver`
3. re-scrapes messages whenever the DOM changes
4. sends `CAPTURE_SESSION` only when the snapshot actually changed

This is a nice design choice because each platform file only needs to define:

1. where to observe
2. how to scrape messages
3. how to inject text back later

## 6. Platform Capture Logic

Each website has its own DOM parser.

### ChatGPT

File: `packages/browser-extension/src/content/chatgpt.ts`

It:

1. finds elements with `data-message-author-role`
2. reads the role from the dataset
3. reads text from `.whitespace-pre-wrap` or falls back to `innerText`
4. sends normalized messages

For injection, it targets:

1. `#prompt-textarea`
2. fallback `[contenteditable='true']`

### Claude

File: `packages/browser-extension/src/content/claude.ts`

It:

1. reads `[data-testid="human-turn"]`
2. reads `[data-testid="ai-turn"]`
3. infers role from `data-testid`

For injection, it targets Claude's contenteditable editor and uses `document.execCommand("insertText", ...)`.

### Gemini

File: `packages/browser-extension/src/content/gemini.ts`

It:

1. reads `user-query .query-text`
2. reads `model-response .response-content`
3. infers role based on whether the node is inside `user-query`

For injection, it targets:

1. `rich-textarea [contenteditable='true']`
2. fallback `.ql-editor`

### Grok

File: `packages/browser-extension/src/content/grok.ts`

It:

1. reads elements whose class names include `UserMessage` or `AssistantMessage`
2. infers role from the class name

For injection, it supports both:

1. plain `textarea`
2. generic `contenteditable` inputs

## 7. How Data Reaches the Service Worker

After scraping, the content script sends:

```ts
chrome.runtime.sendMessage({
  type: "CAPTURE_SESSION",
  payload: {
    platform,
    sessionId,
    title,
    messages,
  },
});
```

The service worker listens with `chrome.runtime.onMessage.addListener(...)`.

It acts like a router for these message types:

1. `CAPTURE_SESSION`
2. `CAPTURE_MESSAGE`
3. `GET_SESSIONS`
4. `SYNC_OPEN_TABS`
5. `GET_SESSION`
6. `DELETE_SESSION`
7. `MIGRATE_CONTEXT`
8. `FETCH_IDE_CONTEXT`

## 8. Local Storage Layer

Storage lives in IndexedDB through `idb`.

File:

1. `packages/browser-extension/src/lib/db.ts`

Database details:

1. database name: `contextforge`
2. object store: `sessions`
3. key path: `id`
4. indexes: `platform`, `updatedAt`

This gives the extension a local-first model:

1. sessions are stored in the browser
2. migration still works even if VS Code is offline
3. the VS Code bridge is additive, not required

## 9. What Happens During Capture

When `CAPTURE_SESSION` reaches the service worker:

1. it checks whether the session already exists
2. preserves the original `createdAt` when updating
3. sets `updatedAt` using the latest message timestamp
4. writes the full session to IndexedDB

Then it does one more thing:

1. POSTs the session to `http://localhost:49152/context`

That bridge call is fire-and-forget.
If VS Code is not running, the extension ignores the failure.

This means browser context can be mirrored to the local IDE side, but the app does not depend on that mirror to keep working.

## 10. Popup Flow

File:

1. `packages/browser-extension/src/popup/Popup.tsx`

When the popup opens:

1. it sends `SYNC_OPEN_TABS`
2. the service worker scans open AI tabs
3. the worker injects a one-time scraper with `chrome.scripting.executeScript`
4. any discovered sessions are stored immediately
5. the popup loads all saved sessions
6. it checks bridge health at `http://localhost:49152/health`

The popup also refreshes session state every 4 seconds.

Important user action:

1. pick target platform
2. click `Migrate`

Then the popup:

1. finds an open tab for that target platform
2. focuses the tab
3. sends `MIGRATE_CONTEXT` to the service worker

## 11. Sidebar Flow

File:

1. `packages/browser-extension/src/sidebar/Sidebar.tsx`

The sidebar follows the same backend flow as the popup, but with a richer browsing experience.

It:

1. loads sessions
2. checks bridge health
3. fetches IDE context preview if the bridge is online
4. lets the user open a session detail screen
5. lets the user migrate from that detail screen

The sidebar refreshes every 5 seconds.

## 12. Syncing Open Tabs

`SYNC_OPEN_TABS` is useful because it captures currently open conversations without waiting for fresh DOM mutations.

The service worker:

1. queries tabs for each supported platform URL pattern
2. runs `scrapeSessionFromPage` inside each tab
3. reads the current transcript from the live page
4. stores it as a session if messages were found

This is basically a catch-up snapshot mechanism.

## 13. Migration Flow

This is the core feature.

When the UI sends:

```ts
{
  type: "MIGRATE_CONTEXT",
  payload: {
    sessionId,
    targetPlatform,
    targetTabId
  }
}
```

the service worker does this:

1. load the source session from IndexedDB
2. try to fetch IDE context from the VS Code bridge
3. summarize the conversation
4. translate it for the target platform format
5. send `INJECT_CONTEXT` into the target browser tab
6. return success or an error back to the UI

## 14. Summarization Logic

File:

1. `packages/browser-extension/src/lib/summarizer.ts`

The summarizer is intentionally simple and deterministic.

It estimates token count as:

1. `1 token ~= 4 chars`

Rules:

1. if conversation is below `3000` estimated tokens, keep it verbatim
2. if above threshold, summarize older messages
3. always keep the last `6` messages verbatim

The summary includes:

1. total message count
2. original goals or questions
3. key assistant outputs or decisions
4. up to 3 extracted code blocks
5. recent message tail verbatim

This makes the migration prompt smaller while preserving the latest conversational state.

## 15. Translation Logic

File:

1. `packages/browser-extension/src/lib/translator.ts`

After summarization, the app formats the prompt differently depending on the destination model.

### Claude target

Uses XML-like structure:

1. `<context_migration>`
2. `<migration_notice>`
3. `<previous_chat>`
4. optional `<current_codebase_state>`
5. `<instructions>`

### ChatGPT target

Uses markdown sections:

1. migrated session metadata
2. prior conversation history
3. optional current codebase state
4. instruction list

### Grok target

Uses the same markdown strategy as ChatGPT with a Grok-specific heading.

### Gemini target

Uses plain text section delimiters:

1. `[CONTEXTFORGE MIGRATION]`
2. `[PRIOR CONVERSATION]`
3. optional `[CURRENT CODE CONTEXT FROM IDE]`
4. `[TASK]`

This translator is the actual "context adapter" of the product.

## 16. Injecting Into the Target Tab

Once the prompt is built, the service worker sends:

```ts
{
  type: "INJECT_CONTEXT",
  prompt,
  platform: targetPlatform
}
```

The destination tab's content script receives it and writes the text into the site's input box.

Important detail:

1. the app prepares the prompt
2. the app inserts it into the text box
3. the app does not auto-submit the message

That is a sensible safety choice because the user can review the migrated prompt before sending.

## 17. VS Code Extension Flow

The VS Code side starts in:

1. `packages/vscode-extension/src/extension.ts`

On activation:

1. it creates a `ContextCollector`
2. reads `contextforge.bridgePort`
3. starts `BridgeServer`
4. registers commands
5. shows a status bar item

Commands:

1. `contextforge.captureContext`
2. `contextforge.startBridge`

## 18. IDE Snapshot Collection

File:

1. `packages/vscode-extension/src/context-collector.ts`

When the browser extension asks for `/context`, the collector builds an `IDESnapshot`.

That snapshot contains:

1. active file
2. open tabs
3. workspace name
4. workspace root
5. git branch
6. git diff summary
7. diagnostics
8. capture timestamp

### Active file

If there is an active editor, the collector includes:

1. full path
2. relative path
3. language id
4. full file content
5. current selection if any
6. cursor line

### Open files

It enumerates tab groups and keeps up to `contextforge.maxFilesInContext`.

### Git state

It shells out to:

1. `git rev-parse --abbrev-ref HEAD`
2. `git diff --stat HEAD`

So the bridge only returns a summary of working tree changes, not a full patch.

### Diagnostics

It includes up to 20 warning/error items from VS Code diagnostics.

## 19. How IDE Context Becomes Prompt Text

`ContextCollector.formatAsText(...)` turns the snapshot into prompt-friendly plain text.

It emits sections like:

1. workspace name
2. git branch
3. git diff summary
4. active file and content or selection
5. open file list
6. diagnostics

That string is what gets embedded into the migration prompt when the bridge is online.

## 20. Bridge Server API

File:

1. `packages/vscode-extension/src/bridge-server.ts`

The bridge exposes a tiny local HTTP API.

### `GET /health`

Used by popup and sidebar to detect whether the VS Code side is reachable.

Returns:

```json
{ "status": "ok", "port": 49152 }
```

### `GET /context`

Used during migration and sidebar inspection.

Returns:

1. `ideContext`
2. raw `snapshot`
3. `browserContext` mirrored from the extension

### `POST /context`

Used by the browser extension to push browser session data into the bridge.

The server stores it as `lastBrowserContext`.

This is a lightweight shared-memory handshake between browser state and IDE state.

## 21. End-to-End Example

Here is the full runtime story in practical terms:

1. You open `gemini.google.com`.
2. `gemini.ts` starts observing the page.
3. It scrapes visible chat turns.
4. It sends `CAPTURE_SESSION` to the service worker.
5. The service worker saves the session to IndexedDB.
6. The popup shows the saved Gemini conversation.
7. You open the extension popup.
8. The popup checks whether VS Code bridge is online.
9. You choose `Claude` as the target.
10. You click `Migrate`.
11. The service worker loads the Gemini session.
12. It requests current IDE context from `GET /context`.
13. It summarizes the conversation if needed.
14. It formats the prompt as Claude XML-style context.
15. It focuses the open Claude tab.
16. It sends `INJECT_CONTEXT` to the Claude content script.
17. The Claude script pastes the prompt into Claude's editor.
18. You review the inserted prompt and send it manually.

## 22. Design Choices That Matter

These are the main architectural ideas in this codebase:

### Local-first

Sessions are stored in browser IndexedDB, so the core experience does not depend on a server.

### Two-app architecture

Browser capture and IDE capture are separate, joined by a localhost bridge instead of a cloud backend.

### Per-platform adapters

Each AI website gets custom scrape and inject logic, but the app normalizes everything into one shared session format.

### Safe migration

The app injects prompts but does not auto-send them.

### Deterministic summarization

The summarizer is heuristic-based instead of model-based, so it is fast, offline, and predictable.

## 23. Where To Read Next

If you want to understand the code in the most useful order, read these files in sequence:

1. `packages/browser-extension/manifest.json`
2. `packages/browser-extension/src/content/shared.ts`
3. one platform file like `packages/browser-extension/src/content/gemini.ts`
4. `packages/browser-extension/src/background/service-worker.ts`
5. `packages/browser-extension/src/lib/db.ts`
6. `packages/browser-extension/src/lib/summarizer.ts`
7. `packages/browser-extension/src/lib/translator.ts`
8. `packages/browser-extension/src/popup/Popup.tsx`
9. `packages/vscode-extension/src/extension.ts`
10. `packages/vscode-extension/src/context-collector.ts`
11. `packages/vscode-extension/src/bridge-server.ts`

## 24. Short Mental Model

If you want one sentence:

ContextForge is a browser extension that captures AI chat sessions, stores them locally, optionally mixes in live VS Code context from a localhost bridge, then rewrites and injects that context into another AI platform using a platform-specific prompt format.
