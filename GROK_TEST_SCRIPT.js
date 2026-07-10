/**
 * GROK SCRAPER TEST SCRIPT
 * 
 * Run this in the browser console on grok.com to test the scraper
 * Copy the entire script and paste it into the DevTools console
 */

console.log('========== GROK SCRAPER TEST SCRIPT ==========\n');

// ─────────────────────────────────────────────────────────────────────────
// 1. TEST SELECTORS
// ─────────────────────────────────────────────────────────────────────────

console.log('1️⃣  TESTING SELECTORS\n');

const selectors = {
  'data-testid="user-message"': '[data-testid="user-message"]',
  'data-testid="assistant-message"': '[data-testid="assistant-message"]',
  'message-bubble class': '[class*="message-bubble"]',
  'main root': 'main',
};

Object.entries(selectors).forEach(([name, sel]) => {
  const els = document.querySelectorAll(sel);
  const withText = [...els].filter(el => (el.textContent?.trim().length ?? 0) > 0);
  console.log(`✅ "${name}" → ${els.length} total, ${withText.length} with text`);
  if (withText.length > 0) {
    console.log(`   First element text: "${withText[0].textContent?.trim().slice(0, 80)}..."`);
  }
});

console.log('\n');

// ─────────────────────────────────────────────────────────────────────────
// 2. TEST MESSAGE EXTRACTION
// ─────────────────────────────────────────────────────────────────────────

console.log('2️⃣  TESTING MESSAGE EXTRACTION\n');

function extractContent(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  // Remove script/style tags
  clone.querySelectorAll('script, style').forEach(s => s.remove());
  // Get text content
  return clone.textContent?.trim() || '';
}

function testMessageExtraction() {
  const userEls = document.querySelectorAll('[data-testid="user-message"]');
  const assistantEls = document.querySelectorAll('[data-testid="assistant-message"]');
  
  console.log(`Found ${userEls.length} user messages:`);
  userEls.forEach((el, i) => {
    const content = extractContent(el);
    const preview = content.slice(0, 60);
    console.log(`  [${i}] "${preview}${content.length > 60 ? '...' : ''}"`);
  });
  
  console.log(`\nFound ${assistantEls.length} assistant messages:`);
  assistantEls.forEach((el, i) => {
    const content = extractContent(el);
    const preview = content.slice(0, 60);
    console.log(`  [${i}] "${preview}${content.length > 60 ? '...' : ''}"`);
  });
}

testMessageExtraction();

console.log('\n');

// ─────────────────────────────────────────────────────────────────────────
// 3. TEST MESSAGE-BUBBLE FALLBACK
// ─────────────────────────────────────────────────────────────────────────

console.log('3️⃣  TESTING MESSAGE-BUBBLE FALLBACK\n');

function testMessageBubbleFallback() {
  const bubbles = [...document.querySelectorAll('[class*="message-bubble"]')]
    .filter(el => (el.textContent?.trim().length ?? 0) > 30);
  
  console.log(`Found ${bubbles.length} message-bubble elements with >30 chars text\n`);
  
  const messages = {
    user: [],
    assistant: [],
    unknown: []
  };
  
  bubbles.forEach((el, i) => {
    const testid = el.getAttribute('data-testid') || '';
    const content = extractContent(el).slice(0, 60);
    
    if (testid.includes('user')) {
      messages.user.push({ el, testid, content });
      console.log(`  [${i}] USER (testid="${testid}"): "${content}..."`);
    } else if (testid.includes('assistant')) {
      messages.assistant.push({ el, testid, content });
      console.log(`  [${i}] ASSISTANT (testid="${testid}"): "${content}..."`);
    } else {
      messages.unknown.push({ el, testid, content });
      console.log(`  [${i}] UNKNOWN (testid="${testid}"): "${content}..."`);
    }
  });
  
  console.log(`\nSummary: ${messages.user.length} user, ${messages.assistant.length} assistant, ${messages.unknown.length} unknown`);
  return messages;
}

const messages = testMessageBubbleFallback();

console.log('\n');

// ─────────────────────────────────────────────────────────────────────────
// 4. TEST STREAMING DETECTION
// ─────────────────────────────────────────────────────────────────────────

console.log('4️⃣  TESTING STREAMING DETECTION\n');

function isStreaming(el) {
  return (
    el.getAttribute('data-streaming') === 'true' ||
    el.closest('[data-streaming="true"]') !== null ||
    el.closest('[class*="streaming"]') !== null ||
    el.closest('[class*="loading"]') !== null
  );
}

const allMessages = document.querySelectorAll('[data-testid*="message"]');
const streamingCount = [...allMessages].filter(isStreaming).length;
const nonStreamingCount = allMessages.length - streamingCount;

console.log(`Total messages: ${allMessages.length}`);
console.log(`Streaming: ${streamingCount}`);
console.log(`Non-streaming: ${nonStreamingCount}`);

if (streamingCount > 0) {
  console.log('\n⚠️  WARNING: Some messages are still streaming. Wait for them to complete.');
}

console.log('\n');

// ─────────────────────────────────────────────────────────────────────────
// 5. TEST ROOT CONTAINER
// ─────────────────────────────────────────────────────────────────────────

console.log('5️⃣  TESTING ROOT CONTAINER\n');

const mainEl = document.querySelector('main');
if (mainEl) {
  const messageCount = mainEl.querySelectorAll('[data-testid*="message"]').length;
  console.log(`✅ <main> found`);
  console.log(`   Contains ${messageCount} message elements`);
  console.log(`   Class: "${mainEl.className.slice(0, 80)}..."`);
} else {
  console.log(`❌ <main> NOT found`);
}

console.log('\n');

// ─────────────────────────────────────────────────────────────────────────
// 6. SIMULATE FULL SCRAPE
// ─────────────────────────────────────────────────────────────────────────

console.log('6️⃣  SIMULATING FULL SCRAPE\n');

function simulateScrape() {
  const found = [];
  
  // Strategy 1: data-testid
  const userEls = document.querySelectorAll('[data-testid="user-message"]');
  const assistantEls = document.querySelectorAll('[data-testid="assistant-message"]');
  
  userEls.forEach(el => {
    if (!isStreaming(el)) {
      found.push({ el, role: 'user' });
    }
  });
  
  assistantEls.forEach(el => {
    if (!isStreaming(el)) {
      found.push({ el, role: 'assistant' });
    }
  });
  
  // Convert to messages
  const messages = found.map(({ el, role }) => ({
    role,
    content: extractContent(el),
    timestamp: Date.now()
  })).filter(m => m.content.trim().length > 0);
  
  // Sort by document order
  found.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
  
  return messages;
}

const scrapedMessages = simulateScrape();
console.log(`✅ Scraped ${scrapedMessages.length} messages\n`);

scrapedMessages.forEach((msg, i) => {
  const preview = msg.content.slice(0, 70);
  console.log(`[${i}] ${msg.role.toUpperCase()}: "${preview}${msg.content.length > 70 ? '...' : ''}"`);
});

console.log('\n');

// ─────────────────────────────────────────────────────────────────────────
// 7. FINAL REPORT
// ─────────────────────────────────────────────────────────────────────────

console.log('7️⃣  FINAL REPORT\n');

const userCount = scrapedMessages.filter(m => m.role === 'user').length;
const assistantCount = scrapedMessages.filter(m => m.role === 'assistant').length;

console.log(`Total messages: ${scrapedMessages.length}`);
console.log(`User messages: ${userCount}`);
console.log(`Assistant messages: ${assistantCount}`);
console.log(`Balance: ${userCount > 0 && assistantCount > 0 ? '✅ GOOD' : '❌ IMBALANCED'}`);

if (scrapedMessages.length === 0) {
  console.log('\n❌ NO MESSAGES FOUND - Check:');
  console.log('   1. Are you on a Grok conversation page?');
  console.log('   2. Does the page have any messages visible?');
  console.log('   3. Are messages still streaming? Wait for them to complete.');
} else if (userCount === 0 || assistantCount === 0) {
  console.log('\n⚠️  IMBALANCED - Only one role found');
  console.log('   Check if selectors are matching correctly');
} else {
  console.log('\n✅ SUCCESS - Scraper should work!');
}

console.log('\n========== END TEST SCRIPT ==========\n');

// ─────────────────────────────────────────────────────────────────────────
// HELPER: Export data for debugging
// ─────────────────────────────────────────────────────────────────────────

window.grokTestData = {
  scrapedMessages,
  userCount,
  assistantCount,
  messageElements: {
    user: document.querySelectorAll('[data-testid="user-message"]').length,
    assistant: document.querySelectorAll('[data-testid="assistant-message"]').length,
  },
  extractContent,
  isStreaming,
};

console.log('💾 Test data saved to window.grokTestData');
console.log('   Access with: window.grokTestData');
