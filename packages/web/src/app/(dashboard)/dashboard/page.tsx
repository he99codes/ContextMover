import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { getCachedUser } from "@/lib/supabase/cached";
import { SessionList } from "@/components/dashboard/SessionList";
import type { Session } from "@/types";

const PLATFORM_META = [
  { id: "claude",     label: "Claude",     color: "#D97706" },
  { id: "chatgpt",    label: "ChatGPT",    color: "#10B981" },
  { id: "gemini",     label: "Google Gemini", color: "#6366F1" },
  { id: "grok",       label: "xAI Grok",      color: "#F5F5F5" },
  { id: "perplexity", label: "Perplexity", color: "#20B2AA" },
  { id: "deepseek",   label: "DeepSeek",   color: "#4C8BF5" },
] as const;

export default async function DashboardPage() {
  if (!isSupabaseConfigured()) return null;

  const [supabase, user] = [createClient(), await getCachedUser()];
  const { data: sessionData } = await supabase
    .from("sessions")
    .select("id, title, platform, updated_at, created_at, messages")
    .order("updated_at", { ascending: false });

  const sessions = (sessionData ?? []) as Session[];

  const byPlatform = PLATFORM_META.map((p) => ({
    ...p,
    count: sessions.filter((s) => s.platform === p.id).length,
  }));

  const totalMessages = sessions.reduce((sum, s) => sum + (s.messages?.length ?? 0), 0);

  return (
    <div className="p-10">
      <div className="mb-10">
        <div className="flex items-end justify-between gap-6">
          <div>
            <h1 className="text-2xl font-black uppercase text-[#00FF88]" style={{ letterSpacing: "0.14em", textShadow: "0 0 24px rgba(0,255,136,0.35)" }}>
              Sessions
            </h1>
            <p className="mt-1 text-xs font-mono uppercase text-[#2A6A2A]" style={{ letterSpacing: "0.12em" }}>
              {sessions.length > 0
                ? `${sessions.length} captured · ${totalMessages} messages`
                : "Waiting for sessions from the extension"}
            </p>
          </div>

          {/* Platform stat pills */}
          {sessions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {byPlatform.filter((p) => p.count > 0).map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 rounded-[5px] border px-3.5 py-2 text-[10px] font-black uppercase tracking-wider transition-all hover:scale-[1.04] hover:-translate-y-px"
                  style={{
                    borderColor: `${p.color}40`,
                    background: `${p.color}0C`,
                    color: p.color,
                    boxShadow: `0 0 10px ${p.color}18`,
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full animate-pulse-green"
                    style={{ background: p.color, boxShadow: `0 0 5px ${p.color}` }}
                  />
                  {p.label}
                  <span className="tabular-nums opacity-70">{p.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <SessionList
        initialSessions={sessions}
        userId={user?.id ?? ""}
      />
    </div>
  );
}
