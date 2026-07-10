# Quick Test Guide — Phase 4 Verification

**Time Required:** 10-15 minutes  
**Prerequisites:** Extension reloaded, DevTools open (F12)

---

## Test 1: Capture — Claude (2 min)

```
1. Open existing Claude conversation (5+ messages)
2. Check console for: [CM:claude] scraped: total=X
3. Verify sidebar shows session with correct count
```

**Expected:** Messages captured, no errors  
**Fail Condition:** "Selector not found" or "NO messages found"

---

## Test 2: Capture — ChatGPT (2 min)

```
1. Open existing ChatGPT conversation
2. Check console for: [CM:chatgpt] fetch-tap user=X asst=Y
3. Verify sidebar shows session
```

**Expected:** Fetch interceptor detects endpoint, messages captured  
**Fail Condition:** "fetch-tap" not in logs, 0 messages

---

## Test 3: Capture — Gemini (2 min)

```
1. Open existing Gemini conversation
2. Check console for: [CM:gemini] root found: chat-window
3. Verify messages captured (not "NO messages found")
```

**Expected:** Custom element selector works, messages captured  
**Fail Condition:** "NO messages found" or "Selector not found"

---

## Test 4: Capture — Grok (2 min)

```
1. Open existing Grok conversation
2. Refresh page (URL changes with new ?rid=)
3. Check sidebar: Should show ONE session (not two)
4. Verify message count increased (not separate session)
```

**Expected:** Same conversation = same sessionId, no duplicates  
**Fail Condition:** Two sessions for same conversation

---

## Test 5: Capture — DeepSeek (2 min)

```
1. Open existing DeepSeek conversation
2. Check console for: [CM:deepseek] strategy=A user=X asst=Y
3. Verify messages captured
```

**Expected:** Messages captured correctly  
**Fail Condition:** "NO messages found" or 0 messages

---

## Test 6: Capture — Perplexity (2 min)

```
1. Open existing Perplexity conversation
2. Check console for: [CM:perplexity] scraped: total=X
3. Verify sidebar shows session
```

**Expected:** Messages captured  
**Fail Condition:** "Selector not found" or 0 messages

---

## Test 7: Auto-Injection (3 min)

```
1. Open conversation with 10+ messages
2. Click "Migrate" → Select Tier 2 → Click "Migrate Smart Summary"
3. DO NOT click any "Inject" button
4. Wait 5-10 seconds
5. Check target platform tab: Text should appear in input field
```

**Expected:** Context auto-injected without manual button click  
**Fail Condition:** Input field empty after 10 seconds, or "skipAutoInject=true" in logs

---

## Test 8: Gemini Injection Logging (2 min)

```
1. During migration to Gemini, monitor console
2. Look for detailed logs:
   [CM:gemini] Input element found, focusing and clicking
   [CM:gemini] Attempting Quill API path
   [CM:gemini] Quill API path succeeded
```

**Expected:** Detailed step-by-step logs  
**Fail Condition:** "reason: unknown" or no logs

---

## Test 9: DOM Probe (2 min)

```
1. Open any conversation
2. Open sidebar settings/debug panel
3. Click "🔍 DOM Probe" button
4. Check console for: [CM:gemini] DOM probe completed: X candidates found
5. Sidebar should display top 5 candidates
```

**Expected:** Probe runs, returns candidates, displays in sidebar  
**Fail Condition:** Button does nothing, no console output

---

## Test 10: Build Artifacts (1 min)

```
1. Run: cd /home/vip/Desktop/ContextMover/packages/browser-extension && pnpm build
2. Check: ls -la dist/*.wasm
3. Verify: dist/tree-sitter.wasm exists (>1MB)
4. Verify: dist/ort-wasm-simd.wasm exists
```

**Expected:** All WASM files present  
**Fail Condition:** Missing .wasm files

---

## Quick Checklist

- [ ] Claude captures messages
- [ ] ChatGPT captures messages
- [ ] Gemini captures messages
- [ ] Grok captures messages (no duplicates)
- [ ] DeepSeek captures messages
- [ ] Perplexity captures messages
- [ ] Tier 2 auto-injects without button click
- [ ] Gemini injection shows detailed logs
- [ ] DOM Probe button works
- [ ] Build artifacts present

---

## If Test Fails

### "Selector not found: main"
```
✅ FIXED — Root container changed to document.body
Run: pnpm build && reload extension
```

### "NO messages found"
```
Check console for:
- [CM:platform] ZERO-SCRAPE: no selectors matched any nodes
- [CM:platform] ZERO-SCRAPE: selectors hit nodes but all were filtered

If filtered: Check isStreaming() or extractContent() logic
If no selectors: Selector may have changed, run DOM Probe
```

### "skipAutoInject=true" in logs
```
✅ FIXED — Changed to skipAutoInject: false
Run: pnpm build && reload extension
```

### "RUN_DOM_PROBE message silently dropped"
```
✅ FIXED — Added service worker handler + content script listener
Run: pnpm build && reload extension
```

### "reason: unknown" for injection error
```
✅ FIXED — Added comprehensive error logging
Run: pnpm build && reload extension
Check console for [CM:gemini] logs with actual error details
```

---

## Console Logs to Expect

### Healthy Capture
```
[CM:claude] scraped: total=12 user=5 asst=7
[ContextMover] Snapshot hash unchanged, skipping
[CM:health] claude: success=100% assistant=100%
```

### Healthy Migration
```
[CM:sw] Tier 2 skipAutoInject=false — auto-injection proceeding
[CM:gemini] INJECT_CONTEXT result: {ok: true}
[CM:sw] CAPTURE_SESSION: gemini gemini-abc123
```

### Healthy DOM Probe
```
[CM:gemini] DOM probe completed: 30 candidates found
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Selector not found: main" | Root container broken | Rebuild (✅ fixed) |
| "NO messages found" | Selector changed or filtered | Run DOM Probe |
| "skipAutoInject=true" | Auto-injection disabled | Rebuild (✅ fixed) |
| "RUN_DOM_PROBE" no output | Message routing broken | Rebuild (✅ fixed) |
| "reason: unknown" | Error logging missing | Rebuild (✅ fixed) |
| Duplicate sessions | URL tracking params | Rebuild (✅ fixed) |
| Premature captures | Scrollback timing | Rebuild (✅ fixed) |

---

## Success Criteria

✅ All 10 tests pass  
✅ No "Selector not found" errors  
✅ No "NO messages found" errors  
✅ No "reason: unknown" errors  
✅ Auto-injection works without button click  
✅ DOM Probe button produces output  
✅ Build completes with all WASM files  

**If all criteria met:** Ready for production deployment 🚀
