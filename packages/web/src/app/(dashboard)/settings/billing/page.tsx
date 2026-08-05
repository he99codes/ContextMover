"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */
// packages/web/src/app/(dashboard)/settings/billing/page.tsx
// Billing & subscription dashboard. Reads /api/payments/subscription and
// renders plan / status / next-bill / usage. Cancel flow hits /api/payments/cancel.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useSubscription } from "@/hooks/useSubscription";
import type { UsageData } from "@/lib/payments/types";
import { FREE_LIMITS } from "@/lib/payments/types";

export default function BillingPage() {
  const supabase = createClient();
  // VV: Use the shared useSubscription hook — deduplicates /api/payments/subscription
  // calls across ManagePlanCard, Sidebar, PricingPage, and this billing page.
  const { isPro, plan, interval, status, currentEnd, loading: subLoading, refresh: refreshSub } = useSubscription();
  const [usage,        setUsage]     = useState<UsageData | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [cancelling,     setCancelling]    = useState(false);
  const [notice,         setNotice]         = useState<string | null>(null);
  const [refundReason,   setRefundReason]   = useState("");
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [refundDone,     setRefundDone]     = useState(false);
  const [refundPending,  setRefundPending]  = useState(false);
  const [showRefund,     setShowRefund]     = useState(false);
  const [confirm,     setConfirm]   = useState(false);

  // Only fetch usage data — subscription comes from useSubscription
  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        window.location.href = "/login?redirect=/settings/billing";
        return;
      }
      const usageRes = await fetch("/api/usage/status", {
        headers: { authorization: `Bearer ${session.access_token}` },
      }).catch(() => null);

      if (usageRes && usageRes.ok) {
        const usageData = await usageRes.json();
        setUsage({
          simpleMigrations:    usageData.usage?.tier1?.used ?? 0,
          smartMigrations:     usageData.usage?.tier2?.used ?? 0,
          attentionMigrations: usageData.usage?.tier3?.used ?? 0,
          sessionsCount:       0,
          month:               usageData.month ?? "",
        } as UsageData);
      }
    } finally {
      setUsageLoading(false);
    }
  }, [supabase]);

  useEffect(() => { void loadUsage(); }, [loadUsage]);

  // Reload subscription after cancel
  const load = useCallback(async () => {
    await refreshSub(true);
    await loadUsage();
  }, [refreshSub, loadUsage]);

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

  if (subLoading) {
    return (
      <div className="max-w-3xl mx-auto p-8 text-[#6B6B6B] text-sm">
        Loading billing details…
      </div>
    );
  }



  // ── No subscription → show pricing CTA ──────────────────────────────────
  if (!isPro) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <h1 className="text-xl font-bold text-[#F5F5F5] mb-2">Billing</h1>
        <p className="text-sm text-[#6B6B6B] mb-6">
          You&apos;re on the free plan.
        </p>
        {usage && <FreeSummary usage={usage} />}
        <div className="mt-6">
          <Link
            href="/pricing"
            className="inline-block rounded-md bg-[#00FF88] px-5 py-3 text-xs font-black uppercase tracking-wider text-[#00FF88] hover:opacity-90"
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
        Manage your ContextMover subscription.
      </p>

      {notice && (
        <div className="mb-4 rounded-md border border-[#2A2A2A] bg-[#111] px-4 py-3 text-xs text-[#F5F5F5]">
          {notice}
        </div>
      )}

      {/* Plan summary */}
      <section className="rounded-md border border-[#2A2A2A] bg-[#111] p-5 mb-4">
        <Row label="Current plan" value={planLabel(plan, interval)} />
        <Row label="Status"        value={statusLabel(status)} />
        {currentEnd && (
          <Row
            label={status === "cancelled" ? "Access until" : "Next billing"}
            value={formatDate(new Date(currentEnd))}
          />
        )}
      </section>

      {/* Usage */}
      <section className="rounded-md border border-[#2A2A2A] bg-[#111] p-5 mb-4">
        <h2 className="text-sm font-semibold mb-3">Usage this month</h2>
        {usageLoading ? (
          <p className="text-xs text-[#6B6B6B]">Loading usage…</p>
        ) : usage ? (
          <>
            <UsageRow label="Full Context"    used={usage.simpleMigrations}    total="∞" />
            <UsageRow label="Smart Summary"   used={usage.smartMigrations}     total="∞" />
            <UsageRow label="Attention"       used={usage.attentionMigrations} total="∞" />
          </>
        ) : (
          <p className="text-xs text-[#6B6B6B]">Usage data unavailable.</p>
        )}
      </section>

      {/* Refund request — available for all Pro users (including cancelled-but-active) */}
      {isPro && (
        <section id="refund" className="rounded-md border border-[#2A2A2A] bg-[#111] p-5 mt-4 scroll-mt-20">
          <h2 className="text-sm font-semibold mb-2">Request a refund</h2>
          {refundDone ? (
            <p className="text-xs text-[#00D26A]">
              {refundPending
                ? "You already have a refund request pending. We'll be in touch within 2 business days."
                : "Refund request received. We'll be in touch within 2 business days."}
            </p>
          ) : !showRefund ? (
            <button
              onClick={() => setShowRefund(true)}
              className="text-xs text-[#6B6B6B] underline hover:text-[#F5F5F5]"
            >
              I&apos;d like to request a refund
            </button>
          ) : (
            <div className="space-y-3">
              <textarea
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                rows={3}
                placeholder="Tell us why you&apos;d like a refund…"
                className="w-full rounded-md border border-[#2A2A2A] bg-[#0A0A0A] px-3 py-2 text-xs text-[#F5F5F5] placeholder-[#444] outline-none focus:border-[#00D26A]/40"
              />
              <div className="flex gap-2">
                <button
                  disabled={refundSubmitting || refundReason.trim().length < 5}
                  onClick={async () => {
                    setRefundSubmitting(true);
                    try {
                      const { data: { session } } = await supabase.auth.getSession();
                      const r = await fetch("/api/payments/refund-request", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
                        body: JSON.stringify({ reason: refundReason }),
                      });
                      if (r.status === 409) {
                        setRefundPending(true);
                        setRefundDone(true);
                        return;
                      }
                      if (!r.ok) { const j = await r.json().catch(() => ({})) as { error?: string }; throw new Error(j.error ?? `HTTP ${r.status}`); }
                      setRefundDone(true);
                    } catch (e) {
                      setNotice(e instanceof Error ? e.message : "Submission failed.");
                    } finally { setRefundSubmitting(false); }
                  }}
                  className="rounded-md bg-[#00D26A] px-4 py-1.5 text-xs font-bold text-black disabled:opacity-50 hover:bg-[#00B85C]"
                >
                  {refundSubmitting ? "Submitting…" : "Submit request"}
                </button>
                <button onClick={() => setShowRefund(false)} className="text-xs text-[#6B6B6B] underline">Cancel</button>
              </div>
            </div>
          )}
        </section>
      )}

      {status !== "cancelled" && (
        <section className="rounded-md border border-[#2A2A2A] bg-[#111] p-5">
          {!confirm ? (
            <button
              onClick={() => setConfirm(true)}
              disabled={cancelling}
              className="rounded-md border border-[#00FF88] bg-transparent px-4 py-2 text-xs font-semibold uppercase tracking-wider text-[#00FF88] hover:bg-[#00FF88] hover:text-[#00FF88] disabled:opacity-50"
            >
              Cancel subscription
            </button>
          ) : (
            <div>
              <p className="text-sm mb-3">
                Cancel your subscription? You&apos;ll keep Pro features until{" "}
                <strong>{currentEnd ? formatDate(new Date(currentEnd)) : "the end of your billing cycle"}</strong>.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="rounded-md bg-[#00FF88] px-4 py-2 text-xs font-black uppercase tracking-wider text-[#00FF88] hover:opacity-90 disabled:opacity-50"
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

function planLabel(plan: string, interval?: string | null): string {
  if (plan !== "pro") return "Free";
  if (interval === "annual") return "Pro Annual";
  if (interval === "monthly") return "Pro Monthly";
  if (interval === "manual") return "Pro (Admin Grant)";
  return "Pro";
}

function statusLabel(status: string): string {
  if (status === "trialing") return "Active";
  if (status === "cancelled") return "Cancelled";
  if (status === "past_due")  return "Past due";
  if (status === "free")      return "Free";
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
  const t1limit = FREE_LIMITS.simpleMigrations    as number;
  const t2limit = FREE_LIMITS.smartMigrations     as number;
  const t3limit = FREE_LIMITS.attentionMigrations as number;
  return (
    <section className="rounded-md border border-[#2A2A2A] bg-[#111] p-5">
      <h2 className="text-sm font-semibold mb-3 text-[#F5F5F5]">Usage this month</h2>
      <div className="grid grid-cols-4 gap-x-2 pb-1 mb-1 border-b border-[#1A1A1A] text-[10px] font-mono uppercase tracking-widest text-[#3A3A3A]">
        <span>Type</span><span className="text-right">Used</span><span className="text-right">Remaining</span><span className="text-right">Limit</span>
      </div>
      <FreeUsageRow label="Full Context"    used={usage.simpleMigrations}    limit={t1limit} />
      <FreeUsageRow label="Smart Summary"   used={usage.smartMigrations}     limit={t2limit} />
      <FreeUsageRow label="Attention Engine" used={usage.attentionMigrations} limit={t3limit} />
    </section>
  );
}

function FreeUsageRow({ label, used, limit }: { label: string; used: number; limit: number }) {
  const remaining = Math.max(0, limit - used);
  return (
    <div className="grid grid-cols-4 gap-x-2 py-1.5 text-sm border-b border-[#1A1A1A] last:border-b-0">
      <span className="text-[#6B6B6B]">{label}</span>
      <span className="text-right font-mono">{used}</span>
      <span className="text-right font-mono">{remaining}</span>
      <span className="text-right font-mono">{limit}</span>
    </div>
  );
}
