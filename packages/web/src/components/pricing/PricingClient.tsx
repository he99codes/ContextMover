"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Zap, Shield, ChevronRight, Tag } from "lucide-react";
import { toast } from "sonner";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import { useSubscription } from "@/hooks/useSubscription";
import { RazorpaySubscription } from "@/components/payments/RazorpaySubscription";

const EARLY_BIRD_LIMIT = 500;

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
  // Default to monthly so the user doesn't see the annual price first
  const [billing, setBilling] = useState<BillingPeriod>("monthly");
  
  const [user, setUser] = useState<User | null>(null);
  const { isPro, refresh: refreshSubscription } = useSubscription();
  const [loading, setLoading] = useState(true);
  
  const [spotsLeft, setSpotsLeft] = useState<number | null>(null);
  const [isEarlyBird, setIsEarlyBird] = useState(false);

  // Promo code state
  const [showPromo, setShowPromo]       = useState(false);
  const [promoCode, setPromoCode]       = useState("");
  const [isRedeeming, setIsRedeeming]   = useState(false);

  const currency = useCurrency();

  useEffect(() => {
    async function init() {
      try {
        const supabase = createClient();

        const { data: { user: u } } = await supabase.auth.getUser();
        setUser(u);

        // Fetch active subscriptions to determine Early Bird availability
        try {
          const { data: { session: countSession } } = await supabase.auth.getSession();
          const countRes = await fetch("/api/payments/subscription-count", {
            headers: countSession ? { authorization: `Bearer ${countSession.access_token}` } : {},
          });
          const countData = await countRes.json();
          const spots = EARLY_BIRD_LIMIT - (countData.activeCount ?? 0);
          const available = Math.max(0, spots);
          setSpotsLeft(available);
          setIsEarlyBird(available > 0);
        } catch {
          setSpotsLeft(EARLY_BIRD_LIMIT);
          setIsEarlyBird(true);
        }

      } finally {
        setLoading(false);
      }
    }
    void init();
  }, []);

  function displayPrice(inrAmount: number): string {
    const converted = Math.round(inrAmount * currency.rate);
    return `${currency.symbol}${converted.toLocaleString()}`;
  }

  // Base INR prices
  const earlyBirdMonthly = 299;
  const earlyBirdAnnual  = 2399;
  const regularMonthly   = 499;
  const regularAnnual    = 3999;

  const proInrAmount = billing === "annual"
    ? (isEarlyBird ? earlyBirdAnnual : regularAnnual)
    : (isEarlyBird ? earlyBirdMonthly : regularMonthly);

  const proDisplayPrice = displayPrice(proInrAmount);
  
  const proOriginalPrice = billing === "annual" && isEarlyBird
    ? displayPrice(regularAnnual)
    : null;

  const proPeriod = billing === "monthly" ? "/mo" : "/yr";

  function handleSuccess() {
    toast.success("🎉 Pro activated! Welcome to ContextMover Pro.");
    // [CM-RZP-FIX] Poll the subscription endpoint since the webhook that flips
    // is_pro=true may land a few seconds after checkout completes.
    let attempts = 0;
    const poll = setInterval(() => {
      attempts += 1;
      void refreshSubscription(true);
      if (attempts >= 6) clearInterval(poll);
    }, 2500);
    router.refresh();
  }

  async function handleRedeem() {
    if (!promoCode.trim()) return;
    if (!user) {
      toast.error("Please sign in to redeem a promo code.");
      return;
    }
    setIsRedeeming(true);
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("Session expired — please sign in again.");
        return;
      }
      const res  = await fetch("/api/payments/redeem", {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ code: promoCode.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(data.message ?? "🎉 Promo applied — Pro activated for 60 days!");
        setPromoCode("");
        setShowPromo(false);
        // Poll for updated subscription status
        let attempts = 0;
        const poll = setInterval(() => {
          attempts += 1;
          void refreshSubscription(true);
          if (attempts >= 6) clearInterval(poll);
        }, 1500);
        router.refresh();
      } else {
        toast.error(data.error ?? "Invalid promo code.");
      }
    } catch {
      toast.error("Could not redeem code — please try again.");
    } finally {
      setIsRedeeming(false);
    }
  }

  function ProCTA() {
    if (loading) return <div className="h-11 w-full animate-pulse rounded-[6px] bg-[#1A2A1A]" />;

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
      <RazorpaySubscription
        billing={billing}
        earlyBird={isEarlyBird}
        onSuccess={handleSuccess}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5]">
      <div className="max-w-[960px] mx-auto px-6 py-16">
        {/* Back link */}
        <div className="mb-2 flex justify-center">
          <Link href="/" className="text-xs font-mono text-[#6B6B6B] hover:text-[#00FF88] transition-colors">
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
            <span className="ml-1.5 rounded-full bg-[#00FF88]/20 px-1.5 py-0.5 text-[9px] font-black text-[#00FF88]">
              {billing === "annual" ? "✓ " : ""}Save 33%
            </span>
          </button>
        </div>

        {/* Promo code section */}
        {!isPro && (
          <div className="mb-8 flex flex-col items-center">
            {!showPromo ? (
              <button
                onClick={() => setShowPromo(true)}
                className="flex items-center gap-1.5 text-xs text-[#555] hover:text-[#00FF88] transition-colors"
              >
                <Tag size={11} />
                Have a promo code?
              </button>
            ) : (
              <div className="flex w-full max-w-sm items-center gap-2">
                <input
                  type="text"
                  placeholder="Enter promo code…"
                  value={promoCode}
                  onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === "Enter" && handleRedeem()}
                  className="flex-1 rounded-[6px] border border-[#2A2A2A] bg-[#111] px-3 py-2 text-xs text-[#F5F5F5] font-mono placeholder:text-[#444] focus:border-[#00FF88]/40 focus:outline-none"
                  autoFocus
                  disabled={isRedeeming}
                />
                <button
                  onClick={handleRedeem}
                  disabled={isRedeeming || !promoCode.trim()}
                  className="rounded-[6px] bg-[#00FF88] px-4 py-2 text-xs font-black text-black transition-all hover:bg-[#00FF88]/90 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isRedeeming ? "…" : "Redeem"}
                </button>
                <button
                  onClick={() => { setShowPromo(false); setPromoCode(""); }}
                  className="text-xs text-[#555] hover:text-[#F5F5F5] transition-colors"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        )}

        {/* Pricing cards flex container */}
        <div className="flex flex-col md:flex-row justify-center items-stretch gap-4 max-w-[960px] mx-auto">
          
          {/* Free Card */}
          <div className="flex-1 rounded-[10px] border border-[#2A2A2A] bg-[#111] p-7 md:min-w-[240px] md:max-w-[300px]">
            <div className="mb-5">
              <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#6B6B6B]">
                Free forever
              </p>
              <p className="mt-1 text-4xl font-black text-[#F5F5F5]">{displayPrice(0)}</p>
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
            <div className="mt-auto pt-4">
              <Link
                href={user ? "/analytics" : "/signup"}
                className="flex w-full items-center justify-center gap-2 rounded-[6px] border border-[#2A2A2A] px-4 py-3 text-sm font-semibold text-[#F5F5F5] hover:border-[#3A3A3A] hover:bg-[#1A1A1A] transition-all"
              >
                {user ? "Your current plan" : "Get started free"}
              </Link>
            </div>
          </div>

          {/* Pro Card */}
          <div
            className="flex-1 relative rounded-[10px] border border-[#00FF88]/30 bg-[#0D1A0D] p-7 md:min-w-[240px] md:max-w-[320px] flex flex-col"
            style={{ boxShadow: "0 0 40px rgba(0,255,136,0.08)" }}
          >
            {/* Badges */}
            <div className="absolute -top-3 left-0 right-0 flex justify-center gap-2">
              <span className="rounded-full border border-[#00FF88]/30 bg-[#0D1A0D] px-3 py-1 text-[9px] font-black uppercase tracking-widest text-[#00FF88]">
                Most Popular
              </span>
              {!loading && isEarlyBird && (
                <span className="rounded-full border border-[#00FF88] bg-[#00FF88] text-black px-3 py-1 text-[9px] font-black uppercase tracking-widest flex items-center gap-1 shadow-[0_0_10px_rgba(0,255,136,0.5)]">
                  ⚡ Early Bird — {spotsLeft} left
                </span>
              )}
            </div>

            <div className="mb-5 mt-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#00FF88]">
                  Pro
                </p>
                {!loading && currency.isIndia && (
                  <span className="rounded-full bg-[#1A1A1A] border border-[#2A2A2A] px-2 py-0.5 text-[9px] font-mono text-[#6B6B6B]">
                    🇮🇳 India pricing
                  </span>
                )}
              </div>
              <div className="flex items-baseline gap-1 mt-1 flex-wrap">
                <p className="text-4xl font-black text-[#F5F5F5]">
                  {loading ? "—" : proDisplayPrice}
                </p>
                <p className="text-sm text-[#6B6B6B]">{proPeriod}</p>
              </div>
              
              {!loading && (
                <div className="h-4 mt-0.5">
                  {proOriginalPrice && (
                    <p className="text-xs text-[#6B6B6B]">
                      <span className="line-through">{proOriginalPrice}</span>
                      <span className="text-[#00FF88] ml-2">Save 40%</span>
                    </p>
                  )}
                </div>
              )}

              {!loading && !currency.isIndia && (
                <p className="text-[11px] text-[#888] mt-2">
                  Billed as ₹{proInrAmount.toLocaleString()}{proPeriod} · Checkout in INR
                </p>
              )}
            </div>

            <ul className="mb-7 space-y-2.5 flex-grow">
              {PRO_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2.5">
                  <Check size={13} className="mt-0.5 shrink-0 text-[#00FF88]" />
                  <span className="text-xs text-[#B0B0B0]">{f}</span>
                </li>
              ))}
            </ul>

            <div className="mt-auto pt-4">
              <ProCTA />
            </div>
          </div>
        </div>

        <p className="mt-8 text-center text-xs text-[#3A3A3A]">
          7-day refund for first-time Pro subscribers only.
        </p>
        <p className="mt-3 text-center text-xs text-[#3A3A3A]">
          ❤️ Built by an indie developer. Every subscription directly supports
          the person writing the code, not a corporation.
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