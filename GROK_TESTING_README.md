# Grok Scraper Testing - Complete Guide

## 📋 Files Created

| File | Purpose | Size |
|------|---------|------|
| `GROK_QUICK_TEST.js` | 30-second quick test | ~1KB |
| `GROK_TEST_SCRIPT.js` | Full comprehensive test | ~8KB |
| `GROK_TEST_GUIDE.md` | Detailed test guide | ~6KB |
| `GROK_TESTING_SUMMARY.md` | Testing summary & checklist | ~8KB |

## 🚀 Quick Start (30 seconds)

### Option 1: Super Quick (10 seconds)
```javascript
// Just run this in console:
console.log('User:', document.querySelectorAll('[data-testid="user-message"]').length);
console.log('Assistant:', document.querySelectorAll('[data-testid="assistant-message"]').length);
```

### Option 2: Quick Test (30 seconds)
1. Go to https://grok.com with active conversation
2. Press `F12` to open DevTools
3. Go to **Console** tab
4. Copy entire `GROK_QUICK_TEST.js`
5. Paste and press Enter
6. Check the output

### Option 3: Full Test (2 minutes)
1. Go to https://grok.com with active conversation
2. Press `F12` to open DevTools
3. Go to **Console** tab
4. Copy entire `GROK_TEST_SCRIPT.js`
5. Paste and press Enter
6. Review all 7 test sections
7. Check final report

## 📊 What Each Test Does

### GROK_QUICK_TEST.js
**Time:** 10 seconds  
**Tests:**
- ✅ Selector count (user, assistant, bubbles, main)
- ✅ Streaming detection
- ✅ Content extraction
- ✅ Quick summary

**Output:** 4 lines showing counts and status

### GROK_TEST_SCRIPT.js
**Time:** 2 minutes  
**Tests:**
1. Selector Testing - All CSS selectors
2. Message Extraction - Content from each message
3. Message-Bubble Fallback - Fallback strategy
4. Streaming Detection - Incomplete messages
5. Root Container - Main element check
6. Full Scrape Simulation - Actual scraper simulation
7. Final Report - Pass/fail summary

**Output:** Detailed report with 7 sections

## ✅ Expected Results

### Good Results
```
✅ User messages: 14
✅ Assistant messages: 14
✅ Message bubbles: 28
✅ Main container: ✅
✅ Streaming: 0
✅ SUCCESS - Scraper should work!
```

### Bad Results
```
❌ User messages: 0
❌ Assistant messages: 0
❌ NO MESSAGES FOUND
```

## 🔍 Troubleshooting

### Problem: "NO MESSAGES FOUND"
**Solutions:**
1. Are you on a Grok conversation page? (URL contains `/c/`)
2. Does the page have visible messages?
3. Are messages still streaming? (Wait for them to complete)
4. Try scrolling up to load older messages

### Problem: "IMBALANCED - Only one role found"
**Solutions:**
1. Wait for assistant to finish responding
2. Check if messages are still streaming
3. Verify selectors are matching (run selector test)

### Problem: Selectors return 0
**Solutions:**
1. Check if you're on the right page
2. Verify the DOM structure hasn't changed
3. Try the message-bubble fallback selector
4. Report the issue with DOM structure

## 🎯 Testing Workflow

### Before Testing
- [ ] Open grok.com
- [ ] Start a conversation or open existing one
- [ ] Wait for all messages to finish loading
- [ ] Wait for any streaming messages to complete

### During Testing
- [ ] Copy the test script
- [ ] Paste into console
- [ ] Press Enter
- [ ] Wait for results
- [ ] Review the output

### After Testing
- [ ] If ✅ SUCCESS: Reload extension and test on Grok
- [ ] If ❌ FAILED: Note the error and check troubleshooting

## 📝 Console Commands

After running the test, you can access test data:

```javascript
// View all scraped messages
window.grokTestData.scrapedMessages

// Check counts
window.grokTestData.userCount
window.grokTestData.assistantCount

// Test extraction on specific element
const el = document.querySelector('[data-testid="user-message"]');
window.grokTestData.extractContent(el);

// Check if streaming
const el = document.querySelector('[data-testid="assistant-message"]');
window.grokTestData.isStreaming(el);
```

## 🛠️ Manual Selector Testing

If you want to test selectors individually:

```javascript
// Test user message selector
document.querySelectorAll('[data-testid="user-message"]')
// Should return NodeList with elements

// Test assistant message selector
document.querySelectorAll('[data-testid="assistant-message"]')
// Should return NodeList with elements

// Test message-bubble fallback
document.querySelectorAll('[class*="message-bubble"]')
// Should return NodeList with 2x the message count

// Test main container
document.querySelector('main')
// Should return <main> element
```

## 📱 DOM Structure

Expected Grok DOM:
```html
<main class="h-full flex-grow flex-shrink relative...">
  <div data-testid="user-message" class="message-bubble...">
    User message text
  </div>
  <div data-testid="assistant-message" class="message-bubble...">
    Assistant response
  </div>
  <!-- More messages... -->
</main>
```

## 🎓 Learning Resources

- `GROK_TEST_GUIDE.md` - Detailed explanation of each test
- `GROK_TESTING_SUMMARY.md` - Complete testing checklist
- `GROK_TEST_SCRIPT.js` - Full test implementation

## ⚡ Quick Reference

| Task | Command |
|------|---------|
| Quick test | Copy `GROK_QUICK_TEST.js` to console |
| Full test | Copy `GROK_TEST_SCRIPT.js` to console |
| Check users | `document.querySelectorAll('[data-testid="user-message"]').length` |
| Check assistants | `document.querySelectorAll('[data-testid="assistant-message"]').length` |
| Check streaming | `[...document.querySelectorAll('[data-testid*="message"]')].filter(el => el.getAttribute('data-streaming') === 'true').length` |
| View test data | `window.grokTestData` |

## 🚨 Important Notes

1. **Non-destructive** - Tests only read DOM, don't modify anything
2. **Safe to run** - Can run multiple times without issues
3. **Streaming matters** - Wait for messages to finish before testing
4. **DOM changes** - If Grok updates DOM, selectors might need updating
5. **Test data persists** - `window.grokTestData` available after test

## 📞 Support

If tests fail:
1. Save the console output
2. Note which test section failed
3. Check if Grok DOM structure has changed
4. Report with test output and console logs

## 🎉 Success Indicators

✅ **You're good to go if:**
- Quick test shows user > 0 and assistant > 0
- Full test shows "SUCCESS" in final report
- No streaming messages detected
- Message counts are balanced

❌ **Something's wrong if:**
- Selectors return 0 elements
- Only one role found (imbalanced)
- Streaming messages detected and not waiting
- Final report shows errors

---

**Created:** June 4, 2026  
**For:** Grok Scraper Testing  
**Status:** Ready to use
