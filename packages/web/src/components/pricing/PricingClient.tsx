"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */
// packages/web/src/components/pricing/PricingClient.tsx
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Zap, Shield, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { detectPricing, type PricingPlan } from "@/lib/payments/geo-pricing";
import { RazorpayCheckout } from "@/components/payments/RazorpayCheckout";

const FREE_FEATURES = [
  "Capture sessions on Claude, ChatGPT, Gemini, Grok, Perplexity, DeepSeek",
  "Full Context migration (Tier 1)",
  "6 most recent messages always preserved",
  "Local IndexedDB storage — zero ContextMover access",
  "Export sessions (JSON, Markdown, plain text)",
  "Prompt template library (15 system templates)",
];

const PRO_FEATURES = [
  "Everything in Free",
  "Smart Summary compression (Tier 2)",
  "Attention Engine — semantic memory graph (Tier 3)",
  "Personal Supabase vault sync + realtime",
  "Cross-device session access",
  "Super Memory across all platforms",
  "Unlimited prompt templates",
  "Priority support",
];

type BillingPeriod = "monthly" | "annual";

export function PricingClient() {
  const router = useRouter();
  const [billing, setBilling]   = useState<BillingPeriod>("monthly");
  const [pricing, setPricing]   = useState<PricingPlan | null>(null);
  const [user,    setUser]      = useState<User | null>(null);
  const [isPro,   setIsPro]     = useState(false);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    async function init() {
      try {
        const [plan, supabase] = [
          await detectPricing(),
          createClient(),
        ];
        setPricing(plan);

        const { data: { user: u } } = await supabase.auth.getUser();
        setUser(u);

        if (u) {
          const { data } = await supabase
            .from("users")
            .select("is_pro")
            .eq("id", u.id)
            .single();
          const profile = data as { is_pro: boolean } | null;
          setIsPro(profile?.is_pro ?? false);
        }
      } finally {
        setLoading(false);
      }
    }
    void init();
  }, []);

  const proPrice = billing === "monthly"
    ? pricing?.pro.display
    : pricing?.pro.annualDisplay;

  const proPeriod = billing === "monthly" ? "/month" : "/year";

  function handleSuccess() {
    toast.success("🎉 Pro activated! Welcome to ContextMover Pro.");
    setIsPro(true);
    router.refresh();
  }

  function handleFailure(error: string) {
    toast.error(`Payment failed: ${error}`);
  }

  function ProCTA() {
    if (loading) return (
      <div className="h-11 w-full animate-pulse rounded-[6px] bg-[#1A2A1A]" />
    );

    if (!user) return (
      <Link
        href="/signup"
        className="flex w-full items-center justify-center gap-2 rounded-[6px] bg-[#00FF88] px-4 py-3 text-sm font-black text-black transition-all hover:bg-[#00FF88]/90"
      >
        <Zap size={14} /> Get started <ChevronRight size={14} />
      </Link>
    );

    if (isPro) return (
      <Link
        href="/settings"
        className="flex w-full items-center justify-center gap-2 rounded-[6px] border border-[#00FF88]/30 px-4 py-3 text-sm font-semibold text-[#00FF88] transition-all hover:bg-[#00FF88]/10"
      >
        Manage subscription
      </Link>
    );

    return (
      <RazorpayCheckout
        plan="pro"
        billing={billing}
        onSuccess={handleSuccess}
        onFailure={handleFailure}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5]">
      <div className="max-w-4xl mx-auto px-6 py-16">
        {/* Back link */}
        <div className="mb-2 flex justify-center">
          <Link
            href="/"
            className="text-xs font-mono text-[#6B6B6B] hover:text-[#00FF88] transition-colors"
          >
            ← ContextMover
          </Link>
        </div>

        {/* Heading */}
        <div className="mb-12 text-center">
          <h1
            className="text-3xl font-black uppercase text-[#00FF88]"
            style={{ letterSpacing: "0.12em", textShadow: "0 0 24px rgba(0,255,136,0.3)" }}
          >
            Pricing
          </h1>
          <p className="mt-3 text-sm text-[#6B6B6B]">
            Start free. Your data always stays yours.
          </p>
        </div>

        {/* Privacy badge */}
        <div className="mb-8 flex items-start justify-center gap-2 rounded-[8px] border border-[#00FF88]/15 bg-[#00FF88]/5 px-5 py-4">
          <Shield size={14} className="text-[#00FF88] shrink-0 mt-0.5" />
          <div className="text-xs font-mono text-[#2A6A2A] space-y-1">
            <p><strong className="text-[#00FF88]">Zero-knowledge architecture</strong> — on every plan.</p>
            <p>User data never touches our servers · Context stays on your machine</p>
            <p>Vault syncs only to your own Supabase · We cannot read or sell your conversations</p>
          </div>
        </div>

        {/* Billing toggle */}
        <div className="mb-8 flex items-center justify-center gap-3">
          <button
            onClick={() => setBilling("monthly")}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-all ${
              billing === "monthly"
                ? "bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30"
                : "text-[#6B6B6B] border border-transparent hover:text-[#F5F5F5]"
            }`}
          >
            Monthly
          </button>
          <button
            onClick={() => setBilling("annual")}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-all ${
              billing === "annual"
                ? "bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30"
                : "text-[#6B6B6B] border border-transparent hover:text-[#F5F5F5]"
            }`}
          >
            Annual
            {pricing && (
              <span className="ml-1.5 rounded-full bg-[#00FF88]/20 px-1.5 py-0.5 text-[9px] font-black text-[#00FF88]">
                {billing === "annual" ? "✓ " : ""}{pricing.pro.annualSavings}
              </span>
            )}
          </button>
        </div>

        {/* Pricing cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Free */}
          <div className="rounded-[10px] border border-[#2A2A2A] bg-[#111] p-7">
            <div className="mb-5">
              <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#6B6B6B]">
                Free forever
              </p>
              <p className="mt-1 text-4xl font-black text-[#F5F5F5]">$0</p>
              <p className="mt-0.5 text-xs text-[#6B6B6B]">No credit card required</p>
            </div>
            <ul className="mb-7 space-y-2.5">
              {FREE_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2.5">
                  <Check size={13} className="mt-0.5 shrink-0 text-[#00FF88]" />
                  <span className="text-xs text-[#B0B0B0]">{f}</span>
                </li>
              ))}
            </ul>
            <Link
              href={user ? "/analytics" : "/signup"}
              className="flex w-full items-center justify-center gap-2 rounded-[6px] border border-[#2A2A2A] px-4 py-3 text-sm font-semibold text-[#F5F5F5] hover:border-[#3A3A3A] hover:bg-[#1A1A1A] transition-all"
            >
              {user ? "Your current plan" : "Get started free"}
            </Link>
          </div>

          {/* Pro */}
          <div
            className="relative rounded-[10px] border border-[#00FF88]/30 bg-[#0D1A0D] p-7"
            style={{ boxShadow: "0 0 40px rgba(0,255,136,0.08)" }}
          >
            <div className="absolute -top-3 right-5">
              <span className="rounded-full border border-[#00FF88]/30 bg-[#00FF88]/10 px-3 py-1 text-[9px] font-black uppercase tracking-widest text-[#00FF88]">
                Most Popular
              </span>
            </div>
            <div className="mb-5">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#00FF88]">
                  Pro
                </p>
                {/* Geo badge */}
                {!loading && pricing && (
                  <span className="rounded-full bg-[#1A1A1A] border border-[#2A2A2A] px-2 py-0.5 text-[9px] font-mono text-[#6B6B6B]">
                    {pricing.region === "india" ? "🇮🇳 India pricing" : "🌍 Global pricing"}
                  </span>
                )}
              </div>
              <div className="flex items-baseline gap-1 mt-1">
                <p className="text-4xl font-black text-[#F5F5F5]">
                  {loading ? "—" : proPrice}
                </p>
                <p className="text-sm text-[#6B6B6B]">{proPeriod}</p>
              </div>
              {billing === "annual" && pricing && (
                <p className="mt-0.5 text-xs text-[#00FF88]">
                  {pricing.pro.annualSavings}
                </p>
              )}
              {billing === "monthly" && pricing && (
                <p className="mt-0.5 text-xs text-[#6B6B6B]">
                  or {pricing.pro.annualDisplay}/year
                </p>
              )}
            </div>
            <ul className="mb-7 space-y-2.5">
              {PRO_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2.5">
                  <Check size={13} className="mt-0.5 shrink-0 text-[#00FF88]" />
                  <span className="text-xs text-[#B0B0B0]">{f}</span>
                </li>
              ))}
            </ul>
            <ProCTA />
          </div>
        </div>

        <p className="mt-8 text-center text-xs text-[#3A3A3A]">
          7-day refund policy — no questions asked.
        </p>
        <p className="mt-3 text-center text-xs text-[#3A3A3A]">
          Questions?{" "}
          <a href="mailto:hey@contextmover.com" className="text-[#00FF88] hover:underline">
            hey@contextmover.com
          </a>
        </p>
      </div>
    </div>
  );
}
