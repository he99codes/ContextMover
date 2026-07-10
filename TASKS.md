# ContextMover — Fix Session Update, ID Stability & Drive Sync

## Critical — Session ID

- [ ] **1. ID reminting on "Extension context invalidated"**
  - Same URL mints multiple IDs (a7eaca0ce0, 7dcdb836aa, 294dad3182)
  - Cause: `saveMap()` in `session-id.ts:105` fails → URL map wipes → new ID minted
  - Fix: In-memory `Map<string,string>` cache in `session-id.ts` survives storage errors
  - File: `src/lib/session-id.ts`

- [ ] **2. Duplicate sessions after extension reinstall + Drive sync**
  - Reinstall wipes `chrome.storage.local` → URL map gone → new ID minted for same URL
  - Drive has old session under old ID → local has new session under new ID → duplicates
  - Fix: On `pullFromDrive`/`bootstrapInitialIndex`, match Drive sessions to local by URL key
  - Files: `src/lib/drive/sync-manager.ts`, `src/lib/session-id.ts`

- [ ] **3. Gemini SPA — all conversations share `/app` path**
  - `urlKeyFromHref` strips query params for Gemini → all Gemini sessions get same URL key
  - Fix: Extract conversation ID from Gemini URL hash/fragment or DOM, include in URL key
  - File: `src/lib/session-id.ts:54-57`

## Critical — Capture Pipeline

- [ ] **4. fullHistory rejected: too few messages (2 < 3)**
  - `interceptor-bridge.ts` rejects captures with `cleaned.length < 3`
  - New conversations with 1 user + 1 assistant = 2 messages → rejected
  - Fix: Lower threshold to `< 2` (or remove entirely for fullHistory flag)
  - File: `src/content/interceptor-bridge.ts`

- [ ] **5. DOM scraper shrink suppression — merge instead of suppress**
  - `shared.ts:598-605` returns early if scrape is smaller than previous
  - Virtual scroll eviction causes legitimate shrinks → data loss
  - Fix: Use `mergePartialScrape()` (already exists in `capture-merge.ts`) instead of suppressing
  - File: `src/content/shared.ts:598-605`

- [ ] **6. SPA navigation not forcing new session ID**
  - New chat in SPA may not change URL → old session ID reused
  - Fix: Detect conversation content change, set `forceNewSession = true`
  - File: `src/content/shared.ts`

## High — Error Handling

- [ ] **7. Uncaught "Extension context invalidated" errors**
  - `chrome.runtime.sendMessage` throws after extension reload/update
  - Fix: Wrap all `sendMessage` calls in try-catch in `shared.ts`
  - File: `src/content/shared.ts:633,671`

- [ ] **8. Detect context invalidation → auto-reload or warn**
  - Content script becomes orphaned after extension reload
  - Fix: Detect invalidation, show banner or auto-reload tab
  - File: `src/content/shared.ts`

## Medium — Drive Sync & Indexing

- [ ] **9. Drive sync debounce too slow (30s)**
  - `DEBOUNCE_MS = 30_000` in `sync-manager.ts:44` delays uploads
  - Sidebar on other devices sees stale state for 30s+
  - Fix: Reduce to 5-10s, or flush immediately on first capture
  - File: `src/lib/drive/sync-manager.ts:44`

- [ ] **10. Indexing data not synced real-time**
  - Chunks + hashes only uploaded in `flushUploadQueue` after session upload
  - No separate debounce for indexing CRUD
  - Fix: Upload chunks/hashes immediately after `backgroundIndex` completes
  - File: `src/lib/drive/sync-manager.ts`, `src/background/service-worker.ts`

- [ ] **11. Sidebar shows "not indexed" / "partial" incorrectly**
  - `indexedIds` only counts `sessionHashes` with `isComplete=true`
  - Drive-restored sessions may have chunks but no hash, or hash without `isComplete`
  - Fix: Count session as indexed if it has chunks OR complete hash
  - File: `src/sidebar/Sidebar.tsx:435`

- [ ] **12. Offscreen embed timeouts & indexing stalls**
  - `offscreen embed timeout` errors cause indexing to fail silently
  - Fix: Retry with backoff, fall back to keyword search after 2 retries
  - File: `src/lib/semantic-index/index.ts:356`

## Low — Performance

- [ ] **13. MIN_SEND_INTERVAL_MS too high (2000ms)**
  - Rapid conversation updates throttled for 2s
  - Fix: Reduce to 1000ms or make adaptive
  - File: `src/content/shared.ts:316`

- [ ] **14. Multiple fetch interceptor re-installs**
  - `fetch-interceptor.ts` may install multiple times on SPA navigation
  - Fix: Guard with `window.__contextForgeFetchInstalled` flag
  - File: `src/content/fetch-interceptor.ts`

- [ ] **15. Non-conversation API responses logged**
  - Fetch interceptor logs all API responses including non-conversation ones
  - Fix: Filter by URL pattern before logging
  - File: `src/content/fetch-interceptor.ts`

## Verification

- [ ] Session IDs stable across extension reloads
- [ ] Sessions restored from Drive merge with local (no duplicates)
- [ ] Sidebar shows correct indexed/partial/not-indexed states
- [ ] No uncaught "Extension context invalidated" errors
- [ ] fullHistory with 2 messages accepted
- [ ] Shrinking DOM scrapes merge correctly
- [ ] SPA navigation triggers new session ID
- [ ] Drive sync completes < 10s after capture
- [ ] Build passes: `pnpm build` in `packages/browser-extension/`

## New — From Gemini Logs (2026-06-24)

- [ ] **16. Gemini scraper returning 0 messages**
  - `strategy=2 user=0 asst=0 selectorHits(u=0 a=0)` on every scrape
  - Root `chat-window-content` found but `hasContent=false children=4`
  - Structural fallback also fails: `too few substantial elements (2), skipping`
  - Result: `gemini: New empty session — waiting for first message` even on existing conversations
  - Fix: Update Gemini selectors for 2026 DOM — check `chat-window-content` children structure
  - File: `src/content/gemini.ts`

- [ ] **17. Fetch interceptor CSP violations from ad/analytics URLs**
  - Interceptor catches `doubleclick.net`, `googleadservices.com`, `google-analytics.com` requests
  - These violate Gemini's CSP → console errors + log spam
  - Fix: Filter non-conversation URLs early in fetch interceptor (whitelist conversation API patterns)
  - File: `src/content/fetch-interceptor.ts`

- [ ] **18. Clipboard paste injection fails: "Document is not focused"**
  - `NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Document is not focused`
  - Clipboard strategy fails when tab is not focused (e.g. during background migration)
  - Fix: Fall back to execCommand/innerText when clipboard fails, or focus document first
  - File: `src/content/gemini.ts` (injectIntoGeminiInput)

- [ ] **19. Gemini SPA navigation timing — scraper fires before DOM renders**
  - `URL changed — re-resolving sessionId` fires, then scraper runs immediately
  - New DOM hasn't rendered messages yet → 0 messages → "New empty session"
  - Fix: Add delay or retry after URL change detection before first scrape
  - File: `src/content/shared.ts`

## Critical — Indexing Broken (from sidebar state 2026-06-24)

- [ ] **20. Indexing nearly completely broken — only 5/74 indexed, 69 pending**
  - Sidebar shows `Indexed: 5/74 · 69 pending`
  - Only 2 sessions show `✓ indexed`, 1 `◐ partial`, rest `○ not indexed`
  - Sessions from days/weeks ago still not indexed → queue is stalled, not just slow
  - Root cause candidates:
    - Offscreen embedding document failing to spawn or timing out
    - `backgroundIndex()` never called or silently failing after capture
    - `pendingIndex` queue not being drained by service worker
    - `sessionHashes` table not being populated (sidebar checks `isComplete=true`)
  - Fix: Debug `backgroundIndex()` pipeline end-to-end, check offscreen doc lifecycle
  - Files: `src/lib/semantic-index/index.ts`, `src/background/service-worker.ts`

- [ ] **21. Drive-synced sessions showing as 📱 Local not ☁**
  - Most sessions show `📱 Local` even though Drive is connected (✓)
  - Sessions restored from Drive after reinstall should show ☁ sourced
  - Fix: Check `driveSourcedSet` population in sidebar, ensure `SOURCED_IDS_KEY` persists
  - Files: `src/sidebar/Sidebar.tsx`, `src/lib/drive/sync-manager.ts`

- [ ] **22. Old sessions never re-indexed**
  - Sessions from 10-35 days ago still `○ not indexed`
  - No mechanism to backfill indexing for sessions captured before indexing was added
  - Fix: On sidebar open, scan for unindexed sessions and enqueue background indexing
  - Files: `src/sidebar/Sidebar.tsx`, `src/background/service-worker.ts`

## Critical — Dual Indexing System Mismatch (from SW + offscreen logs)

- [ ] **23. Two indexing systems don't share data — Dexie chunks vs attention IDB**
  - `SemanticIndex` → offscreen embeddings → Dexie `chunkEmbeddings` table
  - `AttentionEngine` → regex-only → separate IDB store (attention IDB)
  - `claude-9726c4580d`: attention engine indexed 39 chunks, but `handleMigrateContext` says "No chunks" because it checks Dexie only
  - Sidebar `indexedIds` checks `sessionHashes` table — neither store matches
  - Fix: Unify — either attention engine writes to Dexie, or sidebar checks both stores
  - Files: `src/lib/semantic-index/index.ts`, `src/lib/attention-engine.ts`, `src/sidebar/Sidebar.tsx`

- [ ] **24. `tier=minimal` skips offscreen embeddings entirely**
  - CPU benchmark: 229 ops/ms < 300 threshold → `tier=minimal` → regex-only attention engine
  - Sessions on slow machines NEVER get Dexie chunks → sidebar shows "not indexed" forever
  - Fix: Lower threshold or always attempt offscreen embeddings (fallback to regex on timeout)
  - Files: `src/lib/attention-engine.ts`, `src/lib/semantic-index/index.ts`

- [ ] **25. `no_chunks_tier1_fallback` error on migration**
  - `handleMigrateContext` fails with `Error: no_chunks_tier1_fallback` when Dexie has 0 chunks
  - Even though attention engine has 39 chunks for same session
  - Fix: Fall back to attention engine chunks when Dexie is empty
  - File: `src/background/service-worker.ts`

- [ ] **26. Indexing very slow — 30s for 15 messages**
  - `gemini-f37993fb8b: 23 chunks indexed in 30264ms` — 30 seconds for 15 msgs
  - Offscreen embedding batches work but each batch takes ~5-10s
  - 69 pending sessions × 30s each = ~35 minutes to clear backlog (if queue doesn't stall)
  - Fix: Increase batch size, parallelize, or reduce chunk count per session
  - File: `src/lib/semantic-index/index.ts`

- [ ] **27. Background indexing queue not draining for old sessions**
  - Only active captures trigger `backgroundIndex()` — old sessions never get enqueued
  - `pendingIndex` table may have entries but nothing processes them on SW restart
  - Fix: On SW startup, drain `pendingIndex` queue; on sidebar open, scan for unindexed
  - Files: `src/background/service-worker.ts`, `src/sidebar/Sidebar.tsx`
