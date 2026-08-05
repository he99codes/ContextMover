"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  latencyMs?: number;
}

interface HealthReport {
  summary: {
    ok: boolean;
    total: number;
    passed: number;
    failed: number;
    failedChecks: string[];
    checkedAt: string;
    supabaseProject: string;
  };
  checks: Check[];
}

const supabase = createClient();

function Badge({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold tracking-wide ${
      ok ? "bg-white/15 text-white border border-white/30"
         : "bg-white/15 text-white border border-white/30"
    }`}>
      {ok ? "PASS" : "FAIL"}
    </span>
  );
}

function Section({ title, checks }: { title: string; checks: Check[] }) {
  const failed = checks.filter(c => !c.ok).length;
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-bold text-white/70 uppercase tracking-widest">{title}</h2>
        {failed > 0 && (
          <span className="text-[10px] font-bold text-white bg-white/10 border border-white/20 rounded px-1.5 py-0.5">
            {failed} failed
          </span>
        )}
      </div>
      <div className="rounded-lg border border-white/8 overflow-hidden">
        {checks.map((c, i) => (
          <div key={c.name} className={`flex items-start gap-3 px-4 py-2.5 text-sm ${
            i % 2 === 0 ? "bg-white/2" : "bg-transparent"
          } ${!c.ok ? "bg-white/5" : ""}`}>
            <Badge ok={c.ok} />
            <div className="flex-1 min-w-0">
              <span className="font-mono text-white/80 text-[12px]">{c.name}</span>
              {c.detail && (
                <span className="ml-2 text-white/40 text-[11px] truncate">{c.detail}</span>
              )}
            </div>
            {c.latencyMs !== undefined && (
              <span className="text-[10px] text-white/30 tabular-nums whitespace-nowrap">{c.latencyMs}ms</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HealthPage() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);

  async function runCheck() {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";
      const res = await fetch("/api/health", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        setError("Unauthorized — only admin can run health checks");
        return;
      }
      const data = await res.json();
      setReport(data);
      setLastRun(new Date().toLocaleTimeString());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { runCheck(); }, []);

  const groupChecks = (prefix: string) =>
    report?.checks.filter(c => c.name.startsWith(prefix)) ?? [];

  return (
    <div className="min-h-screen bg-[#080808] text-white p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-bold text-white">Supabase Health Check</h1>
          {report && (
            <p className="text-xs text-white/40 mt-1">
              Project: <span className="text-white/60 font-mono">{report.summary.supabaseProject}.supabase.co</span>
              {lastRun && <span className="ml-3">Last run: {lastRun}</span>}
            </p>
          )}
        </div>
        <button
          onClick={runCheck}
          disabled={loading}
          className="px-4 py-2 rounded-lg border border-[#00FF88]/30 bg-[#00FF88]/5 text-[#00FF88] text-sm font-bold hover:bg-[#00FF88]/10 disabled:opacity-50 transition-all"
        >
          {loading ? "Checking…" : "Re-run"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 p-4 rounded-lg border border-[#00FF88]/30 bg-[#00FF88]/5 text-[#00FF88] text-sm">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && !report && (
        <div className="flex items-center gap-3 text-white/40 text-sm">
          <span className="animate-spin">⟳</span> Running checks…
        </div>
      )}

      {/* Summary bar */}
      {report && (
        <div className={`mb-8 p-4 rounded-lg border ${
          report.summary.ok
            ? "border-white/30 bg-white/5"
            : "border-white/30 bg-white/5"
        }`}>
          <div className="flex items-center gap-3">
            <span className="text-2xl">{report.summary.ok ? "✅" : "❌"}</span>
            <div>
              <p className={`font-bold ${report.summary.ok ? "text-white" : "text-white"}`}>
                {report.summary.ok ? "All systems operational" : `${report.summary.failed} check(s) failed`}
              </p>
              <p className="text-xs text-white/40 mt-0.5">
                {report.summary.passed}/{report.summary.total} passed · {report.summary.checkedAt}
              </p>
            </div>
          </div>
          {report.summary.failedChecks.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {report.summary.failedChecks.map(n => (
                <span key={n} className="font-mono text-[10px] text-white bg-white/10 border border-white/20 rounded px-2 py-0.5">
                  {n}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Check groups */}
      {report && (
        <>
          <Section title="Environment Variables" checks={groupChecks("env:")} />
          <Section title="Supabase Connectivity" checks={[
            ...groupChecks("supabase:"),
            ...groupChecks("rls:"),
          ]} />
          <Section title="Tables" checks={groupChecks("table:")} />
          <Section title="Redis (Rate Limiter)" checks={groupChecks("redis:")} />
        </>
      )}
    </div>
  );
}
