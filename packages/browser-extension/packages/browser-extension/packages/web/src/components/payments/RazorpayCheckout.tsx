"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */
// packages/web/src/components/payments/RazorpayCheckout.tsx
import { useState } from "react";
import { Zap, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { RazorpayResponse } from "@/types/razorpay";

interface Props {
  plan:      "pro";
  billing:   "monthly" | "annual";
  label?:    string;
  onSuccess: () => void;
  onFailure: (error: string) => void;
}

export function RazorpayCheckout({
  plan,
  billing,
  label = "Upgrade to Pro",
  onSuccess,
  onFailure,
}: Props) {
  const [loading, setLoading] = useState(false);

  async function handleCheckout() {
    if (typeof window === "undefined" || !window.Razorpay) {
      onFailure("Payment gateway is still loading. Please try again.");
      return;
    }

    setLoading(true);
    try {
      // Get authenticated user.
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        onFailure("You must be signed in to upgrade.");
        return;
      }

      // Create Razorpay order server-side.
      const orderRes = await fetch("/api/payments/razorpay/create-order", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ plan, billing, userId: user.id }),
      });

      if (!orderRes.ok) {
        const err = (await orderRes.json()) as { error?: string };
        onFailure(err.error ?? "Failed to create order");
        return;
      }

      const order = (await orderRes.json()) as {
        orderId:  string;
        amount:   number;
        currency: string;
        keyId:    string;
      };

      // Open Razorpay checkout modal.
      const rzp = new window.Razorpay({
        key:         order.keyId,
        amount:      order.amount,
        currency:    order.currency,
        name:        "ContextMover",
        description: `${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan — ${billing}`,
        order_id:    order.orderId,
        prefill:     { email: user.email ?? "" },
        theme:       { color: "#00D26A" },
        modal: {
          ondismiss: () => setLoading(false),
        },
        handler: async (response: RazorpayResponse) => {
          // Verify payment server-side before updating Supabase.
          const verifyRes = await fetch("/api/payments/razorpay/verify", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ ...response, plan, billing }),
          });

          if (verifyRes.ok) {
            setLoading(false);
            onSuccess();
          } else {
            const err = (await verifyRes.json()) as { error?: string };
            setLoading(false);
            onFailure(err.error ?? "Payment verification failed");
          }
        },
      });

      rzp.open();
    } catch (err) {
      onFailure(err instanceof Error ? err.message : "An unexpected error occurred");
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleCheckout}
      disabled={loading}
      className="flex w-full items-center justify-center gap-2 rounded-[6px] bg-[#00FF88] px-4 py-3 text-sm font-black text-black transition-all hover:bg-[#00FF88]/90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Zap size={14} />
      )}
      {loading ? "Processing…" : label}
    </button>
  );
}
