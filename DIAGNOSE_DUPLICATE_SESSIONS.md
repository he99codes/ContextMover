# Diagnostic Guide: Multiple Sessions with Same Context

## The Problem You're Describing

Multiple sessions appearing in sidebar with the **same messages** but **different sessionIds**:

```
Session 1: grok-xxx (messages 1-52)
Session 2: grok-yyy (messages 1-52) ← SAME CONTEXT
Session 3: grok-zzz (messages 1-52) ← SAME CONTEXT
```

## Root Cause

The URL→sessionId mapping in `chrome.storage.local` is either:
1. **Not being saved** (storage error)
2. **Not being loaded** (storage read error)
3. **Being cleared** (SESSION_FORGOTTEN broadcast)
4. **URL is changing** (different URL = different sessionId, which is correct)

## How to Diagnose

### Step 1: Check Console Logs

Open DevTools Console and look for these logs:

**Good (mapping is working):**
```
[CM:session-id] grok: URL key "grok::grok.com/c/abc123" → existing sessionId=grok-12345
[CM:session-id] grok: Saved mapping: "grok::grok.com/c/abc123" → "grok-12345"
```

**Bad (mapping not working):**
```
[CM:session-id] grok: URL key "grok::grok.com/c/abc123" NOT in map. Current map size: 0
[CM:session-id] grok: URL key "grok::grok.com/c/abc123" → NEW sessionId=grok-99999
[CM:session-id] CRITICAL: Failed to persist URL map to storage!
[CM:session-id] Storage error saving URL map: QuotaExceededError
```

### Step 2: Check Storage

In DevTools, go to **Application → Storage → Chrome Storage → Local**

Look for key: `cf:urlMap`

**Good (mapping exists):**
```json
{
  "grok::grok.com/c/abc123": "grok-12345",
  "grok::grok.com/c/def456": "grok-67890",
  "chatgpt::chatgpt.com/c/xyz789": "chatgpt-11111"
}
```

**Bad (empty or missing):**
```json
{}
```

### Step 3: Check IndexedDB

In DevTools, go to **Application → Storage → IndexedDB → contextmover → sessions**

Look for duplicate sessions with same title but different IDs:

**Bad (duplicates):**
```
Session 1:
  id: "grok-xxx"
  title: "contextmover.com look at this web"
  messages: 52

Session 2:
  id: "grok-yyy"
  title: "contextmover.com look at this web"
  messages: 52
```

## Debugging Steps

### 1. Clear Storage and Test

```javascript
// In DevTools Console:
await chrome.storage.local.clear();
console.log('Storage cleared');
```

Then:
1. Reload extension
2. Open Grok conversation
3. Check console logs for session ID resolution
4. Check if mapping is saved in storage

### 2. Check URL Stability

Open Grok conversation and check if URL changes:

```javascript
// In DevTools Console:
console.log('Current URL:', window.location.href);

// Refresh page and check again
// If URL changes, that's why you get different sessionIds
```

**Expected:** URL should be stable (same conversation = same URL)

**If URL changes:** That's the real problem (not session ID mapping)

### 3. Monitor Session ID Resolution

Add this to DevTools Console to watch session ID resolution:

```javascript
// Watch for all session-id logs
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.name.includes('session-id')) {
      console.log('Session ID event:', entry);
    }
  }
});
observer.observe({ entryTypes: ['measure'] });
```

## Common Issues and Fixes

### Issue 1: Storage Quota Exceeded

**Symptom:**
```
[CM:session-id] Storage error saving URL map: QuotaExceededError
```

**Fix:**
1. Clear extension storage: `await chrome.storage.local.clear()`
2. Check if other extensions are using too much storage
3. Increase storage quota (if possible)

### Issue 2: URL Changing Between Captures

**Symptom:**
```
First capture: URL = https://grok.com/c/abc123?rid=xyz1
Second capture: URL = https://grok.com/c/abc123?rid=xyz2 (DIFFERENT!)
```

**Fix:** This is already fixed! We strip `?rid=` parameter now.

But verify the fix is working:
```javascript
// In DevTools Console:
const { urlKeyFromHref } = await import('chrome-extension://xxx/lib/session-id.ts');
const key1 = urlKeyFromHref('grok', 'https://grok.com/c/abc123?rid=xyz1');
const key2 = urlKeyFromHref('grok', 'https://grok.com/c/abc123?rid=xyz2');
console.log('Key 1:', key1);
console.log('Key 2:', key2);
console.log('Same?', key1 === key2); // Should be true
```

### Issue 3: SESSION_FORGOTTEN Broadcast

**Symptom:**
```
[ContextMover:bridge] cleared cached state for forgotten session grok-xxx
```

This clears the sessionId cache, forcing a new resolution.

**Check:** Did you delete a session in the sidebar? That triggers SESSION_FORGOTTEN.

## Expected Behavior

### Correct Flow

```
1. User opens Grok conversation
   URL: https://grok.com/c/abc123?rid=xyz1
   
2. Extension resolves sessionId
   URL key: "grok::grok.com/c/abc123"
   sessionId: "grok-12345"
   Saved to storage
   
3. First capture
   sessionId: "grok-12345"
   messages: 52
   
4. User refreshes page
   URL: https://grok.com/c/abc123?rid=xyz2 (rid changed)
   
5. Extension resolves sessionId again
   URL key: "grok::grok.com/c/abc123" (same key, rid stripped)
   Finds in storage: "grok-12345"
   Returns existing sessionId
   
6. Second capture
   sessionId: "grok-12345" (SAME!)
   messages: 52
   
7. Sidebar shows ONE session with 52 messages
```

### Incorrect Flow (What You're Experiencing)

```
1. User opens Grok conversation
   URL: https://grok.com/c/abc123?rid=xyz1
   
2. Extension resolves sessionId
   URL key: "grok::grok.com/c/abc123"
   sessionId: "grok-12345"
   ❌ Storage save fails (quota exceeded? context invalidated?)
   
3. First capture
   sessionId: "grok-12345"
   messages: 52
   
4. User refreshes page
   URL: https://grok.com/c/abc123?rid=xyz2
   
5. Extension resolves sessionId again
   URL key: "grok::grok.com/c/abc123"
   ❌ Storage is empty (save failed before)
   ❌ Creates NEW sessionId: "grok-99999"
   
6. Second capture
   sessionId: "grok-99999" (DIFFERENT!)
   messages: 52
   
7. Sidebar shows TWO sessions with same content
```

## Testing the Fix

1. **Reload extension**
2. **Open Grok conversation**
3. **Check console for:**
   ```
   [CM:session-id] grok: URL key "grok::grok.com/c/abc123" → NEW sessionId=grok-12345
   [CM:session-id] grok: Saved mapping: "grok::grok.com/c/abc123" → "grok-12345"
   ```
4. **Refresh page** (URL changes with new ?rid=)
5. **Check console for:**
   ```
   [CM:session-id] grok: URL key "grok::grok.com/c/abc123" → existing sessionId=grok-12345
   ```
6. **Verify sidebar shows ONE session** (not two)
7. **Verify message count increases** (not separate session)

## If Still Broken

Check these in order:

1. **Storage errors?**
   ```
   [CM:session-id] CRITICAL: Failed to persist URL map to storage!
   [CM:session-id] Storage error saving URL map:
   ```

2. **URL changing?**
   ```javascript
   // Check if URL is stable
   console.log(window.location.href);
   // Refresh and check again
   ```

3. **Storage quota exceeded?**
   ```javascript
   // Check storage usage
   const info = await navigator.storage.estimate();
   console.log('Storage usage:', info.usage, '/', info.quota);
   ```

4. **SESSION_FORGOTTEN being triggered?**
   ```
   [ContextMover:bridge] cleared cached state for forgotten session
   ```

## Report with These Details

If still broken, provide:
1. Console logs (filter by `[CM:session-id]`)
2. Storage contents (DevTools → Application → Storage → Local → cf:urlMap)
3. IndexedDB sessions (DevTools → Application → IndexedDB → contextmover → sessions)
4. URL of the conversation
5. Steps to reproduce
