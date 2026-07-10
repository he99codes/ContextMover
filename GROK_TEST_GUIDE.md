# Grok Scraper Test Guide

## Quick Start

1. **Open Grok conversation** on https://grok.com with an active chat
2. **Open DevTools** (F12 or Cmd+Option+I)
3. **Go to Console tab**
4. **Copy the entire script** from `GROK_TEST_SCRIPT.js`
5. **Paste into console** and press Enter

## What the Script Tests

### 1️⃣ Selector Testing
Tests if the CSS selectors find elements:
- `[data-testid="user-message"]` - Should find user messages
- `[data-testid="assistant-message"]` - Should find assistant messages
- `[class*="message-bubble"]` - Fallback selector
- `main` - Root container

**Expected Output:**
```
✅ "data-testid="user-message"" → 14 total, 14 with text
✅ "data-testid="assistant-message"" → 14 total, 14 with text
```

### 2️⃣ Message Extraction
Tests if content is extracted correctly from message elements.

**Expected Output:**
```
Found 14 user messages:
  [0] "contextmover.com look at this web"
  [1] "what is the capital of france"
  ...

Found 14 assistant messages:
  [0] "Got it! I checked out contextmover.com. Quick Summary: ContextMover is a Chrome extens..."
  ...
```

### 3️⃣ Message-Bubble Fallback
Tests the fallback strategy using `[class*="message-bubble"]` selector.

**Expected Output:**
```
Found 28 message-bubble elements with >30 chars text

  [0] USER (testid="user-message"): "contextmover.com look at this web..."
  [1] ASSISTANT (testid="assistant-message"): "Got it! I checked out contextmover.com..."
  ...

Summary: 14 user, 14 assistant, 0 unknown
```

### 4️⃣ Streaming Detection
Checks if any messages are still being generated (streaming).

**Expected Output:**
```
Total messages: 28
Streaming: 0
Non-streaming: 28
```

**If you see `Streaming: > 0`:**
- ⚠️ Wait for messages to finish generating
- Streaming messages are skipped by the scraper

### 5️⃣ Root Container
Tests if the `<main>` element exists and contains messages.

**Expected Output:**
```
✅ <main> found
   Contains 28 message elements
   Class: "h-full flex-grow flex-shrink relative selection:bg-highlight w-0 @container isol..."
```

### 6️⃣ Full Scrape Simulation
Simulates the actual scraper to see what messages would be captured.

**Expected Output:**
```
✅ Scraped 28 messages

[0] USER: "contextmover.com look at this web"
[1] ASSISTANT: "Got it! I checked out contextmover.com. Quick Summary: ContextMover is a Chrome..."
[2] USER: "what is the capital of france"
[3] ASSISTANT: "The capital of France is Paris..."
...
```

### 7️⃣ Final Report
Summary of what was found.

**Expected Output:**
```
Total messages: 28
User messages: 14
Assistant messages: 14
Balance: ✅ GOOD

✅ SUCCESS - Scraper should work!
```

## Troubleshooting

### ❌ "NO MESSAGES FOUND"

**Check:**
1. Are you on a Grok conversation page? (URL should contain `/c/`)
2. Does the page have visible messages?
3. Are messages still streaming? (Wait for them to complete)
4. Try scrolling up to load older messages

**If still no messages:**
- Run the selector test manually:
  ```javascript
  document.querySelectorAll('[data-testid="user-message"]').length
  ```
- If it returns 0, the selectors need updating

### ⚠️ "IMBALANCED - Only one role found"

**Possible causes:**
1. Only user messages visible (assistant still thinking)
2. Only assistant messages visible (user message not rendered)
3. Selectors not matching correctly

**Fix:**
- Wait for the assistant to finish responding
- Check the selector test output to see which role is missing

### 🔍 "UNKNOWN" messages in fallback test

If you see messages with `testid=""` or `testid="something-else"`:
- The message-bubble fallback found elements but couldn't identify the role
- This is OK - Strategy 1 should have caught them

## Debug Commands

After running the test script, you can access test data:

```javascript
// View all scraped messages
window.grokTestData.scrapedMessages

// Check message counts
window.grokTestData.userCount
window.grokTestData.assistantCount

// Check element counts
window.grokTestData.messageElements

// Test extraction on a specific element
const el = document.querySelector('[data-testid="user-message"]');
window.grokTestData.extractContent(el);

// Check if an element is streaming
const el = document.querySelector('[data-testid="assistant-message"]');
window.grokTestData.isStreaming(el);
```

## Expected Results

✅ **Good:**
- All selectors find elements
- Message extraction shows full text
- User and assistant counts are balanced
- No streaming messages
- Final report shows "SUCCESS"

❌ **Bad:**
- Selectors find 0 elements
- Message extraction is empty
- Only one role found
- Streaming messages detected
- Final report shows errors

## Next Steps

If the test shows **SUCCESS**:
1. Reload the extension
2. Go back to Grok
3. Open a new conversation or refresh
4. Check the sidebar - new session should appear

If the test shows **ERRORS**:
1. Note the specific error
2. Check the console output
3. Report the issue with the test output

## File Location

- Test script: `/home/vip/Desktop/ContextMover/GROK_TEST_SCRIPT.js`
- This guide: `/home/vip/Desktop/ContextMover/GROK_TEST_GUIDE.md`
