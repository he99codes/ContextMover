"use client";

import { useState, useEffect } from "react";
import { MessageSquare, Layers, Clock, Database, ExternalLink, RefreshCw } from "lucide-react";
import Link from "next/link";
import { getUserVaultClient, isVaultConnected, syncVaultConfigFromUrl } from "@/lib/user-vault/web-client";
import { cn } from "@/lib/utils";

const PLATFORM_COLORS: Record<string, string> = {
  claude:     "bg-[#D97706]",
  chatgpt:    "bg-[#10B981]",
  gemini:     "bg-[#6366F1]",
  grok:       "bg-[#F5F5F5]",
  perplexity: "bg-[#20B2AA]",
  deepseek:   "bg-[#4C8BF5]",
};

const PLATFORMS = ["claude", "chatgpt", "gemini", "grok", "perplexity", "deepseek"] as const;

interface VaultSession {
  id: string;
  platform: string;
  title: string | null;
  messages: { role: string }[] | null;
  captured_at: string;
  updated_at: string;
}

function SkeletonBar({ w }: { w: string }) {
  return <div className={`h-2 rounded-full bg-[#1A1A1A] animate-pulse ${w}`} />;
}

export default function AnalyticsPage() {
  const [sessions, setSessions] = useState<VaultSession[]>([]);
  const [loading, setLoading]   = useState(true);
  const [vaultOk, setVaultOk]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    syncVaultConfigFromUrl();

    if (!isVaultConnected()) {
      setVaultOk(false);
      setLoading(false);
      return;
    }

    setVaultOk(true);
    const client = getUserVaultClient();
    if (!client) { setLoading(false); return; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error: err } = await (client as any)
      .from("cf_sessions")
      .select("id, platform, title, messages, captured_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(500);

    if (err) { setError(err.message); } else { setSessions(data ?? []); }
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  const totalMessages = sessions.reduce((sum, s) => sum + (s.messages?.length ?? 0), 0);
  const byPlatform    = sessions.reduce<Record<string, number>>((acc, s) => {
    const p = s.platform.toLowerCase();
    acc[p] = (acc[p] ?? 0) + 1;
    return acc;
  }, {});
  const maxCount = Math.max(1, ...PLATFORMS.map((p) => byPlatform[p] ?? 0));

  const lastCapture = sessions[0]
    ? new Date(sessions[0].updated_at).toLocaleString()
    : "—";

  const stats = [
    { label: "Total sessions",  value: sessions.length, icon: Layers,        tint: "text-[#00FF88] bg-[#00FF88]/10 border-[#00FF88]/20" },
    { label: "Total messages",  value: totalMessages,   icon: MessageSquare, tint: "text-[#10B981] bg-[#10B981]/10 border-[#10B981]/20" },
    { label: "Platforms used",  value: Object.keys(byPlatform).length, icon: Database, tint: "text-[#D97706] bg-[#D97706]/10 border-[#D97706]/20" },
    { label: "Last capture",    value: lastCapture,     icon: Clock,         tint: "text-[#6366F1] bg-[#6366F1]/10 border-[#6366F1]/20", isText: true },
  ];

  if (!vaultOk && !loading) {
    return (
      <div className="max-w-xl mx-auto p-10 text-center">
        <div className="inline-flex h-14 w-14 items-center justify-center rounded-[10px] border border-[#2A2A2A] bg-[#1A1A1A] mb-5">
          <Database size={22} className="text-[#6B6B6B]" />
        </div>
        <h2 className="text-lg font-semibold text-[#F5F5F5] mb-2">Connect your Personal Vault to see analytics</h2>
        <p className="text-sm text-[#6B6B6B] mb-6 leading-relaxed">
          Session data lives in your own Supabase vault — not on our servers.
          Connect it to unlock usage analytics, platform breakdowns, and capture history.
        </p>
        <Link
          href="/settings/vault"
          className="inline-flex items-center gap-2 rounded-[6px] bg-[#00FF88] px-5 py-2.5 text-sm font-semibold text-black hover:bg-[#00CC6A] transition-colors"
        >
          Set up Personal Vault <ExternalLink size={13} />
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[#F5F5F5]">Analytics</h1>
          <p className="mt-1 text-sm text-[#6B6B6B]">
            Platform breakdowns and session history from your personal vault.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-[6px] border border-[#2A2A2A] px-3 py-1.5 text-xs text-[#6B6B6B] hover:text-[#F5F5F5] hover:border-[#3A3A3A] transition-all disabled:opacity-40"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {stats.map((s) => (
          <div key={s.label} className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-5">
            <div className={cn("inline-flex h-8 w-8 items-center justify-center rounded-[4px] mb-3 border", s.tint)}>
              <s.icon size={15} />
            </div>
            {loading ? (
              <div className="space-y-1.5 mt-1"><SkeletonBar w="w-12" /><SkeletonBar w="w-20" /></div>
            ) : (
              <>
                <p className="text-2xl font-semibold text-[#F5F5F5] tabular-nums truncate">
                  {s.value}
                </p>
                <p className="text-xs text-[#6B6B6B] mt-1">{s.label}</p>
              </>
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-[6px] border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-400">
          Vault error: {error}
        </div>
      )}

      {/* Platform breakdown + recent */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-5">
          <h2 className="text-sm font-semibold text-[#F5F5F5] mb-4">Sessions by platform</h2>
          {loading ? (
            <div className="space-y-3">
              {PLATFORMS.map((p) => (
                <div key={p} className="space-y-1">
                  <SkeletonBar w="w-24" />
                  <div className="h-1.5 rounded-full bg-[#2A2A2A] overflow-hidden">
                    <div className="h-full bg-[#1A1A1A] animate-pulse rounded-full" style={{ width: "40%" }} />
                  </div>
                </div>
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-[#6B6B6B]">No sessions captured yet. Install the extension and start chatting.</p>
          ) : (
            <div className="space-y-3">
              {PLATFORMS.map((p) => {
                const count = byPlatform[p] ?? 0;
                const pct   = Math.round((count / maxCount) * 100);
                if (count === 0) return null;
                return (
                  <div key={p}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium text-[#F5F5F5] capitalize">{p}</span>
                      <span className="text-[#6B6B6B] tabular-nums">{count}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[#2A2A2A] overflow-hidden">
                      <div
                        className={cn("h-full rounded-full transition-all duration-500", PLATFORM_COLORS[p])}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-5">
          <h2 className="text-sm font-semibold text-[#F5F5F5] mb-4">Recent captures</h2>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 py-1">
                  <SkeletonBar w="w-16" />
                  <SkeletonBar w="w-32" />
                  <SkeletonBar w="w-14 ml-auto" />
                </div>
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-[#6B6B6B]">No sessions yet.</p>
          ) : (
            <ul className="divide-y divide-[#2A2A2A]">
              {sessions.slice(0, 8).map((s) => (
                <li key={s.id} className="py-2 flex items-center gap-2 text-sm">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: PLATFORM_COLORS[s.platform.toLowerCase()]?.replace("bg-[", "").replace("]", "") ?? "#6B6B6B" }} />
                  <span className="capitalize text-[#F5F5F5] font-medium">{s.platform}</span>
                  <span className="truncate text-[#6B6B6B] text-[11px] flex-1 min-w-0">
                    {s.title ?? "Untitled session"}
                  </span>
                  <span className="ml-auto text-[11px] text-[#6B6B6B] shrink-0 tabular-nums">
                    {new Date(s.updated_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
