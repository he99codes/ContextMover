"use client";
// packages/web/src/app/pricing/page.tsx
// Geo-aware pricing page driven by the v2 payment infrastructure.
// Handles both Stripe (redirect) and Razorpay (modal) checkout flows,
// plus a mock-mode pathway when API keys are placeholders.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSubscription } from "@/hooks/useSubscription";
import { createClient } from "@/lib/supabase/client";
import { RazorpaySubscription } from "@/components/payments/RazorpaySubscription";
import { INDIA_PRICING, GLOBAL_PRICING, type PricingPlan } from "@/lib/payments/geo-pricing";

function detectDefaultCurrency(): "INR" | "USD" {
  if (typeof window === "undefined") return "INR";
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const lang = navigator.language;
    if (tz === "Asia/Calcutta" || tz === "Asia/Kolkata" || lang.startsWith("en-IN")) return "INR";
  } catch { /* ignore */ }
  return "USD";
}

const FREE_FEATURES = [
  "50 Full Context migrations/mo",
  "50 Smart Summary migrations/mo",
  "10 Attention Engine migrations/mo",
  "10 sessions stored",
  "6 system prompt templates",
  "All 4 AI platforms",
];

const PRO_FEATURES = [
  "Unlimited migrations",
  "Unlimited sessions stored",
  "All 15 prompt templates",
  "Custom prompt templates",
  "IDE + file context",
  "GitHub repo extraction",
  "MCP server access",
  "Priority updates",
];

const TEAM_FEATURES = [
  "Everything in Pro",
  "Shared prompt templates",
  "Team session vault",
  "Admin dashboard",
  "Audit logs",
  "Priority support",
  "Custom onboarding",
];

// Razorpay subscription-mode constructor (different option shape from the
// one-shot order constructor declared globally in `types/razorpay.d.ts`).
// We cast `window.Razorpay` to this loose shape at call site.
interface SubscriptionRazorpayCtor {
  new (options: Record<string, unknown>): { open: () => void };
}

export default function PricingPage() {
  const router = useRouter();
  const { isPro } = useSubscription();
  const supabase = createClient();
  const [, setCheckoutLoading] = useState<"pro" | "team" | null>(null);
  const [mockNotice, setMockNotice] = useState<string | null>(null);
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("monthly");
  const [error, setError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [currency, setCurrency] = useState<"INR" | "USD">(detectDefaultCurrency);
  const [currencySelected, setCurrencySelected] = useState(false);

  const selectedPricing: PricingPlan = currency === "INR" ? INDIA_PRICING : GLOBAL_PRICING;

  function handleCurrencySelect(c: "INR" | "USD") {
    setCurrency(c);
    setCurrencySelected(true);
  }

  // Clear mock-mode notice after a few seconds.
  useEffect(() => {
    if (!mockNotice) return;
    const t = setTimeout(() => setMockNotice(null), 6_000);
    return () => clearTimeout(t);
  }, [mockNotice]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function handleUpgrade(planType: "pro" | "team") {
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
        // Stripe → redirect to hosted checkout.
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
    <div
      style={{
        minHeight:  "100vh",
        background: "#0A0A0A",
        color:      "#F5F5F5",
        padding:    "80px 24px",
        fontFamily: "Inter, sans-serif",
      }}
    >
      {/* Razorpay SDK is loaded globally in app/layout.tsx */}

      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: "40px" }}>
        <h1 style={{ fontSize: "48px", fontWeight: 900, margin: "0 0 16px" }}>
          Simple pricing.
        </h1>
        <p style={{ fontSize: "18px", color: "#6B6B6B", margin: 0 }}>
          Start free. Upgrade when you need more.
        </p>
      </div>

      {/* Step 1: Currency selector */}
      <div style={{ textAlign: "center", marginBottom: "40px" }}>
        <p style={{ fontSize: "13px", color: "#6B6B6B", marginBottom: "16px" }}>
          Select your currency
        </p>
        <CurrencySelector currency={currency} onSelect={handleCurrencySelect} />
      </div>

      {/* Step 2: Billing toggle + cards — revealed after currency selection */}
      <div
        style={{
          opacity:       currencySelected ? 1 : 0,
          transform:     currencySelected ? "none" : "translateY(16px)",
          transition:    "opacity 0.4s ease, transform 0.4s ease",
          pointerEvents: currencySelected ? "auto" : "none",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: "24px" }}>
          <BillingToggle billingCycle={billingCycle} onChange={setBillingCycle} annualSavings={selectedPricing.pro.annualSavings} />
          <div style={{ marginTop: "12px", fontSize: "12px", color: "#3A3A3A" }}>
            Showing {currency === "INR" ? "India (INR)" : "Global (USD)"} pricing
          </div>
        </div>
        {mockNotice && (
          <div
            style={{
              marginTop:    "20px",
              display:      "inline-block",
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
        )}
        {error && (
          <p style={{ color: "#EF4444", fontSize: "12px", marginTop: "12px" }}>
            {error}
          </p>
        )}
        {showSuccess && (
          <div style={{ marginTop: "12px", color: "#00FF88", fontSize: "12px" }}>
            ✅ Subscription active!
          </div>
        )}

        {/* Pricing cards */}
        <div
          style={{
            display:             "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap:                 "24px",
            maxWidth:            "900px",
            margin:              "0 auto 60px",
          }}
        >
        {/* Free */}
        <PlanCard
          tag="Free"
          tagColor="#6B6B6B"
          price={`${currency === "INR" ? "₹" : "$"}0`}
          subtitle="forever"
          features={FREE_FEATURES}
          featureColor="#6B6B6B"
          cta={isPro ? "Downgrade" : "Current plan"}
          ctaDisabled
        />

        {/* Pro */}
        <PlanCard
          tag="Pro"
          tagColor="#00FF88"
          price={
            billingCycle === "annual"
              ? selectedPricing.pro.annualDisplay
              : selectedPricing.pro.display
          }
          subtitle={billingCycle === "annual" ? `per year · ${selectedPricing.pro.annualSavings}` : "per month"}
          features={PRO_FEATURES}
          featureColor="#F5F5F5"
          featured
          cta={isPro ? "Current plan" : undefined}
          ctaDisabled={isPro}
        >
          {!isPro && (
            <div style={{ marginTop: "16px" }}>
              <RazorpaySubscription
                plan="pro"
                billing={billingCycle}
                buttonText={billingCycle === "annual" ? "Subscribe Yearly" : "Subscribe Monthly"}
                onSuccess={() => {
                  setShowSuccess(true);
                  setError(null);
                  setTimeout(() => router.push("/settings?payment=success"), 1_000);
                }}
                onFailure={(err) => {
                  setError(err);
                  setShowSuccess(false);
                }}
              />
            </div>
          )}
        </PlanCard>

        {/* Team */}
        <PlanCard
          tag="Team"
          tagColor="#6B6B6B"
          price={selectedPricing.team.display}
          subtitle="per user/month"
          features={TEAM_FEATURES}
          featureColor="#F5F5F5"
        >
          <div
            style={{
              marginTop:     "24px",
              padding:       "14px",
              border:        "1px solid #2A2A2A",
              borderRadius:  "6px",
              color:         "#3A3A3A",
              fontSize:      "12px",
              fontWeight:    700,
              textAlign:     "center",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              cursor:        "default",
              userSelect:    "none",
            }}
          >
            Team plans coming soon
          </div>
        </PlanCard>
        </div>

        {/* Dev-only mock upgrade — never shipped to production builds */}
        {isDev && !isPro && (
        <div style={{ textAlign: "center", marginBottom: "24px" }}>
          <button
            onClick={activateMockPro}
            style={{
              padding:        "10px 18px",
              background:     "transparent",
              border:         "1px dashed #00FF88",
              borderRadius:   "6px",
              color:          "#00FF88",
              fontSize:       "11px",
              fontWeight:     700,
              cursor:         "pointer",
              textTransform:  "uppercase",
              letterSpacing:  "0.1em",
            }}
          >
            [DEV] Activate Mock Pro
          </button>
          <div style={{ marginTop: "6px", fontSize: "10px", color: "#3A3A3A" }}>
            Skip checkout · flips your account to Pro in Supabase
          </div>
        </div>
      )}

        {/* Trust signals */}
        <div style={{ textAlign: "center", color: "#3A3A3A", fontSize: "12px" }}>
          🔒 Zero-knowledge · Local-first · Your data never touches our servers · Cancel anytime · No questions asked
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BillingToggle
// ─────────────────────────────────────────────────────────────────────────────

function BillingToggle({
  billingCycle,
  onChange,
  annualSavings,
}: {
  billingCycle:  "monthly" | "annual";
  onChange:      (c: "monthly" | "annual") => void;
  annualSavings: string;
}) {
  return (
    <div style={{ marginTop: "24px", display: "flex", justifyContent: "center", gap: "8px" }}>
      {(["monthly", "annual"] as const).map((cycle) => {
        const active = billingCycle === cycle;
        return (
          <button
            key={cycle}
            onClick={() => onChange(cycle)}
            style={{
              padding:       "6px 16px",
              borderRadius:  "6px",
              fontSize:      "12px",
              fontWeight:    700,
              cursor:        "pointer",
              border:        `1px solid ${active ? "#00FF88" : "#2A2A2A"}`,
              background:    active ? "rgba(0,255,136,0.12)" : "transparent",
              color:         active ? "#00FF88" : "#6B6B6B",
              textTransform: "capitalize",
              letterSpacing: "0.04em",
              transition:    "all 0.15s",
            }}
          >
            {cycle}
            {cycle === "annual" && (
              <span style={{ marginLeft: "6px", fontSize: "10px", color: "#F59E0B" }}>
                {annualSavings}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────
// CurrencySelector
// ─────────────────────────────────────────────────────────────────────────────────

function CurrencySelector({
  currency,
  onSelect,
}: {
  currency: "INR" | "USD";
  onSelect: (c: "INR" | "USD") => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "center", gap: "12px" }}>
      {(["INR", "USD"] as const).map((c) => {
        const active = currency === c;
        return (
          <button
            key={c}
            onClick={() => onSelect(c)}
            style={{
              padding:      "12px 32px",
              borderRadius: "8px",
              fontSize:     "14px",
              fontWeight:   700,
              cursor:       "pointer",
              border:       `1px solid ${active ? "#00FF88" : "#2A2A2A"}`,
              background:   active ? "rgba(0,255,136,0.12)" : "transparent",
              color:        active ? "#00FF88" : "#6B6B6B",
              transition:   "all 0.15s",
              outline:      "none",
            }}
          >
            {c === "INR" ? "₹ INR — India" : "$ USD — Global"}
          </button>
        );
      })}
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────
// PlanCard
// ─────────────────────────────────────────────────────────────────────────────

interface PlanCardProps {
  tag:          string;
  tagColor:     string;
  price:        string;
  subtitle:     string;
  features:     string[];
  featureColor: string;
  cta?:         string;
  ctaDisabled?: boolean;
  ctaVariant?:  "solid" | "outline";
  featured?:    boolean;
  onCta?:       () => void;
  children?:    React.ReactNode;
}

function PlanCard({
  tag,
  tagColor,
  price,
  subtitle,
  features,
  featureColor,
  cta,
  ctaDisabled,
  ctaVariant = "solid",
  featured,
  onCta,
  children,
}: PlanCardProps) {
  const border = featured ? "1px solid rgba(0,255,136,0.4)" : "1px solid #2A2A2A";
  const shadow = featured ? "0 0 40px rgba(0,255,136,0.08)" : undefined;

  return (
    <div
      style={{
        background:   "#111111",
        border,
        borderRadius: "12px",
        padding:      "32px",
        position:     "relative",
        boxShadow:    shadow,
      }}
    >
      {featured && (
        <div
          style={{
            position:        "absolute",
            top:             "-12px",
            left:            "50%",
            transform:       "translateX(-50%)",
            background:      "#00FF88",
            color:           "#0A0A0A",
            fontSize:        "10px",
            fontWeight:      900,
            padding:         "4px 16px",
            borderRadius:    "999px",
            textTransform:   "uppercase",
            letterSpacing:   "0.1em",
          }}
        >
          Most popular
        </div>
      )}

      <div
        style={{
          fontSize:       "12px",
          fontWeight:     700,
          color:          tagColor,
          textTransform:  "uppercase",
          letterSpacing:  "0.15em",
          marginBottom:   "16px",
        }}
      >
        {tag}
      </div>

      <div style={{ fontSize: "48px", fontWeight: 900, marginBottom: "4px" }}>
        {price}
      </div>
      <div style={{ fontSize: "12px", color: "#6B6B6B", marginBottom: "32px" }}>
        {subtitle}
      </div>

      {features.map((f) => (
        <div
          key={f}
          style={{ fontSize: "13px", color: featureColor, marginBottom: "8px" }}
        >
          ✓ {f}
        </div>
      ))}

      {cta && (
        <button
          onClick={onCta}
          disabled={ctaDisabled}
          style={{
            width:          "100%",
            marginTop:      children ? "16px" : "24px",
            padding:        "14px",
            background:
              ctaVariant === "outline"
                ? "transparent"
                : ctaDisabled
                ? "#1A1A1A"
                : "#00FF88",
            border:
              ctaVariant === "outline" ? "1px solid #00FF88" : "none",
            borderRadius:   "6px",
            color:
              ctaVariant === "outline"
                ? "#00FF88"
                : ctaDisabled
                ? "#6B6B6B"
                : "#0A0A0A",
            fontSize:       "12px",
            fontWeight:     900,
            cursor:         ctaDisabled ? "default" : "pointer",
            textTransform:  "uppercase",
            letterSpacing:  "0.1em",
            boxShadow:
              ctaDisabled || ctaVariant === "outline"
                ? "none"
                : "0 0 20px rgba(0,255,136,0.4)",
          }}
        >
          {cta}
        </button>
      )}
      {children}
    </div>
  );
}
