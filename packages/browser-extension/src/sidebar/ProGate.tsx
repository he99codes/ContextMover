/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/sidebar/ProGate.tsx
//
// Subscription gate for Pro-only features in the extension sidebar.
//
// On mount it sends GET_SUBSCRIPTION_STATUS to the Service Worker.
// SW response shapes (all handled gracefully):
//   { isPro: boolean, plan, usage, limits, status }  — authenticated user
//   { plan: 'free', local: true }                    — not logged in
//   { plan: 'free', error: true }                    — API unreachable
//   null / undefined                                 — SW sleeping / no response
//
// In every non-Pro case isPro defaults to false and the upsell wall is shown.

import { useEffect, useState, type ReactNode } from "react";
import { PRICING_URL } from "../config/urls";

interface SwSubscriptionResponse {
  isPro?:  boolean;
  plan?:   string;
  local?:  boolean;
  error?:  boolean;
}

interface ProGateProps {
  children: ReactNode;
}

export default function ProGate({ children }: ProGateProps) {
  const [isPro,      setIsPro]      = useState<boolean | null>(null);
  const [isLoading,  setIsLoading]  = useState(true);

  useEffect(() => {
    chrome.runtime.sendMessage(
      { type: "GET_SUBSCRIPTION_STATUS" },
      (response: SwSubscriptionResponse | null | undefined) => {
        // Consume lastError so Chrome does not log "Could not establish
        // connection" when the service worker is temporarily inactive.
        void chrome.runtime.lastError;
        setIsPro(Boolean(response?.isPro));
        setIsLoading(false);
      }
    );
  }, []);

  // ── Loading skeleton ───────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-5 animate-pulse">
        <div className="h-3.5 w-2/3 rounded-[4px] bg-[#1A1A1A]" />
        <div className="h-3.5 w-full  rounded-[4px] bg-[#1A1A1A]" />
        <div className="h-3.5 w-4/5  rounded-[4px] bg-[#1A1A1A]" />
        <div className="mt-2 h-8 w-full rounded-[4px] bg-[#1A1A1A]" />
      </div>
    );
  }

  // ── Pro — render children transparently ───────────────────────────────────
  if (isPro) {
    return <>{children}</>;
  }

  // ── Free / logged-out — upsell wall ───────────────────────────────────────
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-5 py-10 text-center">

      {/* Lock icon container */}
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-[10px] border border-[#2A2A2A] bg-[#111111]">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#6B6B6B"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>

      {/* Tier badge */}
      <span className="mb-3 inline-block rounded-full border border-[#2A2A2A] bg-[#111111] px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-[#6B6B6B]">
        Pro Feature
      </span>

      {/* Title */}
      <h2 className="mb-2 text-[13px] font-black uppercase tracking-[0.1em] text-[#F5F5F5]">
        ContextMover Pro Required
      </h2>

      {/* Description */}
      <p className="mb-6 max-w-[240px] text-[11px] leading-relaxed text-[#6B6B6B]">
        Upgrade to Pro to unlock the Knowledge Synthesizer. Search and instantly
        assemble context across all of your past sessions.
      </p>

      {/* CTA */}
      <button
        onClick={() => window.open(PRICING_URL, "_blank")}
        className="w-full max-w-[220px] rounded-[4px] bg-[#00FF88] py-2.5 text-[11px] font-black uppercase tracking-[0.12em] text-[#0A0A0A] transition-opacity hover:opacity-90"
        style={{ boxShadow: "0 0 20px rgba(0,255,136,0.25)" }}
      >
        Upgrade to Pro
      </button>

      {/* Trust line */}
      <p className="mt-4 text-[9px] text-[#3A3A3A]">
        7-day refund policy · No questions asked
      </p>

    </div>
  );
}
