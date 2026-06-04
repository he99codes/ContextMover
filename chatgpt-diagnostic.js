/**
 * ChatGPT Diagnostic Script
 * 
 * Run this in the browser console on chat.openai.com or chatgpt.com
 * with an OPEN CONVERSATION containing 5+ messages.
 * 
 * Copy the entire script, paste into DevTools console, and press Enter.
 * The output will show:
 * 1. DOM probe results (selectors, message counts, roles)
 * 2. Fetch interceptor status (what it's capturing)
 * 3. Recommendations for fixes
 */

console.clear();
console.log("========== CONTEXTMOVER: CHATGPT DIAGNOSTIC ==========\n");

// ─────────────────────────────────────────────────────────────────────────────
// PART A: DOM PROBE — Test all possible message selectors
// ─────────────────────────────────────────────────────────────────────────────

console.log("PART A: DOM PROBE RESULTS\n");

const selectors = [
  '[data-message-author-role]',
  '[data-message-author-role="user"]',
  '[data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn"]',
  '[class*="message"]',
  '[class*="text-message"]',
  '[class*="agent-turn"]',
  '[class*="group"]',
  '[role="article"]',
  'main [role="region"]',
];

console.log("Testing selectors:\n");
selectors.forEach(sel => {
  const els = document.querySelectorAll(sel);
  if (els.length > 0) {
    const sample = els[0];
    const role = sample.getAttribute('data-message-author-role') || 'N/A';
    const testid = sample.getAttribute('data-testid') || 'N/A';
    const text = sample.textContent?.trim().slice(0, 60) || 'N/A';
    console.log(`✅ "${sel}" → ${els.length} elements`);
    console.log(`   [0] role="${role}" testid="${testid}"`);
    console.log(`   text: "${text}..."\n`);
  } else {
    console.log(`❌ "${sel}" → 0 elements\n`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PART B: Message extraction by role
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nPART B: MESSAGE EXTRACTION BY ROLE\n");

const userMsgs = document.querySelectorAll('[data-message-author-role="user"]');
const asstMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');

console.log(`User messages: ${userMsgs.length}`);
console.log(`Assistant messages: ${asstMsgs.length}`);
console.log(`Total: ${userMsgs.length + asstMsgs.length}\n`);

if (userMsgs.length > 0) {
  console.log("Sample USER message:");
  const u = userMsgs[0];
  console.log(`  data-message-id: ${u.getAttribute('data-message-id')}`);
  console.log(`  text: "${u.textContent?.trim().slice(0, 80)}..."\n`);
}

if (asstMsgs.length > 0) {
  console.log("Sample ASSISTANT message:");
  const a = asstMsgs[0];
  console.log(`  data-message-id: ${a.getAttribute('data-message-id')}`);
  console.log(`  data-message-model-slug: ${a.getAttribute('data-message-model-slug')}`);
  console.log(`  text: "${a.textContent?.trim().slice(0, 80)}..."\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART C: Virtual scroll detection
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nPART C: VIRTUAL SCROLL / CONTAINER DETECTION\n");

const containers = [
  { sel: '[class*="thread"]', name: 'thread container' },
  { sel: '[class*="overflow-y-auto"]', name: 'overflow-y-auto' },
  { sel: 'main', name: 'main element' },
  { sel: '[role="main"]', name: 'role=main' },
];

containers.forEach(({ sel, name }) => {
  const el = document.querySelector(sel);
  if (el) {
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const height = el.clientHeight;
    const scrollHeight = el.scrollHeight;
    console.log(`${name}:`);
    console.log(`  overflow-y: ${overflowY}`);
    console.log(`  height: ${height}px, scrollHeight: ${scrollHeight}px`);
    console.log(`  children: ${el.children.length}\n`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PART D: Fetch interceptor status
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nPART D: FETCH INTERCEPTOR STATUS\n");

const fetchStatus = window.__contextForgeFetchCaptured;
if (fetchStatus) {
  console.log(`✅ Fetch interceptor ACTIVE`);
  console.log(`   Last capture: ${fetchStatus.count} messages`);
  console.log(`   Age: ${Date.now() - fetchStatus.at}ms ago\n`);
} else {
  console.log(`⚠️  Fetch interceptor: No capture flag set yet\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART E: Check for streaming messages
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nPART E: STREAMING MESSAGE CHECK\n");

const streamingMsgs = document.querySelectorAll('[data-is-streaming="true"]');
console.log(`Streaming messages: ${streamingMsgs.length}`);
if (streamingMsgs.length > 0) {
  console.log(`⚠️  Assistant is currently generating — capture may be incomplete\n`);
} else {
  console.log(`✅ No streaming messages — conversation is stable\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART F: Simulate DOM scrape (what ContextMover would extract)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nPART F: SIMULATED DOM SCRAPE\n");

function simulateScrape() {
  const found = [];
  document.querySelectorAll('[data-message-author-role]').forEach(el => {
    const role = el.getAttribute('data-message-author-role');
    if (role !== 'user' && role !== 'assistant') return;
    if (el.getAttribute('data-is-streaming') === 'true') return;
    found.push({ el, role });
  });

  found.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );

  const msgs = found.map(({ el, role }) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button, svg, [aria-label*="Copy"], [aria-label*="Share"]').forEach(n => n.remove());
    const content = clone.textContent?.trim() || '';
    return { role, content: content.slice(0, 100), timestamp: Date.now() };
  }).filter(m => m.content.length > 0);

  return msgs;
}

const scraped = simulateScrape();
const userCount = scraped.filter(m => m.role === 'user').length;
const asstCount = scraped.filter(m => m.role === 'assistant').length;

console.log(`Scraped: ${scraped.length} total messages`);
console.log(`  User: ${userCount}`);
console.log(`  Assistant: ${asstCount}\n`);

if (scraped.length > 0) {
  console.log("Sample scraped message:");
  console.log(`  role: ${scraped[0].role}`);
  console.log(`  content: "${scraped[0].content}..."\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART G: Recommendations
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nPART G: RECOMMENDATIONS\n");

const issues = [];

if (userMsgs.length === 0 && asstMsgs.length === 0) {
  issues.push("❌ No messages found with [data-message-author-role] — selector may be broken");
}

if (userMsgs.length > 0 && asstMsgs.length === 0) {
  issues.push("⚠️  Found user messages but NO assistant messages — check if assistant response is still generating");
}

if (streamingMsgs.length > 0) {
  issues.push("⚠️  Some messages are marked as streaming — wait for generation to complete");
}

if (scraped.length === 0) {
  issues.push("❌ DOM scrape returned 0 messages — content extraction may be failing");
}

if (fetchStatus && fetchStatus.count > 0 && scraped.length === 0) {
  issues.push("⚠️  Fetch interceptor captured messages but DOM scrape failed — likely a selector issue");
}

if (issues.length === 0) {
  console.log("✅ All checks passed! DOM scrape should work correctly.");
} else {
  issues.forEach(issue => console.log(issue));
}

console.log("\n========== END DIAGNOSTIC ==========\n");

// ─────────────────────────────────────────────────────────────────────────────
// PART H: Export results for sharing
// ─────────────────────────────────────────────────────────────────────────────

console.log("EXPORT RESULTS (copy this for the developer):\n");
const results = {
  timestamp: new Date().toISOString(),
  url: window.location.href,
  userMessages: userMsgs.length,
  assistantMessages: asstMsgs.length,
  streamingMessages: streamingMsgs.length,
  scrapedMessages: scraped.length,
  scrapedUserCount: userCount,
  scrapedAssistantCount: asstCount,
  fetchInterceptorActive: !!fetchStatus,
  fetchInterceptorCount: fetchStatus?.count || 0,
  issues: issues,
};

console.log(JSON.stringify(results, null, 2));
console.log("\n✅ Diagnostic complete. Share the JSON above with the developer.");
