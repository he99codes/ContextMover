"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Zap, CreditCard, RotateCcw, Check } from "lucide-react";
import { useSubscription } from "@/hooks/useSubscription";

export function ManagePlanCard() {
  // VV: Use the cached useSubscription hook for all subscription data.
  // No more duplicate /api/payments/subscription fetch.
  const { isPro, loading, interval, status: subStatus, currentEnd } = useSubscription();
  const [daysLeft, setDaysLeft] = useState<number | null>(null);

  // Compute daysLeft from currentEnd (no API call needed)
  useEffect(() => {
    if (!isPro || !currentEnd) {
      setDaysLeft(null);
      return;
    }
    const diff = (new Date(currentEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    setDaysLeft(Math.max(0, Math.ceil(diff)));
  }, [isPro, currentEnd]);

  const planLabel = !isPro ? "Free Plan" : interval === "annual" ? "Pro Annual" : interval === "monthly" ? "Pro Monthly" : interval === "manual" ? "Pro (Admin Grant)" : "Pro";
  const isCancelled = subStatus === "cancelled";
  const badgeText = isCancelled ? "Cancelled" : "Active";
  const badgeColor = isCancelled ? "text-[#EAB308] border-[#EAB308]/30" : "text-[#00FF88] border-[#00FF88]/30";

  if (loading) {
    return (
      <div className="rounded-[10px] border border-[#2A2A2A] bg-[#1A1A1A] p-6 mb-6 animate-pulse h-32" />
    );
  }

  if (!isPro) {
    return (
      <div className="rounded-[10px] border border-[#2A2A2A] bg-[#1A1A1A] p-6 mb-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-[6px] border border-[#2A2A2A] bg-[#111]">
            <Zap size={15} className="text-[#6B6B6B]" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[#F5F5F5]">Free Plan</p>
            <p className="text-xs text-[#6B6B6B]">Upgrade to unlock all features</p>
          </div>
        </div>
        <Link
          href="/pricing"
          className="inline-flex items-center gap-1.5 rounded-[6px] bg-[#00FF88] px-4 py-2 text-xs font-semibold text-black hover:bg-[#00D26A] transition-colors"
        >
          <Zap size={12} /> Upgrade to Pro
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-[10px] border border-[rgba(0,255,136,0.2)] bg-[rgba(0,255,136,0.04)] p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-[6px] bg-[#00FF88]/10 border border-[#00FF88]/20">
            <Check size={15} className="text-[#00FF88]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-[#F5F5F5]">{planLabel}</p>
              <span className={`text-[9px] font-mono uppercase tracking-widest ${badgeColor} border px-1.5 py-0.5 rounded-[3px]`}>{badgeText}</span>
            </div>
            {daysLeft !== null && (
              <p className="text-xs text-[#6B6B6B] mt-0.5">
                {daysLeft > 365 ? "Lifetime access" : daysLeft > 0 ? `${daysLeft} days${isCancelled ? " until expiry" : " remaining"}` : isCancelled ? "Expired" : "Renewing soon"}
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          href="/settings/billing"
          className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#2A2A2A] px-3 py-1.5 text-xs font-medium text-[#F5F5F5] hover:border-[rgba(0,255,136,0.3)] hover:text-[#00FF88] transition-all"
        >
          <CreditCard size={12} /> Manage Billing
        </Link>
        {!isCancelled && (
          <Link
            href="/settings/billing#refund"
            className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#2A2A2A] px-3 py-1.5 text-xs font-medium text-[#6B6B6B] hover:border-[rgba(0,255,136,0.2)] hover:text-[#00FF88]/70 transition-all"
          >
            <RotateCcw size={12} /> Request Refund
          </Link>
        )}
      </div>
    </div>
  );
}
