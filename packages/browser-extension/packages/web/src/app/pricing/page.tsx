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
import PricingSection from "@/components/pricing/PricingSection";


// Razorpay subscription-mode constructor (different option shape from the
// one-shot order constructor declared globally in `types/razorpay.d.ts`).
// We cast `window.Razorpay` to this loose shape at call site.
interface SubscriptionRazorpayCtor {
  new (options: Record<string, unknown>): { open: () => void };
}

export default function PricingPage() {
  const { isPro } = useSubscription();
  const supabase = createClient();
  const [, setCheckoutLoading] = useState<"pro" | null>(null);
  const [mockNotice, setMockNotice] = useState<string | null>(null);

  // Clear mock-mode notice after a few seconds.
  useEffect(() => {
    if (!mockNotice) return;
    const t = setTimeout(() => setMockNotice(null), 6_000);
    return () => clearTimeout(t);
  }, [mockNotice]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function handleUpgrade(planType: "pro") {
    setCheckoutLoading(planType);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        window.location.href = "/login?redirect=/pricing";
        return;
      }

      const res = await fetch("/api/payments/subscription", {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ plan: planType }),
      });

      const data = await res.json();

      if (data.mock) {
        setMockNotice(
          `[Mock mode] Would start ${data.gateway ?? "payment"} checkout for ${planType} · ${data.amount ?? ""}`
        );
        return;
      }

      if (data.url) {
        window.location.href = data.url;
      } else if (data.subscriptionId) {
        // Razorpay subscription modal.
        openRazorpayCheckout(data);
      } else if (data.orderId) {
        // Razorpay Standard Checkout (no subscription plan configured).
        openRazorpayOrderCheckout({ ...data, plan: planType });
      } else if (data.error) {
        setMockNotice(`Checkout error: ${data.error}`);
      }
    } catch (err) {
      console.error("Checkout failed:", err);
      setMockNotice("Checkout failed — please try again.");
    } finally {
      setCheckoutLoading(null);
    }
  }

  function openRazorpayCheckout(data: {
    keyId?:          string;
    subscriptionId?: string;
  }) {
    // The global `window.Razorpay` type in types/razorpay.d.ts is for one-shot
    // ORDER checkouts (requires amount/order_id). For SUBSCRIPTION checkouts
    // we use a different option shape, so we cast through unknown.
    const Ctor = (window as unknown as { Razorpay?: SubscriptionRazorpayCtor }).Razorpay;
    if (!Ctor) {
      setMockNotice("Razorpay SDK not loaded yet — refresh and try again.");
      return;
    }
    const options: Record<string, unknown> = {
      key:             data.keyId,
      subscription_id: data.subscriptionId,
      name:            "ContextMover",
      description:     "Pro Plan — Unlimited AI context migration",
      image:           "/icon128.png",
      theme:           { color: "#00FF88" },
      handler:         () => { window.location.href = "/settings?payment=success"; },
    };
    new Ctor(options).open();
  }

  function openRazorpayOrderCheckout(data: {
    keyId?:    string;
    orderId?:  string;
    amount?:   number;
    currency?: string;
    plan?:     string;
  }) {
    const Ctor = (window as unknown as { Razorpay?: SubscriptionRazorpayCtor }).Razorpay;
    if (!Ctor) {
      setMockNotice("Razorpay SDK not loaded yet — refresh and try again.");
      return;
    }
    const planLabel = (data.plan ?? "pro");
    const options: Record<string, unknown> = {
      key:         data.keyId,
      amount:      data.amount,
      currency:    data.currency ?? "INR",
      name:        "ContextMover",
      description: `${planLabel.charAt(0).toUpperCase() + planLabel.slice(1)} Plan — Unlimited AI context migration`,
      order_id:    data.orderId,
      image:       "/icon128.png",
      theme:       { color: "#00FF88" },
      modal: {
        ondismiss: () => setCheckoutLoading(null),
        confirm_close: true,
        escape: true,
        backdropclose: true,
      },
      "payment.failed": (response: { error: { description: string; code?: string } }) => {
        setMockNotice(`Payment failed: ${response.error.description}`);
        setCheckoutLoading(null);
      },
      handler: async (response: {
        razorpay_payment_id: string;
        razorpay_order_id:   string;
        razorpay_signature:  string;
      }) => {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          const verifyRes = await fetch("/api/payments/razorpay/verify", {
            method:  "POST",
            headers: {
              "Content-Type":  "application/json",
              ...(session ? { "Authorization": `Bearer ${session.access_token}` } : {}),
            },
            body: JSON.stringify({ ...response, plan: data.plan ?? "pro" }),
          });
          if (verifyRes.ok) {
            window.location.href = "/settings?payment=success";
          } else {
            const err = (await verifyRes.json()) as { error?: string };
            setMockNotice(`Payment verification failed: ${err.error ?? "unknown"}`);
          }
        } catch {
          setMockNotice("Payment verification failed — please contact support.");
        }
      },
    };
    new Ctor(options).open();
  }

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

      <PricingSection />

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

