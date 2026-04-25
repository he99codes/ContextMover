"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Trash2, Loader2, Copy, Check, User as UserIcon, Database } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

interface Props {
  email: string;
  userId: string;
  sessionCount: number;
}

export function SettingsView({ email, userId, sessionCount }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"signout" | "wipe" | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSignOut() {
    setBusy("signout");
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/auth");
    router.refresh();
  }

  async function handleWipe() {
    const ok = window.confirm(
      `Delete ALL ${sessionCount} sessions from the cloud? This also removes them from the browser extension. This cannot be undone.`
    );
    if (!ok) return;
    setBusy("wipe");
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("sessions")
        .delete()
        .eq("user_id", userId);
      if (error) throw new Error(error.message);
      router.refresh();
    } finally {
      setBusy(null);
    }
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

      {/* Data */}
      <section className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <Database size={15} className="text-[#6B6B6B]" />
          <h2 className="text-sm font-semibold text-[#F5F5F5]">Data</h2>
        </div>
        <p className="text-sm text-[#6B6B6B]">
          You have <strong className="text-[#F5F5F5]">{sessionCount}</strong> session{sessionCount === 1 ? "" : "s"} synced across the web dashboard and the browser extension.
        </p>
      </section>

      {/* Danger zone */}
      <section className="rounded-[8px] border border-red-500/30 bg-red-500/5 p-5">
        <h2 className="text-sm font-semibold text-red-400 mb-2">Danger zone</h2>
        <p className="text-sm text-[#6B6B6B] mb-4">
          Permanently delete every captured session. This also clears them from the browser extension via realtime sync.
        </p>
        <button
          onClick={handleWipe}
          disabled={busy !== null || sessionCount === 0}
          className="inline-flex h-9 px-3.5 items-center gap-1.5 rounded-[4px] bg-red-600/80 text-white text-sm font-medium hover:bg-red-600 disabled:opacity-50 transition-colors"
        >
          {busy === "wipe" ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          Delete all sessions
        </button>
      </section>
    </div>
  );
}
