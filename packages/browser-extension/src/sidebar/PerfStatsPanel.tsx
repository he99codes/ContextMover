import React from "react";

interface PerfStatRow { operation: string; count: number; p50: number; p90: number; p99: number; sloTarget: number; sloMet: boolean; }
// [CM-OFFSCREEN-FIX] Added migrate_total (end-to-end user-perceived time) and
// migrate_tier3_fallback (T3 that fell back to T1). Renamed T1/T2/T3 labels to
// clarify these are SW-internal times, not user-perceived.
const LABELS: Record<string, string> = {
  capture_session: "Capture",
  migrate_total: "Total",
  migrate_tier1: "T1 (SW)",
  migrate_tier2: "T2 (SW)",
  migrate_tier3: "T3 (SW)",
  migrate_tier3_fallback: "T3→T1",
  background_index: "BG Idx",
  semantic_search: "Search",
  drive_sync: "Drive",
};
const fmt = (ms: number) => ms === 0 ? "—" : ms >= 1000 ? `${(ms/1000).toFixed(1)}s` : `${ms}ms`;

export function PerfStatsPanel() {
  const [rows, setRows] = React.useState<PerfStatRow[]>([]);
  const [busy, setBusy] = React.useState(false);
  const load = async () => { setBusy(true); try { const r = await chrome.runtime.sendMessage({ type: "GET_PERF_STATS" }); if (r?.ok) setRows((r.stats as PerfStatRow[]).filter(s => s.count > 0)); } catch {} finally { setBusy(false); } };
  React.useEffect(() => { void load(); }, []);
  return (
    <div className="rounded-[6px] border border-[#2A2A2A] bg-[#080808] px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[9px] uppercase tracking-widest text-[#E5E5E5]">Latency (7d)</span>
        <button onClick={() => void load()} disabled={busy} className="text-[8px] text-[#E5E5E5] opacity-70 hover:opacity-100 disabled:opacity-30">{busy ? "…" : "↻"}</button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[8px] text-[#4a5568]">{busy ? "Loading…" : "No data yet — use the extension to collect samples."}</p>
      ) : (
        <table className="w-full text-[7.5px]">
          <thead><tr className="text-[#4a5568]"><th className="text-left">Op</th><th className="text-right">n</th><th className="text-right">P50</th><th className="text-right">P90</th><th className="text-right">P99</th><th className="text-right">SLO</th></tr></thead>
          <tbody>
            {rows.map(s => (
              <tr key={s.operation}>
                <td className="text-[#a0aec0] pr-1">{LABELS[s.operation] ?? s.operation}</td>
                <td className="text-right text-[#4a5568] px-1">{s.count}</td>
                <td className="text-right text-[#a0aec0] px-1">{fmt(s.p50)}</td>
                <td className={`text-right px-1 font-mono ${s.sloMet ? "text-[#00FF88]" : "text-[#00FF88]"}`}>{fmt(s.p90)}</td>
                <td className="text-right text-[#a0aec0] px-1">{fmt(s.p99)}</td>
                <td className={`text-right pl-1 ${s.sloMet ? "text-[#00FF88]" : "text-[#00FF88]"}`}>{s.sloMet ? "✓" : "✗"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
