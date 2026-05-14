"use client";
// packages/web/src/components/payments/RazorpaySubscription.tsx
// Razorpay subscription checkout (autopay) for Pro / Team plans.

import { useState } from "react";
import Script from "next/script";
import { Loader2, Zap } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

interface Props {
  plan:        "pro" | "team";
  billing:     "monthly" | "annual";
  buttonText?: string;
  onSuccess:   () => void;
  onFailure:   (error: string) => void;
}


export function RazorpaySubscription({
  plan,
  billing,
  buttonText = "Subscribe",
  onSuccess,
  onFailure,
}: Props) {
  const [loading, setLoading] = useState(false);

  async function handleSubscribe() {
    setLoading(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session) {
        onFailure("Please log in");
        setLoading(false);
        return;
      }

      // 1. Create subscription server-side
      const res = await fetch("/api/payments/razorpay/create-subscription", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ plan, billing }),
      });

      const data = (await res.json()) as {
        subscriptionId?: string;
        keyId?:         string;
        error?:         string;
      };

      if (!res.ok || !data.subscriptionId || !data.keyId) {
        onFailure(data.error ?? "Failed to create subscription");
        setLoading(false);
        return;
      }

      // 2. Open Razorpay subscription modal
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ctor = (window as any).Razorpay;
      const rzp = new Ctor({
        key:             data.keyId,
        subscription_id: data.subscriptionId,
        name:            "ContextMover",
        description:     `${plan} ${billing} · Autopay`,
        prefill:         { email: session.user.email ?? "" },
        theme:           { color: "#00D26A" },
        modal: {
          ondismiss: () => setLoading(false),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (response: any) => {
          const verifyRes = await fetch(
            "/api/payments/razorpay/verify-subscription",
            {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({
                razorpay_payment_id:      response.razorpay_payment_id,
                razorpay_subscription_id: response.razorpay_subscription_id,
                razorpay_signature:       response.razorpay_signature,
                userId:                   session.user.id,
                plan,
                billing,
              }),
            }
          );

          const verifyData = (await verifyRes.json()) as {
            ok?:    boolean;
            error?: string;
          };

          if (verifyRes.ok && verifyData.ok) {
            onSuccess();
          } else {
            onFailure(verifyData.error ?? "Verification failed");
          }
          setLoading(false);
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rzp.on("payment.failed", (response: any) => {
        onFailure(response.error.description);
        setLoading(false);
      });

      rzp.open();
    } catch (err) {
      onFailure(
        err instanceof Error ? err.message : "An unexpected error occurred"
      );
      setLoading(false);
    }
  }

  const cycleText = billing === "annual" ? "yearly" : "monthly";

  return (
    <div>
      <Script
        src="https://checkout.razorpay.com/v1/checkout.js"
        strategy="lazyOnload"
      />
      <button
        onClick={handleSubscribe}
        disabled={loading}
        className="flex w-full items-center justify-center gap-2 rounded-[6px] bg-[#00FF88] px-4 py-3 text-sm font-black text-black transition-all hover:bg-[#00FF88]/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Zap size={14} />
        )}
        {loading ? "Processing…" : buttonText}
      </button>
      <p className="mt-2 text-center text-[10px] text-[#6B6B6B]">
        🔄 Auto-renews {cycleText}. Cancel anytime from Settings.
        <br />
        Secured by Razorpay. Supports UPI Autopay &amp; cards.
      </p>
    </div>
  );
}
