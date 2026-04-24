# ContextForge — Full Working Flow

A complete walk-through of how a conversation on one AI platform (e.g. Claude) ends up as a rich prompt injected into another (e.g. ChatGPT), broken down stage-by-stage.

---

## 0. Components at a glance

```
┌─────────────────────────┐     ┌──────────────────────────┐     ┌────────────────────────┐
│  Source AI Tab          │     │  Extension (MV3)         │     │  Target AI Tab         │
│  (Claude / ChatGPT /    │     │  ├── service-worker.ts   │     │  (Claude / ChatGPT /   │
│   Gemini / Grok)        │     │  │   (background)        │     │   Gemini / Grok)       │
│                         │     │  ├── content scripts     │     │                        │
│  ┌──────────────────┐   │     │  │   (per platform)      │     │  ┌─────────────────┐   │
│  │ content script   │──►│     │  ├── IndexedDB (sessions)│     │  │ content script  │   │
│  │ scrapes DOM      │   │ ──► │  ├── Summarizer          │ ──► │  │ injects prompt  │   │
│  └──────────────────┘   │     │  ├── Translator          │     │  │ into composer   │   │
│                         │     │  └── Sidebar UI (React)  │     │  └─────────────────┘   │
└─────────────────────────┘     └──────────────────────────┘     └────────────────────────┘
```

Six stages run end-to-end. Each stage has diagnostic logs so you can pinpoint which one breaks if the pipeline fails.

---

## Stage 1 — Capture (content script → scrape DOM)

**Who**: `src/content/claude.ts`, `chatgpt.ts`, `gemini.ts`, `grok.ts` — one per platform.
**When**: On page load, on visibility change, and every time the conversation DOM mutates (debounced 300 ms).
**Where logs appear**: DevTools on the **AI tab** itself (F12 on claude.ai, etc.).

### Lifecycle

1. **Extension install or reload**
   `service-worker.onInstalled` reads the compiled manifest's `content_scripts[]` and calls `chrome.scripting.executeScript` on every already-open matching tab. This is required because MV3 does **not** auto-inject into existing tabs — without this step, you would have to manually F5 every AI tab after updating the extension.

2. **Content script boots** → prints `[ContextForge] <Platform> content script loaded`.

3. **`startSessionCapture` (shared.ts)** attaches a `MutationObserver` on `main` (or `chat-window` for Gemini). It also:
   - generates a stable `sessionId` from the URL (so revisiting a thread updates the same record)
   - re-generates the ID on SPA navigation (URL change)
   - runs an initial capture after 1 s
   - re-captures on `visibilitychange` and `popstate`

4. **Every capture call** runs `scrapeMessages()`:

   - **Claude** uses four strategies, falling through until assistant messages are found:
     - S1 testid: `[data-testid="user-message"]` + `[data-testid="ai-turn" | "assistant-message"]`
     - S2 legacy testid: `human-turn` / `ai-turn`
     - S3 class: `[class*="font-claude-message"]`
     - **S4 structural** (the safety net): uses the KNOWN-WORKING user-message selector as an anchor, walks up the DOM until it finds a conversation container (≥ N children), then tags every child without a user-message as an assistant turn. Survives any testid/class rename.
   - **ChatGPT** uses `[data-message-author-role]` with an outermost-only filter and a streaming guard (`result-streaming`, `data-is-streaming`).
   - **Gemini** uses `user-query .query-text` and `model-response .response-content`.
   - **Grok** uses `[class*="UserMessage"]` / `[class*="AssistantMessage"]` with outermost-only filter.

5. **`extractMessageContent` (shared.ts)** for each matched element:
   - Clones the node (so the live UI is untouched)
   - Converts `<pre><code>` blocks to fenced markdown **before** stripping — preserves code with language tags
   - Strips UI chrome (`button`, `svg`, `[role="button"]`, `[role="toolbar"]`, copy/action/retry/thumbs/feedback testids, tooltip classes)
   - `[role="group"]` is INTENTIONALLY NOT stripped — Claude wraps response content in `role="group"` divs
   - Uses a tree-walker-based text extractor (works on detached clones; `innerText` doesn't)

6. **Diagnostic output** logged on the AI tab console:
   ```
   [ContextForge:claude] S1 testid: user=10 asst=0
   [ContextForge:claude] S2 legacy: asst=0
   [ContextForge:claude] S3 class:  asst=0
   [ContextForge:claude] S4 structural: container has 21 children, userAnchors=10
   [ContextForge:claude] S4 structural: asst=10
   [ContextForge:claude] FINAL: 20 msgs (user=10 asst=10)
   [ContextForge:claude] preview: [{role: "user", preview: "..."}, {role: "assistant", preview: "..."}, ...]
   ```

7. **Snapshot key dedup**: a hash of `(messageCount + lastRole + lastContent)` prevents spamming CAPTURE_SESSION for identical state.

8. **Send** → `chrome.runtime.sendMessage({ type: "CAPTURE_SESSION", payload: { platform, sessionId, title, messages } })`.

---

## Stage 2 — Service worker receives CAPTURE_SESSION

**Who**: `src/background/service-worker.ts` → `handleCaptureSession`.
**Where logs appear**: Service worker console (`chrome://extensions` → Inspect service worker).

```
[ContextForge:sw] Stage2 — CAPTURE_SESSION received: platform=claude
                  session=claude-abc total=20 user=10 assistant=10
```

If `assistant === 0 && user > 0`, it logs `ASSISTANT MESSAGES MISSING in incoming payload. Bug is in Stage1.`

The payload is merged with the existing session (preserving `createdAt`) and passed to Stage 3.

---

## Stage 3 — IndexedDB persistence + readback verification

**Who**: `src/lib/db.ts` (idb wrapper) via `handleCaptureSession`.

- Writes the session record to the `sessions` object store keyed by `sessionId`.
- Immediately reads it back and counts roles:
  ```
  [ContextForge:sw] Stage3 — DB readback: total=20 user=10 assistant=10
  ```
- If readback shows `assistant=0` when the incoming payload had non-zero, the bug is DB-level (never happens in practice; idb is reliable).
- Also broadcasts `SESSIONS_UPDATED` on the runtime channel so the sidebar refreshes instantly instead of waiting for its 5 s poll.
- Fire-and-forget POST to `http://localhost:49152/context` (the optional VS Code bridge).

---

## Stage 4 — Migration: load session

**Who**: `handleMigrateContext` in service-worker.ts. Triggered when the sidebar sends `MIGRATE_CONTEXT`.

```
[ContextForge:sw] Stage4 — session loaded: total=20 user=10 assistant=10
```

Gates:
- No session found → hard error `"Session not found in storage."`
- Zero messages → hard error `"Session has no messages."`
- Zero assistant messages → **warning only** (proceeds with degraded context instead of blocking).

---

## Stage 5 — Summarizer (build structured context)

**Who**: `src/lib/summarizer.ts` → `summarize(messages)`.

Estimates tokens (~4 chars each). Returns a `SummaryResult` with two fields:
- `content` (legacy plain-text summary, kept for backward compatibility)
- `extracted` (the structured object used by the translator):

```ts
{
  goal:             string   // inferred from first user message
  currentFocus:     string   // inferred from last user message
  completed:        string[] // recent assistant verbs: "implemented X", "fixed Y"
  pending:          string[] // questions from user / open threads
  decisions:        string[] // phrases like "we decided to use X"
  facts:            string[] // surfaced file paths, API names, config values
  codeBlocks:       [{ language, source, content }, ...]   // NEVER truncated
  conversationTail: Message[]                              // last N verbatim (user + assistant)
}
```

Logs:
```
[ContextForge:sw] Stage5 — calling summarizer with 20 messages
[ContextForge:sw] Stage5 — summarizer done: mode=structured tokens~4200
                  codeBlocks=3 tailMessages=6
```

If `tail.filter(m => m.role === "assistant").length === 0` a warning is emitted.

Token threshold: ~3000. Under the threshold → verbatim passthrough. Over → summarize older turns, keep the tail verbatim.

---

## Stage 6 — Translator (build platform-specific prompt)

**Who**: `src/lib/translator.ts` → `buildMigrationPrompt`.

Each platform gets a different format, because each LLM reads best in its native idiom:

| Platform | Format |
|----------|--------|
| **Claude** | Strict XML (`<migrated_context>`, `<previous_conversation>`, `<code_context>`, `<current_focus>`, `<instructions>`) |
| **ChatGPT** | `##` markdown headings |
| **Gemini** | Plain text with `[SECTION]` delimiters |
| **Grok** | Casual markdown |

All four include:
1. Metadata (source platform, timestamp, session ID)
2. Primary goal / current focus
3. Completed items, pending items, decisions, facts
4. Code blocks — **never** summarized, always verbatim
5. Conversation tail — last 6 messages verbatim (both roles)
6. IDE context block if the VS Code bridge was online
7. Instructions telling the target model to continue from the current focus

Logs:
```
[ContextForge:sw] Stage6 — prompt built: length=4821 chars, target=chatgpt
[ContextForge:sw] Stage6 — prompt preview (first 400 chars): ...
```

Gate: if `prompt.length < 500`, abort with an error (catastrophic context loss).

---

## Stage 7 — Tab focus + injection

**Who**: `handleMigrateContext` continued, plus the target-tab content script.

1. `chrome.tabs.update(targetTabId, { active: true })` + `chrome.windows.update({ focused: true })`.
2. **300 ms delay** (Sidebar.tsx): required for the OS window manager to actually bring the tab forward before we try to `sendMessage`.
3. `chrome.tabs.sendMessage(targetTabId, { type: "INJECT_CONTEXT", prompt, platform })`.
4. If `sendMessage` fails with `"Receiving end does not exist"`, the service worker returns a friendly `"Open the AI platform in the active tab, then try again"` error.
5. Target-tab content script receives `INJECT_CONTEXT`, runs `waitForAnyElement` (polls all editor selectors in parallel every 100 ms up to 4 s), finds the composer, and calls `setPromptInputValue`.

### `setPromptInputValue` details (shared.ts)

- **Plain `<textarea>`**: uses the native `HTMLTextAreaElement.prototype.value` setter + `input` + `change` events so React's fiber reconciler updates.
- **ContentEditable** (ProseMirror / React 18 / Quill / Angular):
  1. `document.execCommand("selectAll")` — CRITICAL. Using `execCommand("delete")` desynchronises React 18's fiber state; `selectAll → insertText` is the only sequence all four editors accept.
  2. `document.execCommand("insertText", false, text)`
  3. Fallback A: `input.innerText = text` + synthetic `InputEvent`
  4. Fallback B: `input.textContent = text` + synthetic `InputEvent`

Logs:
```
[ContextForge:sw] Stage6 — injection confirmed in tab 123
```

---

## End-to-end log timeline (happy path)

```
── AI SOURCE TAB CONSOLE ────────────────────────────────────────────
[ContextForge] Claude content script loaded
[ContextForge] Capture triggered for claude
[ContextForge:claude] testids on page: ai-turn, user-message, ...
[ContextForge:claude] S1 testid: user=10 asst=10
[ContextForge:claude] FINAL: 20 msgs (user=10 asst=10)
[ContextForge:claude] preview: [...]
[ContextForge] Sending CAPTURE_SESSION for session: claude-xyz

── SERVICE WORKER CONSOLE ───────────────────────────────────────────
[ContextForge ServiceWorker] Received message: CAPTURE_SESSION
[ContextForge:sw] Stage2 — CAPTURE_SESSION received: ... user=10 assistant=10
[ContextForge:sw] Stage3 — DB readback: total=20 user=10 assistant=10

── USER CLICKS "MIGRATE TO CHATGPT" IN SIDEBAR ──────────────────────
[ContextForge ServiceWorker] Received message: MIGRATE_CONTEXT
[ContextForge:sw] Stage4 — session loaded: total=20 user=10 assistant=10
[ContextForge:sw] Stage5 — calling summarizer with 20 messages
[ContextForge:sw] Stage5 — summarizer done: mode=structured tokens~4200 codeBlocks=3 tailMessages=6
[ContextForge:sw] Stage6 — prompt built: length=4821 chars, target=chatgpt
[ContextForge:sw] Stage6 — prompt preview (first 400 chars): ...
[ContextForge:sw] Stage6 — injection confirmed in tab 456

── CHATGPT TAB CONSOLE ──────────────────────────────────────────────
[ContextForge] ChatGPT content script received INJECT_CONTEXT
(prompt appears in composer, ready for user to hit Send)
```

---

## Key design decisions (and why)

| Decision | Why |
|----------|-----|
| Stable session ID from URL hash | Revisiting the same thread updates the record instead of creating a duplicate |
| Four-strategy Claude scraper | Claude's DOM testids drift frequently; S4 structural survives any rename |
| `role="group"` NOT stripped | Claude wraps response content in `role="group"` — stripping empties every assistant |
| Debounced MutationObserver (300 ms) | Streaming AI responses mutate the DOM once per token; undebounced = 200+ scrapes/sec |
| `selectAll → insertText` instead of `delete → insertText` | React 18 fiber reconciler silently ignores the second pattern |
| `waitForAnyElement` (parallel) vs `waitForElement` (sequential) | Avoids 1 s per selector — injection starts within 100 ms |
| Instant-refresh broadcast (`SESSIONS_UPDATED`) | Sidebar updates immediately instead of waiting 5 s poll |
| MV3 onInstalled re-injection | Chrome does NOT inject content scripts into already-open tabs on extension reload — this is the fix |
| Code blocks never summarized | Losing code = losing the entire point of the migration |
| Conversation tail always verbatim (both roles) | Preserves the exact phrasing of the last exchange — what the new AI continues from |

---

## Where to look when something breaks

| Symptom | Check |
|---------|-------|
| `FINAL: N msgs (user=X asst=0)` in AI tab console | Stage 1 — scraper selectors drifted. Read `testids on page` log, add/adjust strategy |
| No `[ContextForge] Capture triggered` log on the AI tab | Content script not running. Reload the extension (onInstalled will re-inject) or F5 the tab |
| Stage 2 log missing when you expect a capture | Content script ran but `CAPTURE_SESSION` didn't fire — check snapshot-key dedup or messages array |
| Stage 3 readback differs from Stage 2 | IndexedDB write failed (corruption or quota) — very rare |
| Stage 4 shows `assistant=0` but Stage 2 was correct | Stale session in DB from pre-fix code; reload the source tab to force overwrite |
| Stage 6 prompt `< 500 chars` | Summarizer discarded too much. Check `originalTokenEstimate` and the extracted object |
| `"Receiving end does not exist"` error on migrate | Target tab's content script not loaded — F5 the target tab |
| Prompt appears in composer but empty | `setPromptInputValue` fallback chain failed — check the editor type (textarea vs contenteditable) |

---

## File map

```
packages/browser-extension/
├── manifest.json                              permissions, content scripts, side_panel
├── src/
│   ├── background/service-worker.ts           Stages 2, 3, 4, 5, 6, 7 + onInstalled re-injection
│   ├── content/
│   │   ├── shared.ts                          MutationObserver, extractMessageContent,
│   │   │                                      setPromptInputValue, waitForAnyElement
│   │   ├── claude.ts                          Stage 1 — 4-strategy scraper + injector
│   │   ├── chatgpt.ts                         Stage 1 scraper + injector
│   │   ├── gemini.ts                          Stage 1 scraper + injector
│   │   └── grok.ts                            Stage 1 scraper + injector
│   ├── lib/
│   │   ├── db.ts                              IndexedDB wrapper (idb)
│   │   ├── types.ts                           Message, ContextSession, ExtractedContext, MigrationPayload
│   │   ├── summarizer.ts                      Stage 5
│   │   ├── translator.ts                      Stage 6 — per-platform prompt builders
│   │   └── platform-tabs.ts                   find/focus tabs by platform URL
│   └── sidebar/
│       └── Sidebar.tsx                        React UI, session list, migrate button,
│                                              SESSIONS_UPDATED listener, 300ms focus delay
```

---

That's the entire pipeline. Every stage is observable in one of two consoles (AI tab for Stage 1, service worker for Stages 2–7). Every stage has a guard that logs an error when its invariant breaks. End-to-end latency on a typical 20-message session is under a second.
