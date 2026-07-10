# Session ID Detection & Data Preservation Verification

## Overview
Each unique conversation across all 6 LLMs must get a unique `sessionId` and all associated data must be preserved independently.

## How Session ID Detection Works

### Flow Diagram
```
User navigates to new conversation URL
    ↓
Content script detects URL change (currentHref !== lastHref)
    ↓
Clears cached sessionId (sessionId = null)
    ↓
Next capture calls ensureSessionId()
    ↓
resolveSessionId(platform, href, legacyChecker)
    ↓
Creates urlKey = `${platform}::${hostname}${pathname}${search}`
    ↓
Looks up urlKey in chrome.storage.local URL map
    ├─ If found → returns existing sessionId (deduplication)
    └─ If not found → mints NEW random sessionId → stores in map
    ↓
Returns sessionId to content script
    ↓
Content script sends CAPTURE_SESSION with sessionId + messages
    ↓
Service worker saves to IndexedDB with sessionId as key
    ↓
Each sessionId → one independent ContextSession record
```

### URL Key Generation
The URL key is generated from the full URL including query parameters:

```typescript
urlKey = `${platform}::${hostname}${pathname}${search}`
```

Examples:
- **Claude**: `claude::claude.ai/chat/abc123` → unique per conversation
- **ChatGPT**: `chatgpt::chatgpt.com/c/xyz789` → unique per conversation
- **Gemini**: `gemini::gemini.google.com/app/def456` → unique per conversation
- **Grok**: `grok::grok.com/share/ghi789` → unique per conversation
- **DeepSeek**: `deepseek::chat.deepseek.com/chat/jkl012` → unique per conversation
- **Perplexity**: `perplexity::www.perplexity.ai/search?q=what+is+ai` → unique per query

## Verification Steps

### Step 1: Open Browser DevTools Console
1. Open any LLM website (Claude, ChatGPT, Gemini, Grok, DeepSeek, or Perplexity)
2. Press `F12` to open DevTools
3. Go to **Console** tab
4. Keep console open while testing

### Step 2: Start a New Conversation
1. Create a new conversation on the LLM
2. Look for logs like:
```
[CM:session-id] platform: URL key "platform::hostname/path?query" → NEW sessionId=platform-abc123def45
[CM:session-id] platform: Saved mapping: "platform::hostname/path?query" → "platform-abc123def45"
[ContextMover] platform: resolved sessionId=platform-abc123def45 for URL=https://...
[CM:sw] CAPTURE_SESSION queued: sessionId=platform-abc123def45 platform=platform messages=2 title="..."
[CM:sw] SAVED to IndexedDB {sessionId: 'platform-abc123def45', platform: 'platform', messages: 2, title: '...'}
```

### Step 3: Switch to a Different Conversation
1. Navigate to a different conversation on the same LLM
2. The URL should change (different conversation ID or query)
3. Look for logs showing a **NEW sessionId**:
```
[CM:session-id] platform: URL key "platform::hostname/path?different-query" → NEW sessionId=platform-xyz789abc12
[ContextMover] URL changed — re-resolving sessionId
[ContextMover] platform: resolved sessionId=platform-xyz789abc12 for URL=https://...
[CM:sw] CAPTURE_SESSION queued: sessionId=platform-xyz789abc12 platform=platform messages=3 title="..."
[CM:sw] SAVED to IndexedDB {sessionId: 'platform-xyz789abc12', platform: 'platform', messages: 3, title: '...'}
```

### Step 4: Revisit the First Conversation
1. Go back to the first conversation
2. The URL should match the original
3. Look for logs showing **existing sessionId** (deduplication):
```
[CM:session-id] platform: URL key "platform::hostname/path?query" → existing sessionId=platform-abc123def45
[ContextMover] platform: using cached sessionId=platform-abc123def45
```

### Step 5: Check Sidebar
1. Open the ContextMover sidebar (click extension icon)
2. You should see **all conversations you visited**, each with:
   - Unique sessionId
   - Unique title
   - All messages preserved
   - Correct message count

## Expected Behavior

### ✅ Correct Behavior
- **4 conversations visited** → **4 unique entries in sidebar**
- Each entry has a different sessionId
- Each entry has all its messages preserved
- Revisiting a conversation shows the same sessionId (no duplicates)
- Message counts are accurate

### ❌ Incorrect Behavior (Bug Indicators)
- **4 conversations visited** → **Only 2 entries in sidebar** (merged sessions)
- Same sessionId for different conversations
- Missing messages in some sessions
- Sidebar shows only "newest" session
- Logs show "keeping sessionId (had messages)" instead of "re-resolving sessionId"

## Debugging Checklist

### If Sessions Are Merging:
1. **Check URL change detection:**
   - Look for `[ContextMover] URL changed — re-resolving sessionId` logs
   - If missing → URL detection is broken
   - If present → URL detection is working

2. **Check URL key generation:**
   - Look for `[CM:session-id] platform: URL key "..."` logs
   - Verify the URL key is **different** for each conversation
   - If URL keys are the same → conversations have identical URLs (impossible)

3. **Check sessionId minting:**
   - Look for `[CM:session-id] platform: ... → NEW sessionId=...` logs
   - Verify each new conversation gets a **different** sessionId
   - If sessionIds are the same → random minting is broken

4. **Check data saving:**
   - Look for `[CM:sw] SAVED to IndexedDB` logs
   - Verify each sessionId has correct message count
   - If message counts are wrong → capture pipeline is broken

### If Sidebar Shows Duplicates:
1. Check if sessionIds are actually different
2. If sessionIds are the same → session ID detection is broken
3. If sessionIds are different → sidebar deduplication logic is broken

## Platform-Specific Notes

### Perplexity
- URLs use query parameters: `www.perplexity.ai/search?q=...`
- Each unique query should get a unique sessionId
- The `?q=` parameter is included in the URL key, so different queries = different keys

### Claude
- URLs use path IDs: `claude.ai/chat/{id}`
- Each conversation has a unique {id}
- URL key will be unique per conversation

### ChatGPT
- URLs use path IDs: `chatgpt.com/c/{id}`
- Each conversation has a unique {id}
- URL key will be unique per conversation

### Gemini
- URLs use path IDs: `gemini.google.com/app/{id}`
- Each conversation has a unique {id}
- URL key will be unique per conversation

### Grok
- URLs use path IDs: `grok.com/share/{id}` or `grok.x.ai/chat/{id}`
- Each conversation has a unique {id}
- URL key will be unique per conversation

### DeepSeek
- URLs use path IDs: `chat.deepseek.com/chat/{id}`
- Each conversation has a unique {id}
- URL key will be unique per conversation

## Log Format Reference

### Session ID Resolution Logs
```
[CM:session-id] {platform}: URL key "{key}" → existing sessionId={id}
[CM:session-id] {platform}: URL key "{key}" → NEW sessionId={id}
[CM:session-id] {platform}: URL key "{key}" → legacy sessionId={id}
[CM:session-id] {platform}: Saved mapping: "{key}" → "{id}"
```

### Content Script Logs
```
[ContextMover] {platform}: resolved sessionId={id} for URL={href}
[ContextMover] {platform}: using cached sessionId={id}
[ContextMover] URL changed — re-resolving sessionId
[ContextMover] Sending CAPTURE_SESSION for session: {id}
```

### Service Worker Logs
```
[CM:sw] CAPTURE_SESSION queued: sessionId={id} platform={platform} messages={count} title="{title}"
[CM:sw] SAVED to IndexedDB {sessionId: '{id}', platform: '{platform}', messages: {count}, title: '{title}'}
```

## Troubleshooting Commands

### Check URL Map in Chrome Storage
Open DevTools Console and run:
```javascript
chrome.storage.local.get('cf:urlMap', (result) => {
  console.log('URL Map:', result['cf:urlMap']);
});
```

### Check IndexedDB Sessions
1. Open DevTools
2. Go to **Application** tab
3. Expand **IndexedDB** → **contextmover**
4. Click **sessions** table
5. You should see one row per unique sessionId
6. Each row should have all its messages

### Monitor Session Captures in Real-Time
Open DevTools Console and filter for:
- `[CM:session-id]` - Session ID resolution
- `[ContextMover]` - Content script logs
- `[CM:sw]` - Service worker logs

## Success Criteria

✅ **All tests pass when:**
1. Each unique conversation URL gets a unique sessionId
2. Revisiting the same URL returns the same sessionId (no duplicates)
3. All messages are preserved for each sessionId
4. Sidebar displays all visited conversations
5. No sessions are merged or lost
6. Works consistently across all 6 LLMs
