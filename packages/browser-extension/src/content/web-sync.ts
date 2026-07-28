/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Relays web session sync messages from contextmover.com to the extension service worker.
 */

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.source === "CONTEXTMOVER_WEB" && event.data?.payload) {
    console.log("[CM:web-sync] Relaying payload to extension background worker...", event.data.payload.type);
    chrome.runtime.sendMessage(event.data.payload, (res) => {
      void chrome.runtime.lastError;
      if (res?.ok) {
        console.log("[CM:web-sync] Extension sync successful!");
      }
    });
  }
});
