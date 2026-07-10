# Grok Scraper Testing Summary

## Files Created

### 1. `GROK_TEST_SCRIPT.js`
Complete console test script with 7 test sections:
1. Selector Testing - Verify CSS selectors find elements
2. Message Extraction - Test content extraction
3. Message-Bubble Fallback - Test fallback strategy
4. Streaming Detection - Check for incomplete messages
5. Root Container - Verify main element exists
6. Full Scrape Simulation - Simulate actual scraper
7. Final Report - Summary with pass/fail status

**How to use:**
```
1. Open grok.com with active conversation
2. Press F12 to open DevTools
3. Go to Console tab
4. Copy entire GROK_TEST_SCRIPT.js
5. Paste into console
6. Press Enter
```

### 2. `GROK_TEST_GUIDE.md`
Detailed guide explaining:
- What each test does
- Expected output for each test
- Troubleshooting guide
- Debug commands
- Next steps based on results

## Quick Test Checklist

Run this in console to quickly verify:

```javascript
// 1. Check user messages
document.querySelectorAll('[data-testid="user-message"]').length

// 2. Check assistant messages
document.querySelectorAll('[data-testid="assistant-message"]').length

// 3. Check message-bubble fallback
document.querySelectorAll('[class*="message-bubble"]').length

// 4. Check main container
document.querySelector('main') ? '✅ Found' : '❌ Not found'
```

**Expected results:**
- User messages: 14+ (or however many in conversation)
- Assistant messages: 14+ (or however many in conversation)
- Message-bubble: 28+ (double the message count)
- Main container: ✅ Found

## Test Scenarios

### Scenario 1: Fresh Conversation
**Setup:** Open Grok, start new conversation, send 1 message, wait for response

**Expected:**
- 1 user message
- 1 assistant message
- All selectors working
- No streaming messages

### Scenario 2: Long Conversation
**Setup:** Open Grok with existing conversation (10+ messages)

**Expected:**
- 10+ user messages
- 10+ assistant messages
- All selectors working
- Balanced message count

### Scenario 3: Streaming Message
**Setup:** Send message to Grok, run test while assistant is responding

**Expected:**
- Streaming: 1 (the assistant response being generated)
- Non-streaming: N-1
- Script should warn about streaming messages

### Scenario 4: Empty Conversation
**Setup:** Open Grok, don't send any messages

**Expected:**
- 0 user messages
- 0 assistant messages
- Script should report "NO MESSAGES FOUND"

## Success Criteria

✅ **Test passes if:**
1. Selectors find elements (user + assistant > 0)
2. Message extraction shows full text
3. No streaming messages (or user waits for them)
4. User and assistant counts are balanced
5. Final report shows "SUCCESS"

❌ **Test fails if:**
1. Selectors find 0 elements
2. Message extraction is empty
3. Only one role found (imbalanced)
4. Streaming messages detected (user needs to wait)
5. Final report shows errors

## What to Do After Testing

### If test shows ✅ SUCCESS:
1. Reload the extension (chrome://extensions)
2. Go back to grok.com
3. Open a new conversation or refresh the page
4. Check the sidebar - new session should appear with all messages

### If test shows ❌ ERRORS:
1. Note the specific error from the test output
2. Check which selector is failing
3. Run individual selector tests:
   ```javascript
   document.querySelectorAll('[data-testid="user-message"]')
   document.querySelectorAll('[data-testid="assistant-message"]')
   document.querySelectorAll('[class*="message-bubble"]')
   ```
4. Report the issue with the test output

## Debugging Tips

### Check if selectors are working:
```javascript
// Should return array of elements
document.querySelectorAll('[data-testid="user-message"]')

// Should return > 0
document.querySelectorAll('[data-testid="user-message"]').length

// Check first element's text
document.querySelector('[data-testid="user-message"]').textContent
```

### Check if streaming is blocking:
```javascript
// Should return 0 if no messages are streaming
[...document.querySelectorAll('[data-testid*="message"]')]
  .filter(el => el.getAttribute('data-streaming') === 'true').length
```

### Check root container:
```javascript
// Should return <main> element
document.querySelector('main')

// Check how many messages it contains
document.querySelector('main').querySelectorAll('[data-testid*="message"]').length
```

## Expected DOM Structure

```html
<main class="h-full flex-grow flex-shrink relative selection:bg-highlight w-0 @container isol">
  <!-- Message 1: User -->
  <div class="message-bubble relative rounded-3xl text-primary min-h-7 prose dark:prose-invert" 
       data-testid="user-message">
    User message text...
  </div>
  
  <!-- Message 2: Assistant -->
  <div class="message-bubble relative rounded-3xl text-primary min-h-7 prose dark:prose-invert" 
       data-testid="assistant-message">
    Assistant response...
  </div>
  
  <!-- More messages... -->
</main>
```

## Selector Reference

| Selector | Purpose | Expected Count |
|----------|---------|-----------------|
| `[data-testid="user-message"]` | User messages (Strategy 1) | N (number of user messages) |
| `[data-testid="assistant-message"]` | Assistant messages (Strategy 1) | N (number of assistant messages) |
| `[class*="message-bubble"]` | All messages (Strategy 5 fallback) | 2N (double count) |
| `main` | Root container | 1 |

## Notes

- The test script is **non-destructive** - it only reads DOM, doesn't modify anything
- Test data is saved to `window.grokTestData` for further debugging
- The script handles both old and new Grok DOM structures
- Streaming detection prevents capturing incomplete messages
- Message-bubble fallback provides robustness if data-testid changes

## Contact

If tests fail consistently:
1. Save the console output
2. Note which test section failed
3. Check if Grok DOM structure has changed
4. Report with the test output and console logs
