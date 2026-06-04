/**
 * Simple ChatGPT Fetch Interceptor Test
 * 
 * Run this in the console after reloading the extension.
 * Send a message to ChatGPT and check the results.
 */

console.log("=== CHATGPT FETCH INTERCEPTOR TEST ===\n");
console.log("Checking for fetch interceptor flag...\n");

// Simple check without overriding console.log
setTimeout(() => {
  const flag = window.__contextForgeFetchCaptured;
  if (flag) {
    console.log("✅ SUCCESS! Fetch interceptor is working!");
    console.log("   Messages captured:", flag.count);
    console.log("   Time:", new Date(flag.at).toLocaleTimeString());
  } else {
    console.log("⏳ Flag not set yet. Send a message to ChatGPT...");
  }
}, 2000);

// Check again after 5 seconds
setTimeout(() => {
  const flag = window.__contextForgeFetchCaptured;
  if (flag) {
    console.log("\n✅ FETCH INTERCEPTOR ACTIVE!");
    console.log("   Count:", flag.count);
  } else {
    console.log("\n❌ Still no flag. Fetch interceptor may not be detecting /ces/v1/t endpoint.");
  }
}, 5000);
