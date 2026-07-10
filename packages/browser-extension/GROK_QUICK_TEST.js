// ============================================================================
// GROK QUICK TEST - Copy & Paste into Console
// ============================================================================
// Just paste this entire script into the browser console on grok.com
// ============================================================================

console.clear();
console.log('%c🧪 GROK SCRAPER QUICK TEST', 'font-size:16px;font-weight:bold;color:#00ff00');

// Test 1: Selectors
console.log('\n%c1️⃣  SELECTORS', 'font-weight:bold');
const user = document.querySelectorAll('[data-testid="user-message"]').length;
const asst = document.querySelectorAll('[data-testid="assistant-message"]').length;
const bubble = document.querySelectorAll('[class*="message-bubble"]').length;
const main = document.querySelector('main') ? '✅' : '❌';
console.log(`User messages: ${user}`);
console.log(`Assistant messages: ${asst}`);
console.log(`Message bubbles: ${bubble}`);
console.log(`Main container: ${main}`);

// Test 2: Streaming
console.log('\n%c2️⃣  STREAMING CHECK', 'font-weight:bold');
const streaming = [...document.querySelectorAll('[data-testid*="message"]')]
  .filter(el => el.getAttribute('data-streaming') === 'true').length;
console.log(`Streaming messages: ${streaming}`);
if (streaming > 0) console.warn('⚠️  Wait for messages to finish!');

// Test 3: Extract content
console.log('\n%c3️⃣  CONTENT EXTRACTION', 'font-weight:bold');
function extract(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('script, style').forEach(s => s.remove());
  return clone.textContent?.trim() || '';
}
const userEl = document.querySelector('[data-testid="user-message"]');
const asstEl = document.querySelector('[data-testid="assistant-message"]');
if (userEl) console.log(`User: "${extract(userEl).slice(0, 60)}..."`);
if (asstEl) console.log(`Assistant: "${extract(asstEl).slice(0, 60)}..."`);

// Test 4: Summary
console.log('\n%c4️⃣  SUMMARY', 'font-weight:bold');
const total = user + asst;
if (total === 0) {
  console.error('❌ NO MESSAGES FOUND');
  console.log('Check: Are you on a Grok conversation page?');
} else if (user === 0 || asst === 0) {
  console.warn('⚠️  IMBALANCED - Only one role found');
} else {
  console.log(`%c✅ SUCCESS: ${total} messages (${user} user, ${asst} assistant)`, 'color:#00ff00;font-weight:bold');
}

console.log('\n%cFor full test, run: GROK_TEST_SCRIPT.js', 'color:#888;font-style:italic');
