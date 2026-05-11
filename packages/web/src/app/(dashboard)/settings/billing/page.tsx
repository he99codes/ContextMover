"use client";
// packages/web/src/app/(dashboard)/settings/billing/page.tsx
// Billing & subscription dashboard. Reads /api/payments/subscription and
// renders plan / status / next-bill / usage. Cancel flow hits /api/payments/cancel.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { Plan, Subscription, UsageData, UsageLimits } from "@/lib/payments/types";

interface BillingPayload {
  subscription: Subscription;
  usage:        UsageData;
  limits:       UsageLimits;
  isPro:        boolean;
}

export default function BillingPage() {
  const supabase = createClient();
  const [data,        setData]     = useState<BillingPayload | null>(null);
  const [loading,     setLoading]  = useState(true);
  const [cancelling,  setCancelling] = useState(false);
  const [notice,      setNotice]    = useState<string | null>(null);
  const [confirm,     setConfirm]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        window.location.href = "/login?redirect=/settings/billing";
        return;
      }
      const res = await fetch("/api/payments/subscription", {
        headers: { authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const payload = await res.json();
        // Revive Date fields — JSON returns ISO strings.
        const sub = payload.subscription;
        payload.subscription = {
          ...sub,
          currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null,
          cancelledAt:      sub.cancelledAt      ? new Date(sub.cancelledAt)      : null,
          trialEnd:         sub.trialEnd         ? new Date(sub.trialEnd)         : null,
        };
        setData(payload);
      }
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  async function handleCancel() {
    setCancelling(true);
    setNotice(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const res = await fetch("/api/payments/cancel", {
        method:  "POST",
        headers: { authorization: `Bearer ${session.access_token}` },
      });
      const result = await res.json();
      if (result.cancelled) {
        setNotice(
          result.mock
            ? "Subscription cancelled (mock mode)."
            : "Subscription cancelled. You'll keep Pro features until the end of the billing cycle."
        );
        setConfirm(false);
        await load();
      } else {
        setNotice(result.error ?? "Cancel failed");
      }
    } catch (err) {
      console.error("Cancel failed:", err);
      setNotice("Cancel failed — please try again.");
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto p-8 text-[#6B6B6B] text-sm">
        Loading billing details…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-3xl mx-auto p-8 text-[#6B6B6B] text-sm">
        Could not load billing details.
      </div>
    );
  }

  const { subscription, usage, isPro } = data;

  // ── No subscription → show pricing CTA ──────────────────────────────────
  if (!isPro) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <h1 className="text-xl font-bold text-[#F5F5F5] mb-2">Billing</h1>
        <p className="text-sm text-[#6B6B6B] mb-6">
          You&apos;re on the free plan.
        </p>
        <FreeSummary usage={usage} />
        <div className="mt-6">
          <Link
            href="/pricing"
            className="inline-block rounded-md bg-[#00FF88] px-5 py-3 text-xs font-black uppercase tracking-wider text-[#0A0A0A] hover:opacity-90"
          >
            View plans →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-8 text-[#F5F5F5]">
      <h1 className="text-xl font-bold mb-2">Billing &amp; Subscription</h1>
      <p className="text-sm text-[#6B6B6B] mb-6">
        Manage your ContextForge subscription.
      </p>

      {notice && (
        <div className="mb-4 rounded-md border border-[#2A2A2A] bg-[#111] px-4 py-3 text-xs text-[#F5F5F5]">
          {notice}
        </div>
      )}

      {/* Plan summary */}
      <section className="rounded-md border border-[#2A2A2A] bg-[#111] p-5 mb-4">
        <Row label="Current plan" value={planLabel(subscription.plan)} />
        <Row label="Status"        value={statusLabel(subscription)} />
        {subscription.trialEnd && subscription.status === "trialing" && (
          <Row label="Trial ends" value={formatDate(subscription.trialEnd)} />
        )}
        {subscription.currentPeriodEnd && (
          <Row
            label={subscription.status === "cancelled" ? "Access until" : "Next billing"}
            value={formatDate(subscription.currentPeriodEnd)}
          />
        )}
        {subscription.gateway && (
          <Row label="Gateway" value={subscription.gateway.toUpperCase()} />
        )}
      </section>

      {/* Usage */}
      <section className="rounded-md border border-[#2A2A2A] bg-[#111] p-5 mb-4">
        <h2 className="text-sm font-semibold mb-3">Usage this month</h2>
        <UsageRow label="Full Context"    used={usage.simpleMigrations}    total="∞" />
        <UsageRow label="Smart Summary"   used={usage.smartMigrations}     total="∞" />
        <UsageRow label="Attention"       used={usage.attentionMigrations} total="∞" />
      </section>

      {/* Cancel */}
      {subscription.status !== "cancelled" && (
        <section className="rounded-md border border-[#2A2A2A] bg-[#111] p-5">
          {!confirm ? (
            <button
              onClick={() => setConfirm(true)}
              disabled={cancelling}
              className="rounded-md border border-[#FF4444] bg-transparent px-4 py-2 text-xs font-semibold uppercase tracking-wider text-[#FF4444] hover:bg-[#FF4444] hover:text-[#0A0A0A] disabled:opacity-50"
            >
              Cancel subscription
            </button>
          ) : (
            <div>
              <p className="text-sm mb-3">
                Cancel your subscription? You&apos;ll keep Pro features until{" "}
                <strong>{subscription.currentPeriodEnd ? formatDate(subscription.currentPeriodEnd) : "the end of your billing cycle"}</strong>.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="rounded-md bg-[#FF4444] px-4 py-2 text-xs font-black uppercase tracking-wider text-[#0A0A0A] hover:opacity-90 disabled:opacity-50"
                >
                  {cancelling ? "Cancelling…" : "Yes, cancel"}
                </button>
                <button
                  onClick={() => setConfirm(false)}
                  disabled={cancelling}
                  className="rounded-md border border-[#2A2A2A] px-4 py-2 text-xs uppercase tracking-wider text-[#6B6B6B] hover:text-[#F5F5F5]"
                >
                  Keep my plan
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function planLabel(plan: Plan): string {
  return plan === "team" ? "Team" : plan === "pro" ? "Pro" : "Free";
}

function statusLabel(sub: Subscription): string {
  if (sub.status === "trialing" && sub.trialEnd) {
    const days = Math.max(0, Math.ceil((sub.trialEnd.getTime() - Date.now()) / 86_400_000));
    return `Active (Trial · ${days} days left)`;
  }
  if (sub.status === "cancelled") return "Cancelled";
  if (sub.status === "past_due")  return "Past due";
  return "Active";
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-2 text-sm border-b border-[#1A1A1A] last:border-b-0">
      <span className="text-[#6B6B6B]">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function UsageRow({ label, used, total }: { label: string; used: number; total: string | number }) {
  return (
    <div className="flex justify-between py-1.5 text-sm">
      <span className="text-[#6B6B6B]">{label}</span>
      <span className="font-mono">{used} / {total}</span>
    </div>
  );
}

function FreeSummary({ usage }: { usage: UsageData }) {
  return (
    <section className="rounded-md border border-[#2A2A2A] bg-[#111] p-5">
      <h2 className="text-sm font-semibold mb-3 text-[#F5F5F5]">Usage this month</h2>
      <UsageRow label="Full Context"   used={usage.simpleMigrations}    total={50} />
      <UsageRow label="Smart Summary"  used={usage.smartMigrations}     total={50} />
      <UsageRow label="Attention"      used={usage.attentionMigrations} total={10} />
    </section>
  );
}
