# ContextMover — Agent Execution Prompts
> Use each prompt as a self-contained task for an AI coding agent.
> Run them IN ORDER within each phase. Do not skip phases.
> Each prompt is designed to be copy-pasted directly.

---

## HOW TO USE THESE PROMPTS

Paste each prompt verbatim into your agent session. The agent should:
1. Read the files listed under "Files to Read First"
2. Follow the investigation steps in order
3. Apply only the changes described — nothing more
4. Report back with a diff or a description of every changed line before committing

---

---

# PHASE 1 — Restore Core Backend & Engine Functionality
> These four fixes are prerequisites for everything else. Do not touch scrapers until Phase 1 is complete.

---

## PROMPT 1 — Fix Admin Panel API Authorization (403 Forbidden on `/api/scraper-admin/*`)

**Severity:** Critical. Blocks all remote scraper management and bug report visibility.

**Background you must understand before touching any code:**
- This is a pnpm monorepo. The Next.js 14 web app lives in `packages/web/`.
- There are TWO separate families of admin API routes:
  - `/api/admin/*` — older admin routes, guarded by `packages/web/src/app/api/admin/_guard.ts`
  - `/api/scraper-admin/*` — newer routes for the remote scraper config feature, added alongside the `platform_configs` Supabase table
- ALL requests to `/api/scraper-admin/*` currently return `403 Forbidden`.
- The user IS authenticated (valid Supabase JWT). The problem is authorization, not authentication.
- From the security audit: the admin guard was recently refactored to replace a hardcoded admin email with `process.env.ADMIN_EMAIL`. This refactor may not have been applied consistently to the `/api/scraper-admin/` routes.

**Files to read FIRST (read all of them before writing a single line):**
1. `packages/web/src/app/api/admin/_guard.ts` — understand the EXISTING admin guard pattern exactly
2. Every `route.ts` file inside `packages/web/src/app/api/scraper-admin/` — list them all first
3. `packages/web/src/middleware.ts` — check if it blocks or modifies headers before reaching route handlers
4. `packages/web/src/lib/supabase/` — identify all client variants (server, admin, browser) and when each is used
5. `packages/web/.env.local` (or the env docs) — confirm `ADMIN_SECRET` and `ADMIN_EMAIL` are present

**Investigation checklist — verify EACH item before forming a fix:**
- [ ] Does the guard in `/api/scraper-admin/` differ from the guard in `/api/admin/_guard.ts`? If yes, HOW?
- [ ] Does the `/api/scraper-admin/` guard check a Supabase JWT `is_admin` claim or a user `role` column that was never populated? If so, that check is wrong.
- [ ] Does the frontend admin page (`/admin/scrapers`) send the required `x-admin-secret` header (or whatever header `_guard.ts` expects) on its API calls? Trace the frontend fetch calls.
- [ ] Is the `ADMIN_SECRET` env variable missing from the deployment environment? (This would cause every guard check to silently fail.)
- [ ] Does Next.js middleware strip custom headers? Check `middleware.ts` for any `request.headers.delete()` calls.

**Fix requirements — ALL of the following must be true after your fix:**
1. The `/api/scraper-admin/*` routes use the EXACT same guard pattern as `/api/admin/_guard.ts` — do not invent a new auth mechanism.
2. If the frontend page at `/admin/scrapers` was not sending the correct auth header, fix that too — the full request chain must work end-to-end.
3. The public GET endpoint `/app/config/selectors.json` must remain completely unauthenticated — do not touch it.
4. No hardcoded credentials anywhere — use `process.env.ADMIN_SECRET` and `process.env.ADMIN_EMAIL` only.
5. If env variables were missing, document exactly which ones need to be added and with what values.

**Output required:**
- A diff of every file changed
- Confirmation of which specific check was failing and why
- A `curl` command the user can run locally to verify the fix works

**STRICT CONSTRAINTS:**
- Do NOT remove authentication from any endpoint.
- Do NOT modify Supabase RLS policies unless you can prove they are the direct cause.
- Do NOT change the `/api/admin/*` routes — they are working fine.
- Do NOT guess at a fix — trace the full 403 path first.
IMPORTANT: Do not write any code until you have read every file listed under 
"Files to Read First" and explicitly confirmed what you found in each one. 
If a file doesn't exist at the path listed, stop and tell me — do not guess 
at its contents.
---

## PROMPT 2 — Fix Attention Engine: `web-tree-sitter` WASM Packaging Failure

**Severity:** Critical. Forces the Attention Engine into low-quality regex fallback mode, degrading all Tier 3 migrations that involve code.

**Runtime error to fix:**
```
[ContextMover:attention-engine] web-tree-sitter unavailable — regex fallback active
```

**Background:**
- The extension is a Chrome MV3 Vite + TypeScript build in `packages/browser-extension/`.
- `web-tree-sitter` is an npm package that wraps a WebAssembly parser. At runtime it needs `.wasm` files accessible via a URL — they cannot be bundled into JS.
- Vite does NOT automatically copy `.wasm` files from `node_modules` to `dist/`. They must be explicitly copied by a build plugin.
- Chrome MV3 extensions must declare WASM files under `web_accessible_resources` in `manifest.json` for content scripts and offscreen documents to load them via `chrome.runtime.getURL(...)`.
- The architecture report states: "A Vite plugin to copy the necessary WASM files has already been identified as the fix." Verify whether this plugin exists or needs to be created.

**Files to read FIRST:**
1. `packages/browser-extension/vite.config.ts` — check for any existing WASM copy plugin
2. `packages/browser-extension/src/lib/attention-engine.ts` — find `Parser.init(...)` or equivalent initialization call, note the EXACT path string used
3. `packages/browser-extension/manifest.json` (or `manifest.config.ts` if the manifest is generated) — look at `web_accessible_resources`
4. `node_modules/web-tree-sitter/` — list the files, note the WASM filename(s) exactly

**Fix steps — implement ALL:**

**Step A — Vite build config:**
If a WASM copy plugin does NOT already exist in `vite.config.ts`:
- Check if `vite-plugin-static-copy` is in `package.json`. If yes, use it. If not, write a minimal custom Vite plugin using the `generateBundle` hook that copies the file.
- The WASM file(s) from `node_modules/web-tree-sitter/` must be copied to the `dist/` root (not into a subdirectory).
- The copy must happen for EVERY build target (extension background, offscreen, content scripts).

**Step B — `manifest.json` `web_accessible_resources`:**
- Add the WASM filename(s) (e.g., `"tree-sitter.wasm"`) to the `web_accessible_resources` array.
- The resource must be accessible from all extension origins: `"matches": ["<all_urls>"]` or at minimum from the offscreen document origin.

**Step C — `attention-engine.ts` initialization path:**
- Find the `Parser.init(...)` call.
- It MUST use `chrome.runtime.getURL('tree-sitter.wasm')` as the WASM path — not a bare filename, not a relative path, not a `fetch()` URL. If it's using anything else, change it to `chrome.runtime.getURL(...)`.
- If language WASM files (e.g., `tree-sitter-javascript.wasm`) are also used, apply the same fix for each.

**Output required:**
- Full diff of `vite.config.ts`, `manifest.json`, and `attention-engine.ts`
- Confirmation: after `pnpm run build`, the `dist/` folder must contain `tree-sitter.wasm` — show the output of `ls dist/*.wasm`
- Ask the user to run `pnpm run build` and then reload the extension

**STRICT CONSTRAINTS:**
- Do NOT replace `web-tree-sitter` with a pure JS implementation.
- Do NOT modify the parsing LOGIC in `attention-engine.ts` — only fix the initialization/loading path.
- Do NOT commit WASM binary files to the repository — they must be sourced from `node_modules` at build time.
- Do NOT move WASM files into a subdirectory — they must be at the `dist/` root to match `chrome.runtime.getURL('tree-sitter.wasm')`.
IMPORTANT: Do not write any code until you have read every file listed under 
"Files to Read First" and explicitly confirmed what you found in each one. 
If a file doesn't exist at the path listed, stop and tell me — do not guess 
at its contents.
---

## PROMPT 3 — Fix Attention Engine: Offscreen Document Embed Timeout

**Severity:** Critical. Any Tier 3 migration with a user-provided query falls back to keyword search, making Tier 3 effectively non-functional.

**Runtime error to fix:**
```
[CM:index] Offscreen query embed failed — using keyword fallback: Error: offscreen embed timeout (45s)
```

**Background — read this carefully:**
The Chrome offscreen document loads an ONNX model (~23 MB) for text embedding. The model takes several seconds to initialize. The bug is a **race condition**: embed requests are sent before the model finishes loading. There is no queue, so requests either error immediately or hit the timeout.

The fix has been fully designed in the architecture report. You must implement it EXACTLY as described — do not invent an alternative approach.

**Files to read FIRST:**
1. `packages/browser-extension/src/offscreen/offscreen.ts` — read completely, understand the full message handler and model initialization sequence
2. `packages/browser-extension/src/offscreen/ml-worker.ts` — understand what `WORKER_READY` signals
3. `packages/browser-extension/src/lib/semantic-index/index.ts` — find `offscreenEmbedQuery()` or the function that sends messages to the offscreen document
4. `packages/browser-extension/src/background/service-worker.ts` — find `handleMigrateContext` and the Tier 3 migration flow, look for any existing `warmup` call

**Implement ALL of the following — do not skip any step:**

**In `offscreen.ts`:**
1. Add at module level: `let modelReady = false;`
2. Add at module level: `const pendingEmbedQueue: Array<{ resolve: (v: any) => void; reject: (e: Error) => void; payload: any; timeoutId: ReturnType<typeof setTimeout>; }> = [];`
3. Create a `drainEmbedQueue()` function that iterates `pendingEmbedQueue`, clears each item's timeout, and processes the embed request immediately (using the same logic as the normal embed handler).
4. Where the model currently finishes loading (the line that posts `WORKER_READY` or sets the model as ready): set `modelReady = true` and call `drainEmbedQueue()`.
5. In the message listener, for messages of type `EMBED` (or equivalent): if `!modelReady`, push to `pendingEmbedQueue` with a `setTimeout` that rejects the entry after **25 seconds** with `new Error('embed queued timeout')`; if `modelReady`, process immediately.

**In `semantic-index/index.ts`:**
1. Find the function that sends embed requests to the offscreen document (look for `chrome.runtime.sendMessage` targeting the offscreen).
2. Wrap the existing await in a `Promise.race` with a 30-second timeout: `Promise.race([existingPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('offscreen embed timeout (30s)')), 30000))])`.
3. On timeout, log `[CM:index] offscreen embed timed out` and RETHROW the error — do NOT silently catch it here. The caller is responsible for fallback decisions.

**In `service-worker.ts`:**
1. In `handleMigrateContext`, before the Tier 3 indexing/retrieval begins, call `semanticIndex.warmup()` (or `WARMUP_MODEL` message to offscreen, whichever pattern the codebase uses).
2. Wrap the warmup in a 15-second timeout. If it times out, log `[CM:sw] warmup timeout — proceeding anyway` but do NOT abort the migration. The pending queue system will handle it.

**Output required:**
- Full diff of all three files
- Before/after description of the message sequence (what happens when Tier 3 is triggered)

**STRICT CONSTRAINTS:**
- Do NOT simply increase the existing 45s timeout — that is not the fix.
- Do NOT remove the timeout entirely.
- Do NOT change the ONNX model, its path, or the embedding dimensions.
- Do NOT change the cosine similarity logic in `math.ts` or `ml-worker.ts`.
- The fix must NOT break the priority queue behavior (foreground migrations still preempt background indexing).
IMPORTANT: Do not write any code until you have read every file listed under 
"Files to Read First" and explicitly confirmed what you found in each one. 
If a file doesn't exist at the path listed, stop and tell me — do not guess 
at its contents.
---

## PROMPT 4 — Fix Semantic Indexing Background Queue Overflow

**Severity:** Critical. Without a working index, semantic search and Tier 3 migrations are permanently degraded.

**Runtime errors to fix:**
```
[CM:sw:bgIdx] indexing failed (non-fatal): Error: [CM:queue] Dropped: background queue overflow
[CM:startup] giving up on chatgpt-a7c2827c13 after 3 retries
```

**Background:**
Every time a session is captured, `service-worker.ts` calls `backgroundIndex()` to queue the session for embedding. When sessions are captured in rapid succession (e.g., after Drive sync pulls down many sessions), the queue fills up and silently drops jobs. Jobs that fail are retried up to 3 times on startup, then permanently abandoned. The result: a chronically incomplete semantic index.

**Files to read FIRST:**
1. `packages/browser-extension/src/lib/semantic-index/index.ts` — read completely. Find: the queue data structure, its maximum size, the `backgroundIndex()` / `enqueue()` method, and the retry logic.
2. `packages/browser-extension/src/background/service-worker.ts` — find: where `backgroundIndex()` is called after `CAPTURE_SESSION`, and the startup recovery logic (`handleStartup` or equivalent).
3. `packages/browser-extension/src/lib/db.ts` — understand the `chunkEmbeddings` and `sessionHashes` tables.

**Investigation — answer THESE questions before writing any fix:**
1. What is the current max queue size? (Find the constant or condition that drops items.)
2. Is the queue stored in memory only, or persisted to Dexie/chrome.storage?
3. Where exactly does the 3-retry limit appear? Is it in `index.ts` or `service-worker.ts`?
4. After a session is dropped from the queue, is there any mechanism to re-queue it on next startup?

**Fix — implement ALL of the following:**

**1. Increase queue capacity:**
- Raise the maximum background queue size to at minimum **50 items**.
- When the queue IS at capacity and a new item arrives, do NOT drop silently. Instead: log `[CM:queue] Near capacity (N/50) — scheduling deferred index` and use a `setTimeout(retry, 30000)` to attempt re-queuing after 30 seconds.

**2. Replace the 3-retry limit with a smarter failure strategy:**
- Remove the hard 3-retry limit.
- Replace with: only permanently skip a session if `hardwareTier === 'minimal'` (embedding is disabled on minimal hardware) OR if the ONNX model fails to load after 3 separate attempts (not the same as 3 transient queue errors).
- Transient failures (queue overflow, timeout) must not count as "retries" against the session.

**3. Persistent startup recovery:**
- On startup, scan `dexieDb.sessions` and compare against `dexieDb.chunkEmbeddings`.
- Any session with `messages.length > 0` that has ZERO `chunkEmbeddings` entries should be automatically re-queued.
- Limit this scan to the 20 most recently captured sessions (by `updatedAt`) to avoid startup lag.
- This is in addition to, not a replacement of, any existing startup recovery.

**4. Backpressure in service-worker.ts:**
- In the `CAPTURE_SESSION` handler, before calling `backgroundIndex()`, check the queue length.
- If the queue has ≥ 40 items, defer the `backgroundIndex()` call with `setTimeout(() => backgroundIndex(sessionId), 60000)` instead of calling immediately.

**Output required:**
- Full diff of changed files
- Description of the new queue behavior under load

**STRICT CONSTRAINTS:**
- Do NOT change the priority queue's core behavior — foreground migration jobs must still preempt background indexing.
- Do NOT add indexing for `minimal` hardware tier devices.
- Do NOT change the embedding model, chunker, or cosine similarity logic.
- Do NOT break the Drive sync or vault sync triggers.

---
IMPORTANT: Do not write any code until you have read every file listed under 
"Files to Read First" and explicitly confirmed what you found in each one. 
If a file doesn't exist at the path listed, stop and tell me — do not guess 
at its contents.
---

# PHASE 2 — Fix Systemic Capture Trigger
> Do this BEFORE fixing individual scrapers. The trigger failure is the root cause for most scraper "bugs."

---

## PROMPT 5 — Fix Systemic Capture Trigger: Existing Sessions Not Detected

**Severity:** Critical. Affects ALL platforms. The extension only detects new conversations, not existing ones.

**Root cause (from architecture analysis):**
The extension triggers scraping only on new network events or `/new` URL patterns. It does NOT re-scrape when:
- A user navigates directly to an existing conversation URL
- A page is loaded from browser cache (bfcache)
- A user navigates between conversations within a single-page app (SPA) without a full page reload

**Files to read FIRST:**
1. `packages/browser-extension/src/content/shared.ts` — read completely. Find: `startSessionCapture`, `watchForUrlChange` (if it exists), any `MutationObserver` setup, and the initialization call at the bottom of the file.
2. `packages/browser-extension/src/content/claude.ts` — use as the representative example. Find: how and when `startSessionCapture` is called, and what events trigger it.
3. `packages/browser-extension/src/background/service-worker.ts` — find the `chrome.tabs.onUpdated` listener and what conditions it uses to trigger a capture.
4. `packages/browser-extension/manifest.json` — check `run_at` for all content scripts.

**Investigation — answer BEFORE writing any code:**
1. Is `startSessionCapture` called once on page load and never again? Or is it re-called on navigation?
2. Is there any `history.pushState` or `popstate` listener in any content script? If yes, does it actually call `startSessionCapture`?
3. Does `chrome.tabs.onUpdated` in `service-worker.ts` only fire on `status === 'complete'`, or also on URL changes?
4. What platform URL patterns does the existing trigger recognize?

**Fix — implement ALL of the following in `shared.ts` (apply to all platforms via shared.ts, not per-platform files):**

**A. SPA navigation detection:**
Add a `watchForSpaNavigation(onNavigate: (newUrl: string) => void)` function that:
1. Stores `window.location.href` as `lastUrl`.
2. Overrides `history.pushState` and `history.replaceState` to call `onNavigate(newUrl)` when the URL changes.
3. Listens for `popstate` events and calls `onNavigate(window.location.href)`.
4. Calls `onNavigate` with the current URL on initial load.

**B. bfcache restore detection:**
Add a `pageshow` event listener on `window`. When `event.persisted === true` (bfcache restore), call `startSessionCapture()` with a 1000ms delay.

**C. Trigger logic in `startSessionCapture`:**
Add a debounce: do not allow `startSessionCapture` to run more than once per 1500ms. Use a module-level `let captureDebounceTimer: ReturnType<typeof setTimeout> | null = null`.

**D. Retry on empty scrape:**
After the first scrape attempt, if zero messages are found, retry up to **3 times** at 1-second intervals before giving up. This handles cases where the DOM takes a moment to render.

**E. In each platform content script (claude.ts, chatgpt.ts, gemini.ts, grok.ts, deepseek.ts, perplexity.ts):**
Replace any existing URL-change or startup logic with a call to `watchForSpaNavigation` from `shared.ts`. The callback should call `startSessionCapture()` only if the new URL matches the platform's conversation URL pattern (NOT the home page or new-chat page).

**URL patterns that indicate an active (non-empty) conversation:**
- Claude: URL contains `/chat/` and a UUID
- ChatGPT: URL contains `/c/` and a UUID
- Gemini: URL contains `/app/` and a hash
- Grok: URL contains `/grok` (check what identifies a specific conversation)
- DeepSeek: URL changes within the chat app
- Perplexity: URL contains `/search/` and a slug

**F. In `service-worker.ts`:**
In `chrome.tabs.onUpdated`, when `changeInfo.status === 'complete'` AND the URL matches ANY supported platform (use a shared regex list), send a `TRIGGER_CAPTURE` message to the content script. The content script's `startSessionCapture` will debounce the actual work.

**Output required:**
- Full diff of `shared.ts`, `service-worker.ts`, and at minimum `claude.ts` and `chatgpt.ts` as examples
- Confirmation that the fix does NOT trigger capture on home pages or new-chat pages before any messages exist

**STRICT CONSTRAINTS:**
- Do NOT use `setInterval` to poll for URL changes — use event listeners only.
- Do NOT call `startSessionCapture` more than once per navigation event (use the debounce).
- Do NOT modify the `CAPTURE_SESSION` handler in `service-worker.ts` — only modify the TRIGGER mechanism.
- Do NOT change any scraper selector logic — this prompt is ONLY about the trigger.

---
IMPORTANT: Do not write any code until you have read every file listed under 
"Files to Read First" and explicitly confirmed what you found in each one. 
If a file doesn't exist at the path listed, stop and tell me — do not guess 
at its contents.
---

# PHASE 3 — Repair Platform Scrapers
> Attempt these only after Phase 2 is complete. The capture trigger fix will resolve many false positives.
> All scraper prompts follow the same structure. Run each as a separate agent session.

---

## PROMPT 6 — Fix Claude Scraper

**Severity:** Medium (structural fallback is working, but it is less reliable).

**Runtime errors:**
```
[CM:claude] all selectors returned 0 — structural fallback will run next
UI Update Detected! Scraper broken on claude: Zero messages found after retries
```

**Files to read FIRST:**
1. `packages/browser-extension/src/content/claude.ts` — read completely
2. `packages/browser-extension/src/content/shared.ts` — read `extractContent` and `startSessionCapture`
3. `packages/browser-extension/src/lib/remote-config.ts` — understand the selector override format

**DOM Inspection (REQUIRED before any code change):**
Ask the user to:
1. Open `claude.ai` in Chrome with an active conversation (at least 3 messages)
2. Open DevTools → Console
3. Run this probe:
```javascript
// Find message containers
['[data-testid]', '[class*="message"]', '[class*="human"]', '[class*="assistant"]', '[class*="conversation"]', '[class*="turn"]'].forEach(sel => {
  const els = document.querySelectorAll(sel);
  if (els.length > 0) console.log(`SELECTOR "${sel}" → ${els.length} elements, first:`, els[0].className, '|', els[0].textContent?.slice(0, 60));
});
```
4. Provide the console output back to you

**From the console output, identify:**
- `userSelector`: the selector that matches ONLY user message containers (not assistant)
- `assistantSelector`: the selector that matches ONLY assistant message containers
- `observerTarget`: the scrollable container that wraps all messages
- The attribute or element that holds the message text content (e.g., `p`, `div.text`, etc.)

**Fix:**
1. Update the selectors in `claude.ts`
2. Prefer `data-testid` attributes over generated class names — they are stable across Claude UI updates
3. Generate the SQL UPDATE for the `platform_configs` Supabase table:
```sql
UPDATE platform_configs 
SET user_selector = '<new selector>',
    assistant_selector = '<new selector>',
    observer_target = '<new selector>',
    updated_at = NOW()
WHERE platform = 'claude';
```

**Verification:**
Console must show `[CM:claude] strategy=X user=N asst=N` with N > 0 on a conversation with N messages.

**CONSTRAINTS:**
- Do NOT change `shared.ts` or `fetch-interceptor.ts` — only update selectors in `claude.ts` and the DB.
- If `data-testid` attributes exist, use them exclusively — do not use generated class names like `sc-abc123`.
If the DOM probe output shows more than one plausible selector for user 
or assistant messages, list ALL candidates and ask me which to use 
before writing any code.
---

## PROMPT 7 — Fix ChatGPT Scraper (Multi-Failure)
## ChatGPT DOM Probe Output
[
========== CONTEXTMOVER: CHATGPT DOM PROBE ==========

VM411:6 [data-message-author-role] elements found: 9
VM411:9   Role values present: assistant, user
VM411:13 
  role="assistant" → 5 elements
VM411:14     tag: DIV, classes: min-h-8 text-message relative flex w-full flex-col items-end gap-2 text-start break-words whitespace
VM411:15     text: "I created a structured prompt you can directly use in a new AI session to focus entirely on reproduc"
VM411:13 
  role="user" → 4 elements
VM411:14     tag: DIV, classes: min-h-8 text-message relative flex w-full flex-col items-end gap-2 text-start break-words whitespace
VM411:15     text: "listen the real thing is i dont have time or proper hardware to test restromer models on the origina"
VM411:23 
RELEVANT data-testid VALUES:
collapsible-user-message-content
collapsible-user-message-root
collapsible-user-message-toggle
conversation-options-button
conversation-turn-1
conversation-turn-10
conversation-turn-11
conversation-turn-12
conversation-turn-13
conversation-turn-14
conversation-turn-15
conversation-turn-16
conversation-turn-17
conversation-turn-18
conversation-turn-19
conversation-turn-2
conversation-turn-20
conversation-turn-21
conversation-turn-22
conversation-turn-23
conversation-turn-24
conversation-turn-25
conversation-turn-26
conversation-turn-27
conversation-turn-28
conversation-turn-3
conversation-turn-4
conversation-turn-5
conversation-turn-6
conversation-turn-7
conversation-turn-8
conversation-turn-9
copy-turn-action-button
create-new-chat-button
share-chat-button
VM411:42 
SELECTOR TEST RESULTS:
VM411:47 
  ✅ "[data-message-author-role="user"]" → 4 elements
VM411:51      [0] DIV | data: data-message-author-role="user", data-message-id="f7ea5a6c-6c0f-4bbd-8009-95b92270f15a" | text: "listen the real thing is i dont have time or proper hardware to test restromer models on the origina"
VM411:51      [1] DIV | data: data-message-author-role="user", data-message-id="eb036c7e-1d45-4639-ac05-cf5de0cb8f18" | text: "restormer_notebook_guide (1).mdFileread this thoroughly if your read it say ok"
VM411:47 
  ✅ "[data-message-author-role="assistant"]" → 5 elements
VM411:51      [0] DIV | data: data-message-author-role="assistant", data-message-id="fed96276-12ec-4e25-8aef-a6c9011b896f", data-message-model-slug="gpt-5-3" | text: "I created a structured prompt you can directly use in a new AI session to focus entirely on reproduc"
VM411:51      [1] DIV | data: data-message-author-role="assistant", data-message-id="cf395667-fa85-4c11-8ecf-80ed03da444e", data-message-model-slug="gpt-5-3" | text: "You should stay with the EUVP dataset. Given your hardware limits, it is completely reasonable to bu"
VM411:47 
  ✅ "[data-testid^="conversation-turn"]" → 28 elements
VM411:51      [0] SECTION | data: data-turn-id="fcab063f-bcef-46d9-8a56-42ad906b1806", data-turn-id-container="fcab063f-bcef-46d9-8a56-42ad906b1806", data-testid="conversation-turn-1", data-scroll-anchor="false", data-turn="user" | text: ""
VM411:51      [1] SECTION | data: data-turn-id="d70b0085-c72e-4d6e-90a6-c5484de1c611", data-turn-id-container="d70b0085-c72e-4d6e-90a6-c5484de1c611", data-testid="conversation-turn-2", data-scroll-anchor="false", data-turn="assistant" | text: ""
VM411:47 
  ✅ "[class*="agent-turn"]" → 5 elements
VM411:51      [0] DIV | data: none | text: "Restormer Underwater Baseline Psnr Recovery Prompt 2026CopyEditDownloadPrompt: Recover Baseline Rest"
VM411:51      [1] DIV | data: none | text: "You should stay with the EUVP dataset. Given your hardware limits, it is completely reasonable to bu"
VM411:47 
  ✅ "[class*="text-message"]" → 9 elements
VM411:51      [0] DIV | data: data-message-author-role="assistant", data-message-id="fed96276-12ec-4e25-8aef-a6c9011b896f", data-message-model-slug="gpt-5-3" | text: "I created a structured prompt you can directly use in a new AI session to focus entirely on reproduc"
VM411:51      [1] DIV | data: data-message-author-role="user", data-message-id="f7ea5a6c-6c0f-4bbd-8009-95b92270f15a" | text: "listen the real thing is i dont have time or proper hardware to test restromer models on the origina"
VM411:58 
VIRTUAL SCROLL / THREAD CONTAINER:
VM411:65   "[class*="thread"]" → overflow-y: visible, height: 15114.2px, children: 1
VM411:65   "[class*="overflow-y-auto"]" → overflow-y: auto, height: 820px, children: 2
VM411:65   "main" → overflow-y: visible, height: 768px, children: 1
VM411:70 
MESSAGE COUNT SANITY CHECK:
VM411:74   Total [data-message-author-role] in DOM: 9
VM411:75   Visible (non-zero height): 9
VM411:76   → If visibleMsgs << totalMsgs, virtual scroll is hiding elements
VM411:78 
========== END CHATGPT DOM PROBE ==========]
**Severity:** High. Primary selector broken, fetch interceptor inconsistent, virtual scroll defeats structural fallback.

**Runtime errors:**
```
[CM:diag:chatgpt] strategy=1 user=0 asst=0
fetch-tap user=13 asst=13  [sometimes]
no messages parsed  [sometimes]
suppressed shrinking scrape (16→8)
```

**Files to read FIRST:**
1. `packages/browser-extension/src/content/chatgpt.ts`
2. `packages/browser-extension/src/content/fetch-interceptor.ts` — find the ChatGPT-specific parsing logic
3. `packages/browser-extension/src/content/shared.ts`

**This is a THREE-PART fix. Address all three:**

**Part 1 — Fix primary CSS selectors (same DOM probe approach as Prompt 6):**
Ask the user to run this probe on `chat.openai.com` or `chatgpt.com` with an open conversation:
```javascript
['[data-message-author-role]', '[data-testid*="message"]', '[class*="message"]', '[class*="group"]'].forEach(sel => {
  const els = document.querySelectorAll(sel);
  if (els.length) console.log(`"${sel}" → ${els.length}`, els[0].getAttribute('data-message-author-role') || els[0].className.slice(0,60));
});
```
Update `chatgpt.ts` with new selectors.

**Part 2 — Fix the fetch interceptor for ChatGPT:**
In `fetch-interceptor.ts`, find the ChatGPT response parsing logic. The inconsistency (sometimes `user=13 asst=13`, sometimes `no messages parsed`) means the JSON path being parsed is wrong for SOME response formats.
- Find all `JSON.parse` or response body parsing code for `chat.openai.com`
- There are likely TWO different response formats (streaming vs non-streaming, or different API versions)
- Add handling for BOTH formats
- Log `[CM:chatgpt:fetch] format=A|B messages=N` to confirm which format was parsed

**Part 3 — Fix virtual scroll capture:**
The `suppressed shrinking scrape (16→8)` log means the structural scraper sees fewer messages when virtual scroll collapses DOM nodes.
- In `chatgpt.ts`, find the MutationObserver and capture debounce
- Before triggering `sendCapture`, check if the message count is LESS than the last successfully captured count
- If it is lower, do NOT replace the stored session — merge instead (keep whichever has more messages)
- This logic may already exist as the "shrink guard" — if it does, the issue is it's preventing ANY update. Fix the condition so it only suppresses a capture when `newCount < lastCount * 0.75` (allows minor fluctuation but blocks major shrinkage)

**CONSTRAINTS:**
- Do NOT rewrite `fetch-interceptor.ts` — surgical additions only.
- The merge/shrink guard logic MUST be in `shared.ts` so all platforms benefit.
If the DOM probe output shows more than one plausible selector for user 
or assistant messages, list ALL candidates and ask me which to use 
before writing any code.
---

## PROMPT 8 — Fix Gemini Scraper (Existing Sessions + New Sessions)
## Gemini DOM Probe — 
[
========== CONTEXTMOVER: GEMINI DOM PROBE [LIKELY-EXISTING] ==========

VM668:10 CUSTOM ELEMENTS (web components) on page:
VM668:13   1x <at-mentions-menu>
VM668:13   1x <auto-suggest>
VM668:13   1x <bard-mode-switcher>
VM668:13   1x <bot-banner>
VM668:13   1x <chat-app>
VM668:13   1x <chat-app-announcement-banners>
VM668:13   1x <chat-app-banners>
VM668:13   1x <chat-app-side-nav-menu-button>
VM668:13   1x <chat-app-tooltips>
VM668:13   1x <chat-loading-animation>
VM668:13   1x <chat-notifications>
VM668:13   1x <chat-window>
VM668:13   1x <chat-window-content>
VM668:13   1x <condensed-tos-disclaimer>
VM668:13   1x <conversation-action-menu>
VM668:13   1x <conversation-actions-icon>
VM668:13   1x <conversations-list>
VM668:13   4x <copy-button>
VM668:13   1x <crust-task>
VM668:13   2x <expandable-section>
VM668:13   1x <file-drop-indicator>
VM668:13   1x <freemium-file-upload-near-quota-disclaimer>
VM668:13   1x <freemium-file-upload-quota-exceeded-disclaimer>
VM668:13   4x <freemium-rag-disclaimer>
VM668:13   1x <g1-dynamic-upsell-button>
VM668:13   1x <gem-button>
VM668:13   44x <gem-icon>
VM668:13   32x <gem-icon-button>
VM668:13   6x <gem-nav-list-item>
VM668:13   7x <gem-popover>
VM668:13   2x <hallucination-disclaimer>
VM668:13   2x <infinite-scroller>
VM668:13   1x <input-area-v2>
VM668:13   1x <input-container>
VM668:13   1x <mat-action-list>
VM668:13   46x <mat-icon>
VM668:13   15x <mat-menu>
VM668:13   5x <mat-nav-list>
VM668:13   2x <mat-progress-spinner>
VM668:13   1x <mat-sidenav>
VM668:13   1x <mat-sidenav-container>
VM668:13   1x <mat-sidenav-content>
VM668:13   4x <message-actions>
VM668:13   4x <message-content>
VM668:13   4x <model-response>
VM668:13   1x <new-chat-button>
VM668:13   1x <project-sidenav-list>
VM668:13   1x <regenerate-button>
VM668:13   4x <response-container>
VM668:13   1x <rich-textarea>
VM668:13   1x <router-outlet>
VM668:13   4x <sensitive-memories-banner>
VM668:13   1x <side-nav-menu-button>
VM668:13   1x <side-nav-sparkle-button>
VM668:13   1x <side-navigation-content>
VM668:13   1x <side-navigation-v2>
VM668:13   1x <sidenav-mavatar-footer>
VM668:13   1x <simplified-input-menu>
VM668:13   4x <sources-list>
VM668:13   1x <speech-dictation-mic-button>
VM668:13   4x <structured-content-container>
VM668:13   4x <thinking-overlay>
VM668:13   4x <thumb-down-button>
VM668:13   4x <thumb-up-button>
VM668:13   1x <top-bar-actions>
VM668:13   1x <tts-control-v2>
VM668:13   1x <user-profile-picture>
VM668:13   4x <user-query>
VM668:13   4x <user-query-content>
VM668:13   1x <xap-count-badge>
VM668:29 
SELECTOR TEST RESULTS:
VM668:34 
  ✅ "model-response" → 4 elements
VM668:38      [0] <model-response> attrs: _ngcontent-ng-c3091545854="" _nghost-ng-c2169594278="" class="enable-lr26-response-chrome-updates ng-s"
VM668:39      [0] text: "Gemini saidHii! How's it going? What's on your mind today?"
VM668:38      [1] <model-response> attrs: _ngcontent-ng-c3091545854="" _nghost-ng-c2169594278="" class="enable-lr26-response-chrome-updates ng-s"
VM668:39      [1] text: "Gemini saidI'm listening! What's up?"
VM668:34 
  ✅ "user-query" → 4 elements
VM668:38      [0] <user-query> attrs: _ngcontent-ng-c3091545854="" _nghost-ng-c4059923229="" class="ng-star-inserted"
VM668:39      [0] text: "You said hii"
VM668:38      [1] <user-query> attrs: _ngcontent-ng-c3091545854="" _nghost-ng-c4059923229="" class="ng-star-inserted"
VM668:39      [1] text: "You said hellolisten"
VM668:34 
  ✅ "response-container" → 4 elements
VM668:38      [0] <response-container> attrs: _ngcontent-ng-c2169594278="" _nghost-ng-c3511524645="" class="ng-tns-c3511524645-12 reduced-bottom-pad" jslog="188576;track:impression,attention;BardV
VM668:39      [0] text: "Gemini saidHii! How's it going? What's on your mind today?"
VM668:38      [1] <response-container> attrs: _ngcontent-ng-c2169594278="" _nghost-ng-c3511524645="" class="ng-tns-c3511524645-16 reduced-bottom-pad" jslog="188576;track:impression,attention;BardV
VM668:39      [1] text: "Gemini saidI'm listening! What's up?"
VM668:34 
  ✅ "message-content" → 4 elements
VM668:38      [0] <message-content> attrs: _ngcontent-ng-c587905618="" _nghost-ng-c587149462="" id="message-content-id-r_779c2502c69da77b" class="ng-star-inserted"
VM668:39      [0] text: "Hii! How's it going? What's on your mind today?"
VM668:38      [1] <message-content> attrs: _ngcontent-ng-c587905618="" _nghost-ng-c587149462="" id="message-content-id-r_2228fd5f09f34cab" class="ng-star-inserted"
VM668:39      [1] text: "I'm listening! What's up?"
VM668:34 
  ✅ "[class*="response"]" → 60 elements
VM668:38      [0] <div> attrs: _ngcontent-ng-c3322900915="" class="response-tts-container hidden ng-star-in"
VM668:39      [0] text: ""
VM668:38      [1] <model-response> attrs: _ngcontent-ng-c3091545854="" _nghost-ng-c2169594278="" class="enable-lr26-response-chrome-updates ng-s"
VM668:39      [1] text: "Gemini saidHii! How's it going? What's on your mind today?"
VM668:34 
  ✅ "[class*="query"]" → 32 elements
VM668:38      [0] <span> attrs: _ngcontent-ng-c4059923229="" class="user-query-container"
VM668:39      [0] text: "You said hii"
VM668:38      [1] <user-query-content> attrs: _ngcontent-ng-c4059923229="" class="user-query-container enable-luminous-pro" _nghost-ng-c3195099594="" style="--max-lines-for-collapse-count: 5;"
VM668:39      [1] text: "You said hii"
VM668:34 
  ✅ "[class*="user-query"]" → 20 elements
VM668:38      [0] <span> attrs: _ngcontent-ng-c4059923229="" class="user-query-container"
VM668:39      [0] text: "You said hii"
VM668:38      [1] <user-query-content> attrs: _ngcontent-ng-c4059923229="" class="user-query-container enable-luminous-pro" _nghost-ng-c3195099594="" style="--max-lines-for-collapse-count: 5;"
VM668:39      [1] text: "You said hii"
VM668:34 
  ✅ "[class*="model-response"]" → 8 elements
VM668:38      [0] <h2> attrs: _ngcontent-ng-c2169594278="" class="cdk-visually-hidden screen-reader-model-"
VM668:39      [0] text: "Gemini said"
VM668:38      [1] <structured-content-container> attrs: _ngcontent-ng-c2169594278="" class="model-response-text processing-state-vis" _nghost-ng-c587905618="" style="height: auto;"
VM668:39      [1] text: "Hii! How's it going? What's on your mind today?"
VM668:34 
  ✅ "[class*="message"]" → 5 elements
VM668:38      [0] <div> attrs: _ngcontent-ng-c3091545854="" class="conversation-container message-actions-h" id="779c2502c69da77b" style=""
VM668:39      [0] text: "You said hii Gemini saidHii! How's it going? What's on your mind today?"
VM668:38      [1] <div> attrs: _ngcontent-ng-c3091545854="" class="conversation-container message-actions-h" id="2228fd5f09f34cab" style=""
VM668:39      [1] text: "You said hellolisten Gemini saidI'm listening! What's up?"
VM668:34 
  ✅ ".response-content" → 4 elements
VM668:38      [0] <div> attrs: _ngcontent-ng-c2169594278="" class="response-content ng-tns-c3511524645-12"
VM668:39      [0] text: "Gemini saidHii! How's it going? What's on your mind today?"
VM668:38      [1] <div> attrs: _ngcontent-ng-c2169594278="" class="response-content ng-tns-c3511524645-16"
VM668:39      [1] text: "Gemini saidI'm listening! What's up?"
VM668:34 
  ✅ ".query-content" → 4 elements
VM668:38      [0] <div> attrs: _ngcontent-ng-c3195099594="" class="query-content ng-star-inserted verticle-" id="user-query-content-0" jslog="275422;track:impression,attention" data
VM668:39      [0] text: "You said hii"
VM668:38      [1] <div> attrs: _ngcontent-ng-c3195099594="" class="query-content ng-star-inserted verticle-" id="user-query-content-1" jslog="275422;track:impression,attention" data
VM668:39      [1] text: "You said hellolisten"
VM668:34 
  ✅ "infinite-scroller" → 2 elements
VM668:38      [0] <infinite-scroller> attrs: _ngcontent-ng-c825628007="" _nghost-ng-c727933417="" class="lr26-theme ng-star-inserted"
VM668:39      [0] text: "LibraryNotebooksNew notebookRecenthii"
VM668:38      [1] <infinite-scroller> attrs: _ngcontent-ng-c3091545854="" data-test-id="chat-history-container" class="chat-history enable-lr26-markdown-stylin" _nghost-ng-c727933417="" jslog="26
VM668:39      [1] text: "You said hii Gemini saidHii! How's it going? What's on your mind today?You said hellolisten Gemini s"
VM668:46 
JSNAME ATTRIBUTES (Angular internal identifiers):
VM668:48   All jsname values (first 20): 
VM668:51 
CONVERSATION ROOT SEARCH:
VM668:58   "infinite-scroller" → <infinite-scroller> | children: 7 | scrollHeight: 379
VM668:58   "chat-window" → <chat-window> | children: 1 | scrollHeight: 581
VM668:58   "main" → <main> | children: 4 | scrollHeight: 581
VM668:58   "[class*="conversation"]" → <span> | children: 0 | scrollHeight: 24
VM668:58   "[class*="history"]" → <div> | children: 2 | scrollHeight: 649
VM668:63 
SHADOW DOM CHECK:
VM668:68   <model-response> has shadowRoot: false
VM668:68   <user-query> has shadowRoot: false
VM668:68   <response-container> has shadowRoot: false
VM668:77 
TEXT CONTENT SAMPLING (first 5 substantial text blocks):
VM668:83   <script> class="" → "window["_F_toggles_default_BardChatUi"] = [0x6840021, 0x2ff3140f, 0x278614d, 0x2..."
VM668:83   <script> class="" → "var _F_cssRowKey = 'boq-bard-web.BardChatUi.FwbtNzIGSDQ.L.B1.O';var _F_combinedS..."
VM668:83   <script> class="" → "(window.dataLayer=window.dataLayer||[]).push({"gtm.start": new Date().getTime(),..."
VM668:83   <script> class="" → "{"@context" : "https://schema.org", "@type" : "WebSite", "name" : "Gemini", "url..."
VM668:83   <script> class="" → "var AF_initDataKeys = []; var AF_dataServiceRequests = {}; var AF_initDataChunkQ..."
VM668:88 
========== END GEMINI DOM PROBE [LIKELY-EXISTING] ==========]

**Severity:** High. Zero messages found in existing sessions; structural fallback also fails.

**Runtime errors:**
```
ZERO-SCRAPE: no selectors matched any nodes
too few substantial elements (0), skipping
```

**Files to read FIRST:**
1. `packages/browser-extension/src/content/gemini.ts`
2. `packages/browser-extension/src/content/shared.ts`
3. `packages/browser-extension/src/lib/remote-config.ts`

**Unique context for Gemini:** The DOM structure differs between a freshly loaded (empty/new) session and a re-loaded (existing) session. The scraper only handles one case.

**DOM Inspection — TWO separate probes needed:**

Ask the user to run this probe on an EXISTING Gemini conversation:
```javascript
['model-response', 'user-query', '[data-message-author]', '[data-turn-id]', '[class*="response"]', '[class*="query"]', 'message-content', 'response-container'].forEach(sel => {
  const els = document.querySelectorAll(sel);
  if (els.length) console.log(`EXISTING SESSION "${sel}" → ${els.length}`, els[0].className?.slice(0,60) || els[0].tagName);
});
```

Then again on a NEW (empty) Gemini session. Compare the two outputs.

**Fix:**
1. Update `gemini.ts` with selectors that work for BOTH existing and new sessions
2. If the DOM structures differ significantly, add a `detectSessionType()` function that checks which DOM variant is present and selects the appropriate selector set
3. Update the `platform_configs` Supabase table with the new selectors

**CONSTRAINTS:**
- The fix for the Gemini INJECTION failure (broken textarea) is in a separate prompt (Prompt 12) — do NOT fix injection here.
- Do NOT change the fetch interceptor for Gemini.
If the DOM probe output shows more than one plausible selector for user 
or assistant messages, list ALL candidates and ask me which to use 
before writing any code.
---

## PROMPT 9 — Fix Perplexity Scraper

**Severity:** Critical. All 5 scraping strategies (A-E) return zero messages.

**Runtime errors:**
```
Selector not found: main
scoring timed out — heuristic fallback
```

**Note:** The `Selector not found: main` error is the primary failure. The extension is looking for `<main>` as the root container, but Perplexity's DOM does not have a `<main>` element at the expected depth.

**Files to read FIRST:**
1. `packages/browser-extension/src/content/perplexity.ts`
2. `packages/browser-extension/src/lib/capture/structural-detector.ts` — understand how the structural fallback works and why it's also failing

**DOM Inspection:**
Ask the user to run this probe on a Perplexity search results page with visible messages:
```javascript
// Find the root container
['main', '#__next', '[class*="thread"]', '[class*="answer"]', '[class*="message"]', '[data-testid]'].forEach(sel => {
  const el = document.querySelector(sel);
  if (el) console.log(`ROOT "${sel}" → tag=${el.tagName} class=${el.className?.slice(0,80)}`);
});
// Find message items
document.querySelectorAll('[class*="prose"], [class*="answer"], [class*="user"], [class*="query"], [class*="assistant"]').forEach(el => {
  if (el.textContent.trim().length > 20) console.log(el.tagName, el.className?.slice(0,80), '|', el.textContent?.slice(0,50));
});
```

**Fix:**
1. Replace `main` as the root selector with whatever the actual root container is
2. Update all 5 strategy selectors (A through E) based on the current DOM
3. The structural fallback's `too few substantial elements` failure suggests it requires elements with `substantial` text content — verify the threshold in `structural-detector.ts` is appropriate for Perplexity's response format (which may use more code blocks or special formatting)
4. Update Supabase `platform_configs`

**CONSTRAINTS:**
- The systemic capture trigger fix (Prompt 5) must be deployed first — the "new session only" behavior is partially caused by the trigger issue.
If the DOM probe output shows more than one plausible selector for user 
or assistant messages, list ALL candidates and ask me which to use 
before writing any code.
---

## PROMPT 10 — Fix Grok Scraper

**Severity:** Critical. Same `Selector not found: main` failure as Perplexity.

**Runtime errors:**
```
Selector not found: main
suppressed shrinking scrape
```

**Files to read FIRST:**
1. `packages/browser-extension/src/content/grok.ts`
2. `packages/browser-extension/src/content/shared.ts`

**DOM Inspection:**
Ask the user to run this probe on `grok.com` or `x.com/i/grok` with an active conversation:
```javascript
['main', '[data-testid]', '[class*="conversation"]', '[class*="message"]', '[class*="response"]', '[class*="human"]', '[class*="bot"]', '[role="main"]'].forEach(sel => {
  const els = document.querySelectorAll(sel);
  if (els.length) console.log(`"${sel}" → ${els.length} | first class: ${els[0].className?.slice(0,80)}`);
});
```

**Fix:**
1. Replace the broken `main` selector with the actual root container
2. Update user/assistant message selectors based on probe output
3. Address the virtual scroll shrink issue — apply the same merge logic described in Prompt 7, Part 3
4. Update Supabase `platform_configs`
If the DOM probe output shows more than one plausible selector for user 
or assistant messages, list ALL candidates and ask me which to use 
before writing any code.
---

## PROMPT 11 — Fix DeepSeek Scraper (Inverted Failure)

**Severity:** Critical. The extension captures existing conversations but FAILS on new empty conversations.

**Runtime errors:**
```
strategy=B user=1 asst=2  [on existing conversation — works]
NO messages found  [on new conversation — fails]
UI Update Detected! Scraper broken on deepseek: Selector not found: main
```

**Unique failure mode:** This is INVERTED from the other scrapers. The DOM for a new/empty DeepSeek conversation is different from a conversation that already has messages. The scraper only handles the populated case.

**Files to read FIRST:**
1. `packages/browser-extension/src/content/deepseek.ts`
2. `packages/browser-extension/src/content/shared.ts`

**DOM Inspection — TWO probes required:**

Probe 1: On a DeepSeek conversation with multiple messages:
```javascript
['main', '[class*="message"]', '[class*="chat"]', '[class*="user"]', '[class*="assistant"]', '[data-role]'].forEach(sel => {
  const els = document.querySelectorAll(sel);
  if (els.length) console.log(`POPULATED "${sel}" → ${els.length}`, els[0].className?.slice(0,80));
});
```

Probe 2: Immediately after creating a NEW empty DeepSeek conversation (before sending any message):
```javascript
// Same probe as above
```

**Fix:**
1. The fix is NOT to only support populated conversations — new conversations must also be captured once they gain messages.
2. If the root container (`main`) is genuinely absent on new conversations, use a fallback root selector or wait for the DOM to populate (use MutationObserver on `document.body` until the conversation container appears).
3. Strategy B works on existing conversations — make it the primary strategy, not a fallback.
4. Update Supabase `platform_configs`.
5. The Tier 3 failure on DeepSeek is caused by the Attention Engine issues (Prompts 2 & 3) — do NOT attempt to fix it here.
If the DOM probe output shows more than one plausible selector for user 
or assistant messages, list ALL candidates and ask me which to use 
before writing any code.
---

---

# PHASE 4 — Resolve Remaining High-Priority Bugs

---

## PROMPT 12 — Fix Gemini Context Injection Failure

**Severity:** High. Blocks ALL migration tiers from completing on Gemini.

**Runtime error:**
```
[CM:gemini] injection failed — reason: unknown
```

**Background:**
After a migration is built, the service worker sends an `INJECT_CONTEXT` message to the Gemini content script, which tries to set the text in Gemini's prompt input field. This is failing with a generic "unknown" error — meaning the code is catching an exception but not surfacing the actual cause.

**Files to read FIRST:**
1. `packages/browser-extension/src/content/gemini.ts` — find the injection function (likely `injectIntoGeminiInput` or `setGeminiPromptValue`)
2. `packages/browser-extension/src/content/shared.ts` — find `setPromptInputValue` and `injectWithRetry`
3. `packages/browser-extension/src/background/service-worker.ts` — find where `INJECT_CONTEXT` is dispatched to the Gemini tab

**Investigation:**
1. Find every `catch` block in the Gemini injection code. The `reason: unknown` log means an exception is being caught but swallowed with a generic message. ADD `console.error('[CM:gemini] injection error detail:', e)` to every catch block.
2. Ask the user to try a migration to Gemini with this logging added, and report the actual error.

**Most likely failure causes (check ALL):**
- [ ] The CSS selector for Gemini's textarea/input has changed — run this probe: `document.querySelectorAll('textarea, [contenteditable="true"], rich-textarea, [role="textbox"]').forEach(el => console.log(el.tagName, el.id, el.className?.slice(0,60)))`
- [ ] Gemini now uses a custom web component (`<rich-textarea>` or similar) that requires dispatching a `input` + `change` event after setting value — bare `element.value = text` does not work
- [ ] React/Angular synthetic event required: `Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true }))`

**Fix requirements:**
1. Fix the actual CSS selector for the Gemini input field
2. Use the correct event dispatch pattern for Gemini's input framework (likely requires the React synthetic event approach OR dispatching on the web component's internal input)
3. After setting the value, verify the submit button becomes enabled — if not, the event dispatch is incomplete
4. Replace the generic `reason: unknown` catch with actual error message propagation

**CONSTRAINTS:**
- Do NOT fix the Gemini scraper here — that is Prompt 8.
- The fix must work for BOTH short text (summary injection) and long text (full XML file as text fallback).
- Test with at least 5,000 characters of injected content.
IMPORTANT: Do not write any code until you have read every file listed under 
"Files to Read First" and explicitly confirmed what you found in each one. 
If a file doesn't exist at the path listed, stop and tell me — do not guess 
at its contents.
---

## PROMPT 13 — Fix Migration Auto-Injection (skipAutoInject=true Bug)

**Severity:** Medium. Breaks the default workflow for Tier 2 and Tier 3 migrations.

**Runtime log:**
```
[CM:sw] Tier 2 skipAutoInject=true — injection deferred to MigrationModal button click
```

**Background:**
Auto-injection is supposed to automatically push the migration context into the target platform's input field after the migration is built. It was previously working. A recent change introduced a `skipAutoInject` flag that is now incorrectly set to `true` for all Tier 2 and Tier 3 migrations, breaking the automatic workflow.

**Files to read FIRST:**
1. `packages/browser-extension/src/background/service-worker.ts` — search for ALL occurrences of `skipAutoInject`. Read every place it is set and every place it is read.
2. `packages/browser-extension/src/sidebar/MigrationModal.tsx` — understand how the manual "inject" button works as a fallback.

**Investigation — answer BEFORE writing any fix:**
1. List every condition that currently sets `skipAutoInject = true`. There should be at most 2–3 conditions.
2. For each condition: was this condition always present, or was it recently added?
3. Is there a feature flag, config value, or `chrome.storage` key that controls `skipAutoInject`?

**Fix:**
- Identify the SPECIFIC condition that is incorrectly evaluating to `true`
- The correct behavior is: `skipAutoInject` should be `false` (auto-inject proceeds) UNLESS:
  - The target tab is not reachable (tab was closed or navigated away)
  - The platform does not support text injection at all
  - The user has explicitly opted out in settings
- Fix only the incorrect condition — do not restructure the entire injection flow

**Output required:**
- The exact condition that was wrong
- The corrected condition with explanation of why it's correct

**CONSTRAINTS:**
- Do NOT remove `skipAutoInject` logic entirely — it is needed for edge cases.
- Do NOT change `MigrationModal.tsx` — the manual button must remain as a fallback.
- Test Tier 2 migration: the context should be injected automatically without the user needing to click "Inject".
IMPORTANT: Do not write any code until you have read every file listed under 
"Files to Read First" and explicitly confirmed what you found in each one. 
If a file doesn't exist at the path listed, stop and tell me — do not guess 
at its contents.
---

## PROMPT 14 — Fix DOM Probe Feature (Self-Healing Mechanism)

**Severity:** Medium. Disables the extension's ability to self-diagnose broken scrapers.

**Symptom:**
The "Run DOM Probe" button in the extension sidebar (or triggered automatically on ZERO-SCRAPE events) reportedly does nothing. The feature is supposed to analyze the current page's DOM, identify candidate selectors, and log them for remote configuration.

**Background (from architecture report):**
The DOM probe was implemented first in `gemini.ts` and is triggered on ZERO-SCRAPE events. It analyzes leaf nodes, identifies potential selector candidates, and logs a ranked list. This data is meant to be sent to the admin panel as a bug report.

**Files to read FIRST:**
1. `packages/browser-extension/src/content/gemini.ts` — search for `probe`, `DOM probe`, `ZERO-SCRAPE`, `selector probe`, or `candidate`
2. `packages/browser-extension/src/content/shared.ts` — look for any `runDomProbe` or `reportSelectors` function
3. `packages/browser-extension/src/background/service-worker.ts` — look for how a `SCRAPER_BROKEN` or `DOM_PROBE` message is handled
4. `packages/browser-extension/src/sidebar/Sidebar.tsx` — find the "Run DOM Probe" button and its click handler

**Investigation — trace the full call chain:**
1. What message does the "Run DOM Probe" button send?
2. What does `service-worker.ts` do when it receives that message?
3. What does the content script do when instructed to run the probe?
4. Where does the output go? (logged to console? sent to admin API? stored in Dexie?)
5. At which step does the chain break?

**Fix requirements:**
1. The probe must run when: (a) the "Run DOM Probe" button is clicked, AND (b) automatically when a ZERO-SCRAPE event occurs
2. The probe output must be: logged to the extension's DevTools console AND sent to the admin API bug report endpoint (`/api/support/bug-report/` or `/api/scraper-admin/`) with the format: `{ platform, url, candidateSelectors: [{selector, count, sampleText}], timestamp }`
3. The candidate selector ranking logic (if already written) must be preserved — fix only the trigger and reporting chain

**CONSTRAINTS:**
- Do NOT rewrite the selector-ranking algorithm — only fix what's broken in the trigger/reporting chain.
- The probe must NOT run on every page mutation — only on explicit button click or ZERO-SCRAPE event.
- The admin API call must use the same auth mechanism fixed in Prompt 1.
IMPORTANT: Do not write any code until you have read every file listed under 
"Files to Read First" and explicitly confirmed what you found in each one. 
If a file doesn't exist at the path listed, stop and tell me — do not guess 
at its contents.
---

---

# VERIFICATION CHECKLIST
> Run this after all phases are complete.

After all fixes are deployed and `pnpm run build` has been run, verify:

- [ ] Admin panel at `/admin/scrapers` loads without 403 errors
- [ ] `dist/tree-sitter.wasm` exists after build
- [ ] Tier 3 migration completes without `offscreen embed timeout` in console
- [ ] Indexing badge on session cards eventually completes (no perpetual "indexing" state)
- [ ] Opening an EXISTING Claude conversation captures messages (not just new ones)
- [ ] Opening an EXISTING ChatGPT conversation captures messages
- [ ] Opening an EXISTING Gemini conversation captures messages
- [ ] Injecting context into Gemini succeeds (no `injection failed` error)
- [ ] Tier 2 migration auto-injects without requiring a manual button click
- [ ] "Run DOM Probe" button produces output in DevTools console
