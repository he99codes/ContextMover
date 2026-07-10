# ContextMover — God-Level Debug Prompt

You are debugging the ContextMover Chrome Extension. Be surgical. Read every log line. Name the exact file, line, variable, and value that caused the failure. Never guess.

---

## Extension Contexts (3 separate DevTools tabs)

| Tab | How to open | What runs there |
|-----|-------------|-----------------|
| **service-worker** | chrome://extensions → "service worker" | All SW logic, migration, bg index scheduler |
| **offscreen** | chrome://extensions → "offscreen document" | Queue manager + ONNX batch runner |
| **index.html (sidebar)** | Right-click sidebar → Inspect | React UI + attention-engine.ts |

**You MUST check all 3 tabs. The bug is almost always in the offscreen tab.**

---

## Architecture

```
Sidebar.tsx
  ↓ chrome.runtime.sendMessage(MIGRATE_CONTEXT)
service-worker.ts: handleMigrateContext()
  ↓ [CM-FIX-SERIALIZE] _migrationLockPromise — only ONE migration runs at a time
  ↓ cancelBackgroundJobs() — aborts bg queue + clears _indexingSessionLock
  ↓ broadcastToViews(MIGRATION_ACTIVE: true) — sidebar attentionEngine backs off
  ↓ indexRemainingChunksPriority() if not fully indexed
      ↓ semanticIndex.indexSessionPriority()
          ↓ offscreenIndex(priority=true)
              ↓ OFFSCREEN_INDEX_SESSION → offscreen.ts priorityQueue
                  ↓ ml-worker.ts ONNX batches (8 texts each)
                  ↓ writes chunkEmbeddings + sessionHashes to Dexie
  ↓ semanticIndex.retrieve() → OFFSCREEN_EMBED_QUERY → cosine score → top K chunks
  ↓ buildMigrationFile() → sendResponse(success)
  ↓ broadcastToViews(MIGRATION_ACTIVE: false) + releaseLock()
```

---

## Key State (service-worker.ts)

| Variable | Type | Meaning |
|----------|------|---------|
| `activeMigrationInProgress` | `boolean` | Blocks `backgroundIndex()` from starting |
| `_migrationLockPromise` | `Promise<void>` | **Serializes concurrent migrations** — chain-locks |
| `_indexingInFlight` | `Set<string>` | sessionIds currently bg-indexing |
| `_indexDirty` | `Set<string>` | Changed mid-index — re-queue after done |

## Key State (semantic-index/index.ts)

| Variable | Type | Meaning |
|----------|------|---------|
| `_indexingSessionLock` | `Set<string>` | Prevents duplicate indexing of same session |
| `_backgroundQueue` | `Array` | Pending bg jobs |
| `_migrationAbort` | `AbortController\|null` | Aborts in-flight bg offscreen job |

## Key State (offscreen.ts)

| Variable | Type | Meaning |
|----------|------|---------|
| `priorityQueue` | `Array` | Migration jobs — drained first |
| `backgroundQueue` | `Array` | Bg index jobs |
| `cancelledRequests` | `Set<string>` | requestIds of aborted bg jobs |
| `modelReady` | `boolean` | ONNX warm — false = 20-40s cold start pending |

---

## Error Codes → Root Cause

| Error string | Where thrown | Root cause |
|-------------|--------------|------------|
| `indexing_timeout` | `handleMigrateContext` | `indexRemainingChunksPriority` ran out of `min(40s + msgs×20ms, 60s)` |
| `retrieve_timeout` | `handleMigrateContext` | `semanticIndex.retrieve()` > 45s |
| `tier3_timeout` | `handleMigrateContext` | wraps either of the above |
| `offscreen embed timeout (90s)` | `offscreenEmbedQuery` | ONNX cold or worker flooded |
| `cancelled_for_migration` | `offscreenIndex` | AbortController fired from `cancelBackgroundJobs()` |
| `model load timeout` | `offscreen.ts` | ONNX never reached `modelReady` in 60s |

---

## Timeout Budget

| Timeout | Value | File |
|---------|-------|------|
| Migration index | `min(40000 + msgs×20, 60000)` ms | `service-worker.ts: INDEX_TIMEOUT_MS` |
| Migration retrieve | `45000` ms | `service-worker.ts` |
| Priority offscreen job | same as migration index | `semantic-index/index.ts: offscreenIndex` |
| Bg offscreen job | `min(60000 + msgs×2000, 300000)` ms | `semantic-index/index.ts: offscreenIndex` |
| Query embed | `90000` ms | `semantic-index/index.ts: offscreenEmbedQuery` |
| ONNX model load | `60000` ms | `offscreen.ts` |

---

## Dexie Tables

| Table | Primary key | Contents |
|-------|-------------|----------|
| `sessions` | `id` | Full ContextSession |
| `chunkEmbeddings` | `sessionId:chunkIndex` | Text + Float32Array embedding |
| `sessionHashes` | `sessionId` | `{ isComplete, lastIndexedMessageIndex, chunkCount }` |
| `pendingIndex` | `sessionId` | Sessions awaiting bg index |
| `storedSummaries` | composite | Cached Tier 1/2/3 outputs |
| `perfEvents` | `id` | Latency measurements |

---

## Known Fixed Bugs (do not reintroduce)

| Bug | Fix | Location |
|-----|-----|----------|
| 5s spin-wait in `indexSessionPriority` | Removed — force-clears lock immediately | `semantic-index/index.ts` |
| `cancelBackgroundJobs` left stale locks | Added `_indexingSessionLock.clear()` | `semantic-index/index.ts` |
| Two T3 migrations running concurrently, cancelling each other | `_migrationLockPromise` chain-lock | `service-worker.ts` |
| `MIGRATION_ACTIVE` broadcast never reached sidebar | Replaced `runtime.sendMessage` with `broadcastToViews()` | `service-worker.ts` |
| 10s `_indexingInFlight` wait before priority indexing | Removed (lock already cleared above) | `service-worker.ts` |
| `attentionEngine.indexSession()` competing with T3 embed batches | `_migrationActive` guard in `attention-engine.ts` | `attention-engine.ts` |

---

## Debug Protocol

### Step 1 — Match error code
Use the Error Codes table above. Get the exact timeout path.

### Step 2 — Build the timeline (timestamps matter)
From all 3 console tabs, sequence:
1. When did `[CM:offscreen] booted` / `ml-worker ready` fire? (cold = +20-40s)
2. Was a bg index job running when migration fired?
3. Did `[CM:queue] Cancelled X queued + aborted in-flight` log appear?
4. Did `[CM:sw] Migration indexing: N msgs` log appear? What was N?
5. Did `[CM:T3] sampling X/Y chunks` appear in offscreen?
6. Were there any batch sends AFTER the priority job started that are NOT `[CM:T3]`? (= another job flooded the worker)
7. When did the timeout fire vs. when did the last batch complete?

### Step 3 — Check for concurrent migrations
Look for TWO of these in the SW log:
```
[CM:sw] Migration indexing: NNN msgs ...
[CM:queue] Cancelled 1 queued + aborted in-flight ...
[CM:sw] Migration indexing: MMM msgs ...
```
If you see the pattern twice before the first `MIGRATE_CONTEXT response`, two migrations ran concurrently. Fixed by `_migrationLockPromise`.

### Step 4 — Check sidebar attention-engine interference
In **index.html** console, look for `[ContextMover:attention-engine] indexSession` firing AFTER `[CM:sw] Migration indexing` started. If present, `MIGRATION_ACTIVE` broadcast isn't reaching sidebar.

### Step 5 — Check Dexie state
In **service worker** console:
```js
checkSessionInDb('session-id-here')   // hash state, chunk count, isComplete
listRecentSessions()                   // all sessions, message counts
getPerfStatsFromConsole()              // P50/P90 latency by operation
```

### Step 6 — Verify the lock sequence
In offscreen log, every batch should be sequential — one `BATCH START` → `BATCH DONE` → next `BATCH START`. If you see two `BATCH START` lines before a `BATCH DONE`, the worker was double-sent (impossible by design but verify).

---

## Correct Healthy Migration Log Sequence

```
SW:  [CM:queue] Cancelled X queued + aborted in-flight background jobs for migration
SW:  [CM:sw] Migration indexing: 149 msgs, batch=150, batches=1
OFF: [CM:queue] dequeue priority claude-XXXXX
OFF: [CM:offscreen] embedBatchViaWorker: sending 8 texts, req=AAAA
ML:  [CM:ml-worker] BATCH START: 8 texts, req=AAAA
ML:  [CM:ml-worker] BATCH DONE: sent 8 embeddings
     ... (repeat for all batches, NO other sessions interleaved) ...
OFF: [CM:offscreen] indexed session claude-XXXXX — NNN chunks
OFF: [CM:T3] sampling 150/NNN chunks (balanced tier)
OFF: [CM:offscreen] embedBatchViaWorker: sending 8 texts, req=BBBB  ← query embed
ML:  [CM:ml-worker] BATCH DONE: sent 8 embeddings
SW:  [CM:migration] MIGRATE_CONTEXT response: {"success":true,...}
```

Any deviation from this sequence = a bug. Identify the first line that breaks the pattern.

---

## What Is Working ✅
- Capture: Claude, ChatGPT, Gemini, Grok, Perplexity, DeepSeek
- Tier 1 migration (<3s)
- Tier 2 migration (structured extraction)
- Background indexing P50
- Drive sync
- Auth token refresh
- Migration serialization lock (no concurrent T3s)
- `cancelBackgroundJobs` clears all locks immediately
- `attentionEngine.indexSession` skips during migration

## What May Still Be Slow ❌
- Tier 3 on cold ONNX start (~20-40s model load eats into 40s budget)
- Query embed when offscreen doc was closed between sessions
- Backgroun index P90 on very large sessions (500+ msgs)
