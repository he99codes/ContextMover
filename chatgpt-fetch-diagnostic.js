/**
 * ChatGPT Fetch URL Diagnostic
 * 
 * Run this BEFORE sending a message to ChatGPT.
 * Then send a message and watch the console for fetch URLs.
 * 
 * This will show us exactly what URLs ChatGPT is calling,
 * so we can fix the detectPlatform() function.
 */

console.clear();
console.log("========== CHATGPT FETCH URL DIAGNOSTIC ==========\n");
console.log("Instructions:");
console.log("1. This script is now running");
console.log("2. Send a message to ChatGPT");
console.log("3. Watch the console for 'FETCH URL:' logs");
console.log("4. Copy the URL and share it with the developer\n");

// Hook into fetch to log all URLs
const originalFetch = window.fetch;
let fetchCount = 0;

window.fetch = function(...args) {
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0]);
  fetchCount++;
  
  // Log ALL fetches, but highlight ChatGPT ones
  if (url.includes('chatgpt.com') || url.includes('chat.openai.com') || url.includes('openai')) {
    console.log(`%c[FETCH #${fetchCount}] CHATGPT URL:`, 'color: red; font-weight: bold;', url);
  } else if (url.includes('api') || url.includes('backend')) {
    console.log(`%c[FETCH #${fetchCount}] API URL:`, 'color: orange;', url);
  }
  
  return originalFetch.apply(this, args);
};

console.log("✅ Fetch hook installed. Send a message now...\n");
