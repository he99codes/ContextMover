"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { useState, useEffect, useMemo } from "react";
import { Search, Layers, RefreshCw, Lock, ExternalLink } from "lucide-react";
import Link from "next/link";
import { getUserVaultClient, isVaultConnected, syncVaultConfigFromUrl } from "@/lib/user-vault/web-client";
import { SessionCard } from "./SessionCard";
import { PlatformLogo, PLATFORM_COLORS as PCOLORS } from "@/components/ui/PlatformLogo";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";
import type { RealtimeChannel } from "@supabase/supabase-js";

const PLATFORMS = [
  { key: "All",        label: "All",          logoKey: null },
  { key: "Claude",     label: "Claude",        logoKey: "claude" },
  { key: "ChatGPT",    label: "ChatGPT",       logoKey: "chatgpt" },
  { key: "Gemini",     label: "Google Gemini", logoKey: "gemini" },
  { key: "Grok",       label: "xAI Grok",      logoKey: "grok" },
  { key: "Perplexity", label: "Perplexity",    logoKey: "perplexity" },
  { key: "DeepSeek",   label: "DeepSeek",      logoKey: "deepseek" },
] as const;

interface VaultRow {
  id: string;
  platform: string;
  title: string | null;
  messages: Session["messages"];
  captured_at: string;
  updated_at: string;
}

function rowToSession(row: VaultRow): Session {
  return {
    id: row.id,
    user_id: "vault",
    platform: row.platform as Session["platform"],
    title: row.title,
    messages: row.messages ?? [],
    created_at: row.captured_at,
    updated_at: row.updated_at,
  };
}

export function VaultSessionList() {
  const [vaultReady, setVaultReady] = useState<boolean | null>(null); // null = loading
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>("All");
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);

  useEffect(() => {
    // Sync vault config from URL params if extension passed them.
    syncVaultConfigFromUrl();
    setVaultReady(isVaultConnected());
  }, []);

  useEffect(() => {
    if (!vaultReady) return;
    let channel: RealtimeChannel | null = null;

    const client = getUserVaultClient();
    if (!client) return;

    async function load() {
      setLoading(true);
      const { data } = await client!
        .from("cm_sessions")
        .select("id, platform, title, messages, captured_at, updated_at")
        .order("updated_at", { ascending: false });
      setSessions((data as VaultRow[] ?? []).map(rowToSession));
      setLoading(false);
    }

    void load();

    // Realtime updates from user's own Supabase.
    channel = client
      .channel("cm-sessions-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "cm_sessions" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setSessions((prev) => [rowToSession(payload.new as VaultRow), ...prev]);
          } else if (payload.eventType === "UPDATE") {
            setSessions((prev) =>
              prev.map((s) => s.id === (payload.new as VaultRow).id ? rowToSession(payload.new as VaultRow) : s)
            );
          } else if (payload.eventType === "DELETE") {
            setSessions((prev) => prev.filter((s) => s.id !== (payload.old as { id: string }).id));
          }
        }
      )
      .subscribe();

    return () => { if (channel) void client.removeChannel(channel); };
  }, [vaultReady]);

  const filtered = useMemo(() => sessions.filter((s) => {
    const matchesPlatform =
      filter === "All" ||
      s.platform.toLowerCase() === filter.toLowerCase().replace("google ", "").replace("xai ", "");
    const matchesSearch =
      !search ||
      (s.title ?? "").toLowerCase().includes(search.toLowerCase()) ||
      s.messages.some((m) => m.content.toLowerCase().includes(search.toLowerCase()));
    return matchesPlatform && matchesSearch;
  }), [sessions, filter, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: sessions.length };
    for (const p of PLATFORMS.slice(1)) {
      c[p.key] = sessions.filter((s) => s.platform.toLowerCase() === p.key.toLowerCase()).length;
    }
    return c;
  }, [sessions]);

  // Loading state
  if (vaultReady === null) {
    return <div className="flex items-center justify-center py-32 text-xs font-mono text-[#2A2A2A] uppercase tracking-widest animate-pulse">Checking vault…</div>;
  }

  // Not connected
  if (!vaultReady) {
    return (
      <div className="flex flex-col items-center justify-center rounded-[10px] border border-dashed py-20 text-center animate-fade-in" style={{ borderColor: "rgba(0,255,136,0.18)", background: "rgba(0,255,136,0.012)" }}>
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-[10px] border border-[#00FF88]/25 bg-[#00FF88]/5" style={{ boxShadow: "0 0 20px rgba(0,255,136,0.1)" }}>
          <Lock size={22} className="text-[#00FF88]" />
        </div>
        <h3 className="text-sm font-black uppercase tracking-widest text-[#F5F5F5]">Your sessions are stored locally</h3>
        <p className="mt-2 max-w-sm text-xs font-mono text-[#2A2A2A] leading-relaxed">
          Your conversations live in the browser extension&apos;s local storage.<br />
          Connect your personal Supabase vault to view sessions here and unlock Super Memory.
        </p>
        <Link
          href="/settings/vault"
          className="mt-6 inline-flex items-center gap-2 rounded-[6px] border border-[#00FF88]/30 bg-[#00FF88]/8 px-5 py-2.5 text-xs font-black uppercase tracking-[0.14em] text-[#00FF88] transition-all hover:bg-[#00FF88]/12 hover:scale-[1.02]"
        >
          Connect Personal Vault →
        </Link>
        <p className="mt-3 text-[10px] font-mono text-[#1A1A1A]">Free · Takes 45 seconds · Your data stays in YOUR Supabase account</p>
      </div>
    );
  }

  return (
    <div>
      {/* Vault connected indicator */}
      <div className="mb-5 flex items-center gap-2 rounded-[6px] border border-[#00FF88]/15 bg-[#00FF88]/5 px-3 py-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[#00FF88] animate-pulse-green" style={{ boxShadow: "0 0 6px #00FF88" }} />
        <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[#00FF88]">Connected to your vault</span>
        <Link href="/settings/vault" className="ml-auto text-[10px] font-mono text-[#6B6B6B] hover:text-[#00FF88] transition-colors flex items-center gap-1">
          Manage <ExternalLink size={9} />
        </Link>
      </div>

      {/* Platform filter tabs */}
      <div className="mb-7 flex flex-col gap-4">
        <div className="flex items-center gap-0 border-b border-[#2A2A2A] overflow-x-auto" style={{ background: "linear-gradient(to right, #050505, #081208, #050505)" }}>
          {PLATFORMS.map((p) => {
            const isActive = filter === p.key;
            const color = p.logoKey ? (PCOLORS[p.logoKey] ?? "#6B6B6B") : "#00FF88";
            return (
              <button
                key={p.key}
                onClick={() => setFilter(p.key)}
                className={cn(
                  "relative flex shrink-0 items-center gap-2 px-4 pb-3 pt-2 text-[10px] font-black uppercase tracking-[0.14em] transition-all duration-150 whitespace-nowrap",
                  isActive ? "text-[#F5F5F5]" : "text-[#2A2A2A] hover:text-[#4A8A4A]"
                )}
                style={isActive ? { color } : {}}
              >
                {p.logoKey && <PlatformLogo platform={p.logoKey} size={12} />}
                {p.label}
                {counts[p.key] > 0 && <span className="tabular-nums opacity-55">{counts[p.key]}</span>}
                <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-full transition-all duration-300" style={{ background: color, opacity: isActive ? 1 : 0, transform: isActive ? "scaleX(1)" : "scaleX(0)", transformOrigin: "left", boxShadow: isActive ? `0 0 8px ${color}` : "none" }} />
              </button>
            );
          })}
        </div>
        <div className="relative">
          <Search size={13} className={cn("absolute left-3 top-1/2 -translate-y-1/2 transition-colors duration-150", searchFocused ? "text-[#00FF88]" : "text-[#6B6B6B]")} />
          <input
            placeholder="Search sessions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            className={cn("w-full rounded-[5px] border bg-[#080808] py-3 pl-9 pr-4 text-sm font-mono text-[#F5F5F5] placeholder:text-[#1A1A1A] outline-none transition-all duration-150", searchFocused ? "border-[#00FF88] shadow-[0_0_0_2px_rgba(0,255,136,0.1)]" : "border-[#2A2A2A] hover:border-[#2A2A2A]")}
          />
        </div>
      </div>

      {/* Empty states */}
      {loading && (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-20 rounded-[6px] border border-[#2A2A2A] bg-[#080808] animate-pulse" />)}
        </div>
      )}

      {!loading && filtered.length === 0 && sessions.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-[8px] border border-dashed py-24 text-center animate-fade-in neon-border-pulse" style={{ background: "#070707" }}>
          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-[10px] border border-[#00FF88]/25 bg-[#00FF88]/5">
            <Layers size={20} className="text-[#00FF88]" />
          </div>
          <h3 className="text-sm font-black uppercase tracking-widest text-[#F5F5F5]">No sessions in your vault yet</h3>
          <p className="mt-1.5 max-w-xs text-xs font-mono text-[#2A2A2A]">
            Install the extension and visit Claude, ChatGPT, Gemini, Grok, Perplexity, or DeepSeek.
          </p>
        </div>
      )}

      {!loading && filtered.length === 0 && sessions.length > 0 && (
        <div className="flex flex-col items-center justify-center rounded-[8px] border border-dashed py-20 text-center animate-fade-in" style={{ background: "#070707" }}>
          <RefreshCw size={18} className="mb-3 text-[#6B6B6B]" />
          <p className="text-xs font-mono uppercase tracking-wider text-[#2A2A2A]">No sessions match your filter.</p>
          <button onClick={() => { setFilter("All"); setSearch(""); }} className="mt-2 text-xs text-[#00FF88] hover:opacity-70 transition-opacity">Clear filters</button>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map((session) => <SessionCard key={session.id} session={session} />)}
        </div>
      )}

      {/* THE CRUCIBLE */}
      <div className="mt-4">
        <div className="crucible-pulse flex cursor-default flex-col items-center justify-center rounded-[8px] border border-dashed py-6 transition-all hover:scale-[1.004]" style={{ borderColor: "rgba(0,255,136,0.16)", background: "rgba(0,255,136,0.014)" }}>
          <div className="text-[11px] font-black uppercase tracking-[0.4em] text-[#00FF88]" style={{ textShadow: "0 0 10px rgba(0,255,136,0.45)" }}>⚗ The Crucible</div>
          <div className="mt-1.5 text-[10px] font-mono uppercase tracking-[0.2em] text-[#1A1A1A]">Merge sessions · Forge Super Memory</div>
          <div className="mt-1.5 text-[8px] font-black uppercase tracking-[0.3em] text-[#00FF88]/40">Coming in v3</div>
        </div>
      </div>
    </div>
  );
}
