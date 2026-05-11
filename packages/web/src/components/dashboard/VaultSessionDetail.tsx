"use client";

import { useState, useEffect } from "react";
import { notFound } from "next/navigation";
import { getUserVaultClient, isVaultConnected, syncVaultConfigFromUrl } from "@/lib/user-vault/web-client";
import { SessionDetailView } from "@/components/dashboard/SessionDetailView";
import { Lock } from "lucide-react";
import Link from "next/link";
import type { Session } from "@/types";

interface Props {
  sessionId: string;
}

interface VaultRow {
  id: string;
  platform: string;
  title: string | null;
  messages: Session["messages"];
  captured_at: string;
  updated_at: string;
}

export function VaultSessionDetail({ sessionId }: Props) {
  const [session, setSession] = useState<Session | null | undefined>(undefined); // undefined = loading
  const [vaultReady, setVaultReady] = useState<boolean | null>(null);

  useEffect(() => {
    syncVaultConfigFromUrl();
    const connected = isVaultConnected();
    setVaultReady(connected);
    if (!connected) return;

    const client = getUserVaultClient();
    if (!client) return;

    client
      .from("cm_sessions")
      .select("id, platform, title, messages, captured_at, updated_at")
      .eq("id", sessionId)
      .single()
      .then(({ data }) => {
        if (!data) { setSession(null); return; }
        const row = data as VaultRow;
        setSession({
          id: row.id,
          user_id: "vault",
          platform: row.platform as Session["platform"],
          title: row.title,
          messages: row.messages ?? [],
          created_at: row.captured_at,
          updated_at: row.updated_at,
        });
      });
  }, [sessionId]);

  if (vaultReady === null || session === undefined) {
    return <div className="flex items-center justify-center py-32 text-xs font-mono text-[#2A4A2A] uppercase tracking-widest animate-pulse">Loading…</div>;
  }

  if (!vaultReady) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center">
        <Lock size={22} className="mb-4 text-[#00FF88]" />
        <p className="text-sm font-black uppercase tracking-widest text-[#F5F5F5]">Vault not connected</p>
        <p className="mt-2 text-xs font-mono text-[#2A4A2A]">Connect your personal Supabase vault to view sessions here.</p>
        <Link href="/settings/vault" className="mt-5 text-xs text-[#00FF88] hover:opacity-70 transition-opacity">Set up vault →</Link>
      </div>
    );
  }

  if (session === null) {
    return notFound();
  }

  return <SessionDetailView session={session} />;
}
