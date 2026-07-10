"use client";

import { useState } from "react";
import { Loader2, Zap } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { RazorpayOptions, RazorpayResponse, RazorpaySubscriptionResponse, RazorpayPaymentFailedResponse } from "@/types/razorpay";

interface Props {
  billing: "monthly" | "annual";
  earlyBird: boolean;
  onSuccess: () => void;
}

export function RazorpaySubscription({ billing, earlyBird, onSuccess }: Props) {
  const [loading, setLoading] = useState(false);

  async function handleSubscribe() {
    setLoading(true);
    try {
      const supabase = createClient();
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      
      if (sessionError || !session) {
        toast.error("Please log in to subscribe");
        setLoading(false);
        return;
      }

      // Step 1: Create subscription server-side
      const res = await fetch("/api/payments/razorpay/create-subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          billing,
          userId: session.user.id,
          userEmail: session.user.email,
          earlyBird,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.subscriptionId || !data.keyId) {
        toast.error(data.error ?? "Failed to create subscription");
        setLoading(false);
        return;
      }

      // Step 2: Load Razorpay script if not loaded
      if (!window.Razorpay) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://checkout.razorpay.com/v1/checkout.js";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("Failed to load Razorpay script"));
          document.body.appendChild(script);
        });
      }

      // Step 3: Open Razorpay checkout modal
      const options: RazorpayOptions = {
        key: data.keyId,
        subscription_id: data.subscriptionId,
        name: "ContextMover",
        description: `Pro ${billing === "annual" ? "Annual" : "Monthly"} · Autopay`,
        prefill: { email: session.user.email ?? "" },
        theme: { color: "#00D26A" },
        modal: { ondismiss: () => setLoading(false) },
        handler: async (response: RazorpayResponse | RazorpaySubscriptionResponse) => {
          // Step 4: Verify on backend
          const verifyRes = await fetch("/api/payments/razorpay/verify-subscription", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_subscription_id: "razorpay_subscription_id" in response ? response.razorpay_subscription_id : undefined,
              razorpay_signature: response.razorpay_signature,
              userId: session.user.id,
            }),
          });

          const verifyData = await verifyRes.json().catch(() => ({}));
          if (verifyRes.ok && verifyData.success) {
            onSuccess();
          } else {
            // [CM-RZP-FIX] Verification can lag if the subscription row isn't
            // active yet. The webhook (subscription.activated) is the source of
            // truth, so reassure the user instead of showing a hard failure.
            console.error("[CM:razorpay] verify failed", verifyRes.status, verifyData);
            toast.message(
              verifyData.error ??
                "Payment received. Pro is activating — this can take up to a minute. Refresh if it doesn't appear.",
            );
            onSuccess();
          }
          setLoading(false);
        },
      };

      const rzp = new window.Razorpay(options);

      rzp.on("payment.failed", (response: RazorpayPaymentFailedResponse) => {
        toast.error(response.error?.description ?? "Payment failed");
        setLoading(false);
      });

      rzp.open();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "An unexpected error occurred");
      setLoading(false);
    }
  }

  const cycleText = billing === "annual" ? "yearly" : "monthly";

  return (
    <div>
      <button
        onClick={handleSubscribe}
        disabled={loading}
        className="flex w-full items-center justify-center gap-2 rounded-[6px] bg-[#00FF88] px-4 py-3 text-sm font-black text-black transition-all hover:bg-[#00FF88]/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
        {loading ? "Processing…" : earlyBird ? "Claim Early Bird Price →" : "Upgrade to Pro →"}
      </button>
      <p className="mt-2 text-center text-[10px] text-[#6B6B6B]">
        🔄 Auto-renews {cycleText}. Cancel anytime from Settings.
        <br />
        Secured by Razorpay. Supports UPI Autopay &amp; cards.
      </p>
    </div>
  );
}
