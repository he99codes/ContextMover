import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { MessageSquare, Layers, ArrowLeftRight, Clock } from "lucide-react";
import type { Session, Migration } from "@/types";
import { cn, formatRelativeTime } from "@/lib/utils";

const PLATFORM_COLORS: Record<string, string> = {
  claude:     "bg-[#D97706]",
  chatgpt:    "bg-[#10B981]",
  gemini:     "bg-[#6366F1]",
  grok:       "bg-[#F5F5F5]",
  perplexity: "bg-[#20B2AA]",
  deepseek:   "bg-[#4C8BF5]",
};

export default async function AnalyticsPage() {
  if (!isSupabaseConfigured()) return null;
  const supabase = createClient();

  const [{ data: sessionData }, { data: migrationData }] = await Promise.all([
    supabase.from("sessions").select("*").order("updated_at", { ascending: false }),
    supabase.from("migrations").select("*").order("migrated_at", { ascending: false }).limit(20),
  ]);

  const sessions = (sessionData ?? []) as Session[];
  const migrations = (migrationData ?? []) as Migration[];

  const totalMessages = sessions.reduce((sum, s) => sum + (s.messages?.length ?? 0), 0);
  const byPlatform = sessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.platform] = (acc[s.platform] ?? 0) + 1;
    return acc;
  }, {});
  const platforms = ["claude", "chatgpt", "gemini", "grok", "perplexity", "deepseek"] as const;
  const maxCount = Math.max(1, ...platforms.map((p) => byPlatform[p] ?? 0));

  const stats = [
    { label: "Total sessions",  value: sessions.length,   icon: Layers,          tint: "text-[#00FF88] bg-[#00FF88]/10 border border-[#00FF88]/20" },
    { label: "Total messages",  value: totalMessages,     icon: MessageSquare,   tint: "text-[#10B981] bg-[#10B981]/10 border border-[#10B981]/20" },
    { label: "Migrations",      value: migrations.length, icon: ArrowLeftRight,  tint: "text-[#D97706] bg-[#D97706]/10 border border-[#D97706]/20" },
    {
      label: "Last capture",
      value: sessions[0] ? formatRelativeTime(sessions[0].updated_at) : "—",
      icon: Clock,
      tint: "text-[#6366F1] bg-[#6366F1]/10 border border-[#6366F1]/20",
      isText: true,
    },
  ] as const;

  return (
    <div className="max-w-6xl mx-auto p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[#F5F5F5]">Analytics</h1>
        <p className="mt-1 text-sm text-[#6B6B6B]">
          Platform breakdowns and recent activity across your ContextForge workspace.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {stats.map((s) => (
          <div key={s.label} className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-5">
            <div className={cn("inline-flex h-8 w-8 items-center justify-center rounded-[4px] mb-3", s.tint)}>
              <s.icon size={15} />
            </div>
            <p className="text-2xl font-semibold text-[#F5F5F5] tabular-nums">
              {s.value}
            </p>
            <p className="text-xs text-[#6B6B6B] mt-1">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Platform breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A] p-5">
          <h2 className="text-sm font-semibold text-[#F5F5F5] mb-4">Sessions by platform</h2>
          {sessions.length === 0 ? (
            <p className="text-sm text-[#6B6B6B]">No sessions captured yet.</p>
          ) : (
            <div className="space-y-3">
              {platforms.map((p) => {
                const count = byPlatform[p] ?? 0;
                const pct = Math.round((count / maxCount) * 100);
                return (
                  <div key={p}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium text-[#F5F5F5] capitalize">{p}</span>
                      <span className="text-[#6B6B6B] tabular-nums">{count}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[#2A2A2A] overflow-hidden">
                      <div
                        className={cn("h-full rounded-full transition-all", PLATFORM_COLORS[p])}
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
          <h2 className="text-sm font-semibold text-[#F5F5F5] mb-4">Recent migrations</h2>
          {migrations.length === 0 ? (
            <p className="text-sm text-[#6B6B6B]">
              No migrations yet. Use the sidebar in the browser extension or the Migrate page.
            </p>
          ) : (
            <ul className="divide-y divide-[#2A2A2A]">
              {migrations.slice(0, 8).map((m) => (
                <li key={m.id} className="py-2 flex items-center gap-2 text-sm">
                  <span className="capitalize text-[#F5F5F5] font-medium">{m.source_platform ?? "?"}</span>
                  <ArrowLeftRight size={12} className="text-[#6B6B6B]" />
                  <span className="capitalize text-[#F5F5F5] font-medium">{m.target_platform ?? "?"}</span>
                  <span className="ml-auto text-[11px] text-[#6B6B6B]">
                    {formatRelativeTime(m.migrated_at)}
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
