# ContextMover Verification Checklist

**Date:** June 4, 2026  
**Build:** Post-Phase 4 (All High-Priority Fixes)

---

## Pre-Verification Setup

1. **Reload Extension**
   ```
   chrome://extensions → Find ContextMover → Click reload icon
   ```

2. **Clear Cache** (optional but recommended)
   ```
   DevTools → Application → Clear site data
   ```

3. **Open DevTools Console**
   ```
   F12 → Console tab → Keep open during testing
   ```

---

## PHASE 1 — Admin Panel & Build Artifacts

### ✅ Admin Panel Access
- [ ] Navigate to `chrome-extension://[EXTENSION_ID]/dist/admin.html` (or `/admin/scrapers`)
- [ ] Page loads without 403 errors
- [ ] Selector configuration table visible
- [ ] No CORS errors in console

**Expected:** Admin panel shows current selector overrides for all 6 platforms

---

### ✅ Build Artifacts
- [ ] Run `cd /home/vip/Desktop/ContextMover/packages/browser-extension && pnpm build`
- [ ] Build completes successfully (exit code 0)
- [ ] `dist/tree-sitter.wasm` exists (check file size > 1MB)
- [ ] `dist/ort-wasm-simd.wasm` exists
- [ ] All `.js` bundles in `dist/assets/` are present

**Expected:** Build time ~90 seconds, all WASM files copied

---

## PHASE 2 — Capture Pipeline (All LLMs)

### ✅ Claude — Existing Conversation
1. Open an existing Claude conversation (one with 5+ messages)
2. Open DevTools console
3. Look for logs: `[CM:claude] scraped: total=X user=Y asst=Z`
4. Check sidebar: Session should appear with correct message count

**Expected:** Messages captured immediately, no "ZERO-SCRAPE" errors

---

### ✅ ChatGPT — Existing Conversation
1. Open an existing ChatGPT conversation
2. Check console for: `[CM:chatgpt] fetch-tap user=X asst=Y`
3. Verify sidebar shows session with all messages

**Expected:** Fetch interceptor detects `/ces/v1/t` endpoint, captures all messages

---

### ✅ Gemini — Existing Conversation
1. Open an existing Gemini conversation
2. Check console for: `[CM:gemini] root found: chat-window`
3. Verify messages captured (not "NO messages found")
4. Check for scrollback logs: `[CM:gemini] scrollback: DOM settled`

**Expected:** Custom element selectors work, scrollback completes, all messages captured

---

### ✅ Grok — Existing Conversation
1. Open an existing Grok conversation
2. Check console for: `[CM:grok] scraped: total=X`
3. Verify no duplicate sessions in sidebar (same conversation = same sessionId)
4. Refresh page, verify sessionId doesn't change

**Expected:** URL tracking params stripped, same conversation = same sessionId

---

### ✅ DeepSeek — Existing Conversation
1. Open an existing DeepSeek conversation
2. Check console for: `[CM:deepseek] strategy=A user=X asst=Y`
3. Verify virtual scroll handling: `suppressed shrinking scrape` logs OK
4. Check sidebar for session with correct message count

**Expected:** Class-pattern selectors work, virtual scroll doesn't cause duplicates

---

### ✅ Perplexity — Existing Conversation
1. Open an existing Perplexity conversation
2. Check console for: `[CM:perplexity] scraped: total=X`
3. Verify session appears in sidebar
4. Check for any "Selector not found" errors

**Expected:** Messages captured, no selector errors

---

## PHASE 3 — Session Management & Deduplication

### ✅ No Duplicate Sessions
1. Open Grok conversation with title "test conversation"
2. Refresh page (URL changes with new `?rid=`)
3. Check sidebar: Should show **ONE** session (not two)
4. Verify message count increased (not separate session)

**Expected:** URL key strips `?rid=`, same conversation = same sessionId

---

### ✅ Session ID Persistence
1. Open a conversation in any LLM
2. Note the sessionId in console: `[CM:session-id] ... → existing sessionId=xxx`
3. Navigate away and back to same conversation
4. Verify same sessionId returned (not new one)

**Expected:** URL→sessionId mapping persists in `chrome.storage.local`

---

## PHASE 4 — Migration & Injection

### ✅ Tier 2 Auto-Injection (PROMPT 13)
1. Open a conversation with 10+ messages
2. Click "Migrate" button in sidebar
3. Select Tier 2 (Smart Summary)
4. Click "Migrate Smart Summary"
5. **DO NOT click any "Inject" button**
6. Wait 5-10 seconds
7. Check target platform tab: Text should appear in input field automatically

**Expected:** Context auto-injected without manual button click

**Console logs:**
```
[CM:sw] Tier 2 skipAutoInject=false — auto-injection proceeding
[CM:gemini] INJECT_CONTEXT result: {ok: true}
```

---

### ✅ Gemini Injection Error Logging (PROMPT 12)
1. During migration to Gemini, monitor console
2. Look for detailed logs:
   ```
   [CM:gemini] Input element found, focusing and clicking
   [CM:gemini] Attempting Quill API path
   [CM:gemini] Quill API path succeeded
   ```
3. If injection fails, error should be specific (not "unknown"):
   ```
   [CM:gemini] beforeinput event path error: [actual error]
   ```

**Expected:** Detailed error messages, not generic "reason: unknown"

---

### ✅ Tier 3 Offscreen Document
1. Open conversation with 20+ messages
2. Select Tier 3 (Attention Engine)
3. Click "Migrate with Attention Engine"
4. Monitor console for offscreen document logs:
   ```
   [CM:offscreen] document created
   [CM:index] embedding session...
   ```
5. Should complete within 15 seconds

**Expected:** No `offscreen embed timeout` errors, embedding completes

---

## PHASE 5 — Indexing & Semantic Search

### ✅ Indexing Badge Completion
1. Open sidebar
2. Select a session with 10+ messages
3. Look for "Indexing..." badge on session card
4. Wait for badge to disappear (should take 5-30 seconds depending on message count)

**Expected:** Badge eventually completes, no perpetual "indexing" state

---

### ✅ Semantic Retrieval
1. After indexing completes, open Tier 3 migration
2. Type a task: "Fix the bug where X happens"
3. Check console for: `[CM:index] retrieved X chunks`
4. Verify attention map shows relevant messages highlighted

**Expected:** Semantic index returns relevant chunks, attention map generated

---

## PHASE 6 — Self-Healing Features

### ✅ DOM Probe Button (PROMPT 14)
1. Open any conversation
2. Open sidebar settings/debug panel
3. Click "🔍 DOM Probe" button
4. Check console for:
   ```
   [CM:gemini] DOM probe completed: 30 candidates found
   ```
5. Sidebar should display top 5 candidates with:
   - Selector name
   - Likely role (user/assistant/input)
   - Sample text

**Expected:** Probe runs, returns candidates, displays in sidebar

---

### ✅ SCRAPER_BROKEN Handling
1. Manually break a selector in DevTools (e.g., rename a class)
2. Refresh page
3. Check console for:
   ```
   [ContextMover] UI Update Detected! Scraper broken on gemini: ...
   [CM:config] Selector config refreshed after SCRAPER_BROKEN
   ```
4. Verify remote config is fetched

**Expected:** Self-healing triggers, fresh selectors fetched

---

## PHASE 7 — Data Integrity

### ✅ Message Deduplication
1. Open a conversation
2. Trigger capture twice (e.g., by navigating away and back)
3. Check sidebar: Message count should NOT double
4. Verify in DevTools: `[ContextMover] Snapshot hash unchanged, skipping`

**Expected:** Duplicate captures suppressed by hash check

---

### ✅ Cross-Session Contamination Guard
1. Open two different conversations in same LLM
2. Migrate context from conversation A
3. Verify context contains only messages from A (not from B)
4. Check console for any `CRITICAL: cross-session chunk` warnings

**Expected:** No cross-session message mixing

---

## PHASE 8 — Error Handling

### ✅ Tab Unreachable Handling
1. Open a conversation
2. Close the target platform tab
3. Try to migrate
4. Should show error: "Open a [Platform] tab, then try again"

**Expected:** Graceful error, no crash

---

### ✅ Content Script Not Ready
1. Open extension on a page without proper content script
2. Try to migrate
3. Should fallback to `executeScript` injection
4. Check console for: `[CM:sw] Content script absent — falling back to executeScript`

**Expected:** Fallback injection succeeds

---

## Summary Checklist

| Phase | Component | Status |
|-------|-----------|--------|
| 1 | Admin Panel | ⬜ |
| 1 | Build Artifacts | ⬜ |
| 2 | Claude Capture | ⬜ |
| 2 | ChatGPT Capture | ⬜ |
| 2 | Gemini Capture | ⬜ |
| 2 | Grok Capture | ⬜ |
| 2 | DeepSeek Capture | ⬜ |
| 2 | Perplexity Capture | ⬜ |
| 3 | No Duplicates | ⬜ |
| 3 | SessionId Persistence | ⬜ |
| 4 | Tier 2 Auto-Inject | ⬜ |
| 4 | Gemini Injection Logging | ⬜ |
| 4 | Tier 3 Offscreen | ⬜ |
| 5 | Indexing Badge | ⬜ |
| 5 | Semantic Retrieval | ⬜ |
| 6 | DOM Probe | ⬜ |
| 6 | SCRAPER_BROKEN | ⬜ |
| 7 | Message Dedup | ⬜ |
| 7 | Cross-Session Guard | ⬜ |
| 8 | Tab Unreachable | ⬜ |
| 8 | Fallback Injection | ⬜ |

---

## Known Issues to Watch For

1. **WebAssembly MIME Type Warning**
   - Expected: `WebAssembly.instantiateStreaming failed... Falling back to instantiate`
   - This is normal, not a blocker

2. **Offscreen Document Timeout**
   - If embedding takes >15s, check hardware profile
   - Tier 3 may downgrade to Tier 2 on slow devices

3. **Virtual Scroll Eviction**
   - Expected: `suppressed shrinking scrape (18→3) — likely virtual scroll eviction`
   - This is correct behavior, not an error

4. **Zero-Scrape Retries**
   - Expected: `0 messages after 18 — retry 1/3`
   - Retries 3 times before giving up (normal for async rendering)

---

## Rollback Plan

If critical issues found:

1. **Revert latest commit:**
   ```bash
   git -C /home/vip/Desktop/ContextMover reset --hard HEAD~1
   ```

2. **Rebuild:**
   ```bash
   cd /home/vip/Desktop/ContextMover/packages/browser-extension && pnpm build
   ```

3. **Reload extension** in chrome://extensions

---

## Sign-Off

- [ ] All checks passed
- [ ] No critical errors in console
- [ ] All 6 LLMs capturing correctly
- [ ] Migrations working end-to-end
- [ ] Ready for production deployment

**Verified by:** ________________  
**Date:** ________________  
**Notes:** ________________
