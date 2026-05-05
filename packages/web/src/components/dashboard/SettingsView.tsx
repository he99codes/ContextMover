"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Loader2, Copy, Check, User as UserIcon, Database, ExternalLink, Shield } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";

interface Props {
  email: string;
  userId: string;
}

export function SettingsView({ email, userId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"signout" | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSignOut() {
    setBusy("signout");
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/auth");
    router.refresh();
  }

  async function copyUserId() {
    await navigator.clipboard.writeText(userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="max-w-3xl mx-auto p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[#F5F5F5]">Settings</h1>
        <p className="mt-1 text-sm text-[#6B6B6B]">
          Your account and workspace preferences.
        </p>
      </div>

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
            Your session data is <strong className="text-[#F5F5F5]">never stored on ContextForge servers</strong>.
            It lives in the extension's local IndexedDB and, optionally, your own personal Supabase vault.
          </p>
        </div>
        <Link
          href="/settings/vault"
          className="inline-flex items-center gap-1.5 text-sm text-[#00FF88] hover:opacity-70 transition-opacity"
        >
          Manage Personal Vault <ExternalLink size={12} />
        </Link>
      </section>
    </div>
  );
}
