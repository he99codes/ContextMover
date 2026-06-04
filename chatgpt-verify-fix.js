/**
 * ChatGPT Fetch Interceptor Verification
 * 
 * Run this AFTER the extension is reloaded with the fix.
 * Send a message to ChatGPT and watch for the fetch interceptor flag.
 */

console.clear();
console.log("========== CHATGPT FETCH INTERCEPTOR VERIFICATION ==========\n");
console.log("Instructions:");
console.log("1. This script is now running");
console.log("2. Send a message to ChatGPT");
console.log("3. Watch for the __contextForgeFetchCaptured flag to be set\n");

// Check if the flag exists and log it periodically
let checkCount = 0;
const checkInterval = setInterval(() => {
  checkCount++;
  const flag = window.__contextForgeFetchCaptured;
  
  if (flag) {
    console.log(`%c✅ FETCH INTERCEPTOR ACTIVE!`, 'color: green; font-weight: bold;');
    console.log(`   Count: ${flag.count} messages`);
    console.log(`   Age: ${Date.now() - flag.at}ms ago`);
    clearInterval(checkInterval);
  } else if (checkCount <= 20) {
    console.log(`⏳ Waiting for fetch capture... (${checkCount}s)`);
  } else {
    console.log(`❌ Fetch interceptor flag NOT set after 20 seconds`);
    console.log(`   This means the fetch interceptor is still not detecting ChatGPT API calls`);
    clearInterval(checkInterval);
  }
}, 1000);

// Also log any console messages from the extension
const originalLog = console.log;
console.log = function(...args) {
  const msg = args.join(' ');
  if (msg.includes('[CM:diag:chatgpt]') || msg.includes('[ContextMover:bridge]')) {
    originalLog.apply(console, ['%c' + msg, 'color: blue;', ...args.slice(1)]);
  } else {
    originalLog.apply(console, args);
  }
};
