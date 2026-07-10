"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */
// packages/web/src/app/pricing/page.tsx
// Geo-aware pricing page driven by the v2 payment infrastructure.
// Handles Razorpay (modal) checkout flows,
// plus a mock-mode pathway when API keys are placeholders.

import { useEffect, useState } from "react";
import { useSubscription } from "@/hooks/useSubscription";
import { createClient } from "@/lib/supabase/client";
import { PricingClient } from "@/components/pricing/PricingClient";

// Force dynamic rendering - this page uses Supabase auth and client-side state
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';


export default function PricingPage() {
  const { isPro } = useSubscription();
  const supabase = createClient();
  const [mockNotice, setMockNotice] = useState<string | null>(null);

  // Clear mock-mode notice after a few seconds.
  useEffect(() => {
    if (!mockNotice) return;
    const t = setTimeout(() => setMockNotice(null), 6_000);
    return () => clearTimeout(t);
  }, [mockNotice]);


  async function activateMockPro() {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        window.location.href = "/login?redirect=/pricing";
        return;
      }
      const res = await fetch("/api/payments/mock-upgrade", {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ plan: "pro" }),
      });
      const data = await res.json();
      if (data.success) {
        setMockNotice("[DEV] Mock Pro activated — reloading…");
        setTimeout(() => window.location.reload(), 1_200);
      } else {
        setMockNotice(`Mock activation failed: ${data.error ?? "unknown"}`);
      }
    } catch (err) {
      console.error("Mock activate failed:", err);
      setMockNotice("Mock activation failed — see console.");
    }
  }

  const isDev = process.env.NODE_ENV !== "production";

  return (
    <div style={{ background: "#050505", minHeight: "100vh" }}>
      {/* Razorpay SDK is loaded globally in app/layout.tsx */}

      {mockNotice && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50">
          <div
            style={{
              padding:      "10px 14px",
              fontSize:     "11px",
              border:       "1px solid rgba(0,255,136,0.3)",
              background:   "rgba(0,255,136,0.05)",
              color:        "#00FF88",
              borderRadius: "6px",
            }}
          >
            {mockNotice}
          </div>
        </div>
      )}

      <PricingClient />

      {/* Dev-only mock upgrade — never shipped to production builds */}
      {isDev && !isPro && (
        <div style={{ textAlign: "center", paddingBottom: "32px" }}>
          <button
            onClick={activateMockPro}
            style={{
              padding:       "10px 18px",
              background:    "transparent",
              border:        "1px dashed #00FF88",
              borderRadius:  "6px",
              color:         "#00FF88",
              fontSize:      "11px",
              fontWeight:    700,
              cursor:        "pointer",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            [DEV] Activate Mock Pro
          </button>
          <div style={{ marginTop: "6px", fontSize: "10px", color: "#3A3A3A" }}>
            Skip checkout · flips your account to Pro in Supabase
          </div>
        </div>
      )}
    </div>
  );
}

