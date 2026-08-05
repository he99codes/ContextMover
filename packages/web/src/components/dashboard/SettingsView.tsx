"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Loader2, Copy, Check, User as UserIcon, Database, ExternalLink, Shield, CreditCard, Trash2, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { PaymentStatusBanner } from "@/components/dashboard/PaymentStatusBanner";

interface Props {
  email: string;
  userId: string;
}

export function SettingsView({ email, userId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"signout" | "delete" | null>(null);
  const [deleteStep, setDeleteStep] = useState<"idle" | "confirm">("idle");
  const [copied, setCopied] = useState(false);

  async function handleSignOut() {
    setBusy("signout");
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/auth");
    router.refresh();
  }

  async function handleDeleteAccount() {
    setBusy("delete");
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/?deleted=1");
    router.refresh();
  }

  async function copyUserId() {
    await navigator.clipboard.writeText(userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="max-w-3xl mx-auto p-8">
      {/* Payment success / cancel banner — auto-dismisses after 5s */}
      <Suspense fallback={null}>
        <PaymentStatusBanner />
      </Suspense>

      {/* Account */}
      <section className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <UserIcon size={15} className="text-[#6B6B6B]" />
          <h2 className="text-sm font-semibold text-[#F5F5F5]">Account</h2>
        </div>
        <dl className="space-y-3">
          <div className="flex items-center justify-between gap-4 text-sm">
            <dt className="text-[#6B6B6B]">Email</dt>
            <dd className="font-medium text-[#F5F5F5]">{email}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 text-sm">
            <dt className="text-[#6B6B6B]">User ID</dt>
            <dd className="flex items-center gap-2">
              <code className="text-xs text-[#F5F5F5]/70 font-mono">{userId}</code>
              <button
                onClick={copyUserId}
                className="text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors"
                title="Copy user ID"
              >
                {copied ? <Check size={13} className="text-[#00FF88]" /> : <Copy size={13} />}
              </button>
            </dd>
          </div>
        </dl>
        <div className="mt-5 pt-4 border-t border-[#2A2A2A]">
          <button
            onClick={handleSignOut}
            disabled={busy !== null}
            className="inline-flex h-9 px-3.5 items-center gap-1.5 rounded-[4px] border border-[#2A2A2A] text-sm font-medium text-[#F5F5F5] hover:bg-[#2A2A2A] disabled:opacity-50 transition-colors"
          >
            {busy === "signout" ? <Loader2 size={13} className="animate-spin" /> : <LogOut size={13} />}
            Sign out
          </button>
        </div>
      </section>

      {/* Data — Vault */}
      <section className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <Database size={15} className="text-[#6B6B6B]" />
          <h2 className="text-sm font-semibold text-[#F5F5F5]">Data &amp; Vault</h2>
        </div>
        <div className="flex items-start gap-3 rounded-[6px] border border-[#00FF88]/15 bg-[#00FF88]/5 p-3 mb-4">
          <Shield size={14} className="mt-0.5 shrink-0 text-[#00FF88]" />
          <p className="text-xs text-[#6B6B6B] leading-relaxed">
            Your session data is <strong className="text-[#F5F5F5]">never stored on ContextMover servers</strong>.
            It lives in the extension&apos;s local IndexedDB and, optionally, your own personal Supabase vault.
          </p>
        </div>
        <Link
          href="/settings/vault"
          className="inline-flex items-center gap-1.5 text-sm text-[#00FF88] hover:opacity-70 transition-opacity"
        >
          Manage Personal Vault <ExternalLink size={12} />
        </Link>
      </section>

      {/* Billing */}
      <section className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <CreditCard size={15} className="text-[#6B6B6B]" />
          <h2 className="text-sm font-semibold text-[#F5F5F5]">Billing</h2>
        </div>
        <div className="flex items-center justify-between gap-4 text-sm mb-4">
          <div>
            <p className="text-[#F5F5F5] font-medium">Free plan</p>
            <p className="text-xs text-[#6B6B6B] mt-0.5">10 sessions · Full Context + Smart Summary</p>
          </div>
          <Link
            href="/pricing"
            className="shrink-0 inline-flex items-center gap-1.5 rounded-[4px] bg-[#00FF88] px-3 py-1.5 text-xs font-semibold text-black hover:bg-[#00D26A] transition-colors"
          >
            Upgrade to Pro
          </Link>
        </div>
        <p className="text-[10px] text-[#3A3A3A]">
          Questions about billing? <a href="mailto:hey@contextmover.com" className="text-[#00FF88]/60 hover:text-[#00FF88]">hey@contextmover.com</a>
        </p>
      </section>

      {/* Danger Zone */}
      <section className="rounded-[8px] border border-[#FF4444]/20 bg-[#1A1A1A] p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle size={15} className="text-[#FF4444]" />
          <h2 className="text-sm font-semibold text-[#FF4444]">Danger Zone</h2>
        </div>
        {deleteStep === "idle" ? (
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-[#F5F5F5] font-medium">Delete account</p>
              <p className="text-xs text-[#6B6B6B] mt-0.5">Permanently removes your account and all associated data.</p>
            </div>
            <button
              onClick={() => setDeleteStep("confirm")}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-[4px] border border-[#FF4444]/40 px-3 py-1.5 text-xs font-medium text-[#FF4444] hover:bg-[#FF4444]/10 transition-colors"
            >
              <Trash2 size={12} />
              Delete
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-[#F5F5F5]">Are you sure? <strong>This cannot be undone.</strong></p>
            <p className="text-xs text-[#6B6B6B]">
              Your account will be signed out immediately. Email <a href="mailto:hey@contextmover.com" className="text-[#FF4444] hover:underline">hey@contextmover.com</a> to complete deletion — we&apos;ll purge all data within 48 hours.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleDeleteAccount}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-[4px] bg-[#FF4444] px-4 py-2 text-xs font-semibold text-black hover:bg-[#00FF88] disabled:opacity-50 transition-colors"
              >
                {busy === "delete" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                Yes, delete my account
              </button>
              <button
                onClick={() => setDeleteStep("idle")}
                className="inline-flex items-center rounded-[4px] border border-[#2A2A2A] px-4 py-2 text-xs font-medium text-[#6B6B6B] hover:text-[#F5F5F5] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
