"use client";

import { useState, useMemo } from "react";
import { Search, Layers, RefreshCw } from "lucide-react";
import { useRealtimeSessions } from "@/hooks/useRealtimeSessions";
import { SessionCard } from "./SessionCard";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

const PLATFORMS = ["All", "Claude", "ChatGPT", "Gemini", "Grok"] as const;

interface SessionListProps {
  initialSessions: Session[];
  userId: string;
}

export function SessionList({ initialSessions, userId }: SessionListProps) {
  const { sessions } = useRealtimeSessions(userId, initialSessions);
  const [filter, setFilter] = useState<string>("All");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return sessions.filter((s) => {
      const matchesPlatform =
        filter === "All" ||
        s.platform.toLowerCase() === filter.toLowerCase();
      const matchesSearch =
        !search ||
        (s.title ?? "").toLowerCase().includes(search.toLowerCase()) ||
        s.messages.some((m) =>
          m.content.toLowerCase().includes(search.toLowerCase())
        );
      return matchesPlatform && matchesSearch;
    });
  }, [sessions, filter, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: sessions.length };
    for (const p of PLATFORMS.slice(1)) {
      c[p] = sessions.filter(
        (s) => s.platform.toLowerCase() === p.toLowerCase()
      ).length;
    }
    return c;
  }, [sessions]);

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Platform filters */}
        <div className="flex items-center gap-1 flex-wrap">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              onClick={() => setFilter(p)}
              className={cn(
                "rounded-[4px] px-3 py-1 text-xs font-medium transition-all",
                filter === p
                  ? "bg-[#00FF88]/10 text-[#00FF88] border border-[#00FF88]/30 shadow-[0_0_8px_rgba(0,255,136,0.12)]"
                  : "bg-[#1A1A1A] border border-[#2A2A2A] text-[#6B6B6B] hover:text-[#F5F5F5] hover:border-[#3A3A3A]"
              )}
            >
              {p}
              {counts[p] > 0 && (
                <span
                  className={cn(
                    "ml-1.5 tabular-nums",
                    filter === p ? "text-[#00FF88]/70" : "text-[#6B6B6B]"
                  )}
                >
                  {counts[p]}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative w-full sm:w-56">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6B6B6B]"
          />
          <Input
            placeholder="Search sessions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 text-sm h-8 bg-[#1A1A1A] border-[#2A2A2A] text-[#F5F5F5] placeholder:text-[#6B6B6B] focus:border-[#00FF88] rounded-[4px]"
          />
        </div>
      </div>

      {/* List */}
      {filtered.length === 0 && sessions.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-[8px] border border-dashed border-[#2A2A2A] bg-[#111111] py-20 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[8px] bg-[#00FF88]/10 border border-[#00FF88]/20">
            <Layers size={20} className="text-[#00FF88]" />
          </div>
          <h3 className="text-sm font-medium text-[#F5F5F5]">
            No sessions captured yet
          </h3>
          <p className="mt-1.5 max-w-xs text-sm text-[#6B6B6B]">
            Install the ContextForge extension and visit Claude, ChatGPT,
            Gemini, or Grok to start capturing context.
          </p>
        </div>
      )}

      {filtered.length === 0 && sessions.length > 0 && (
        <div className="flex flex-col items-center justify-center rounded-[8px] border border-dashed border-[#2A2A2A] bg-[#111111] py-16 text-center">
          <RefreshCw size={18} className="mb-3 text-[#6B6B6B]" />
          <p className="text-sm text-[#6B6B6B]">
            No sessions match your filter.
          </p>
          <button
            onClick={() => { setFilter("All"); setSearch(""); }}
            className="mt-2 text-xs text-[#00FF88] hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}
