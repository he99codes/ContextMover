"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Handles Google Drive OAuth callback for extension users on Brave / Web OAuth.
 */

import { useEffect, useState } from "react";

export default function ConnectDrivePage() {
  const [status, setStatus] = useState("Connecting Google Drive to ContextMover...");

  useEffect(() => {
    // Extract access_token from URL hash (#access_token=...)
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const accessToken = params.get("access_token");

    if (accessToken) {
      const payload = {
        type: "WEB_DRIVE_TOKEN_SYNC",
        token: accessToken,
      };

      // 1. Broadcast via postMessage for web-sync content script
      window.postMessage({ source: "CONTEXTMOVER_WEB", payload }, "*");

      // NOTE: Direct chrome.runtime.sendMessage is NOT available on web pages.
      // The token relay works via window.postMessage → web-sync.ts content script
      // → chrome.runtime.sendMessage (from content script context) → service worker.

      setStatus("Google Drive connected successfully! You can close this window.");
      setTimeout(() => {
        try { window.close(); } catch { /* ignored */ }
      }, 2500);
    } else {
      setStatus("No access token received. Please try connecting Google Drive again from the extension.");
    }
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0A0A0A] p-4 text-[#F5F5F5]">
      <div className="w-full max-w-sm rounded-[12px] border border-[#2A2A2A] bg-[#111111] p-6 text-center shadow-[0_0_40px_rgba(0,0,0,0.8)]">
        <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-[8px] bg-[#00FF88]">
          <span className="text-lg font-bold text-black">CM</span>
        </div>
        <h1 className="text-base font-semibold text-[#F5F5F5] mb-2">Google Drive Sync</h1>
        <p className="text-xs text-[#9B9B9B] leading-relaxed">{status}</p>
      </div>
    </div>
  );
}
