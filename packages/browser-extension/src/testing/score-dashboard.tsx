// packages/browser-extension/src/testing/score-dashboard.tsx
// Migration Quality Dashboard — renders inside the ContextMover sidebar.
// READ-ONLY relative to production code. Triggers test runs and shows results.

import React, { useCallback, useEffect, useState } from "react";
import { runAllTests, type TestReport, type TestResult } from "./test-runner";
import { getAllTestReports } from "./score-logger";
import type { MigrationScore } from "./migration-scorer";

// ── Helpers ───────────────────────────────────────────────────────────────────
function scoreColor(s: number): string {
  return s >= 70 ? "#00FF88" : s >= 50 ? "#F59E0B" : "#EF4444";
}

function gradeBg(grade: MigrationScore["grade"]): string {
  if (grade === "Excellent" || grade === "Good") return "bg-[#00FF88]/10 text-[#00FF88] border-[#00FF88]/30";
  if (grade === "Degraded") return "bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/30";
  return "bg-[#EF4444]/10 text-[#EF4444] border-[#EF4444]/30";
}

function worstDimension(score: MigrationScore): string {
  const dims = score.dimensions;
  const entries = [
    ["roleFidelity",      dims.roleFidelity.score],
    ["codeIntegrity",     dims.codeIntegrity.score],
    ["semanticRetention", dims.semanticRetention.score],
    ["taskState",         dims.taskState.score],
    ["compressionLoss",   dims.compressionLoss.score],
  ] as [string, number][];
  return entries.sort((a, b) => a[1] - b[1])[0][0];
}

// ── Sparkline SVG ─────────────────────────────────────────────────────────────
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return (
      <div className="flex h-14 items-center justify-center text-[10px] text-[#2A4A2A]">
        Need ≥ 2 runs for trend
      </div>
    );
  }

  const W = 280, H = 48, pad = 4;
  const min = 0, max = 100;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (W - pad * 2);
    const y = H - pad - ((v - min) / (max - min)) * (H - pad * 2);
    return `${x},${y}`;
  });
  const polyline = pts.join(" ");

  // Threshold line at y=70
  const threshY = H - pad - ((70 - min) / (max - min)) * (H - pad * 2);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="overflow-visible">
      {/* threshold dashed line */}
      <line
        x1={pad} y1={threshY} x2={W - pad} y2={threshY}
        stroke="#2A6A2A" strokeWidth={1} strokeDasharray="4 3"
      />
      <text x={W - pad} y={threshY - 3} fontSize={8} fill="#2A6A2A" textAnchor="end">70</text>

      {/* sparkline */}
      <polyline
        points={polyline}
        fill="none"
        stroke="#00FF88"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* dots */}
      {pts.map((pt, i) => {
        const [x, y] = pt.split(",").map(Number);
        return (
          <circle key={i} cx={x} cy={y} r={2.5} fill={scoreColor(values[i])} />
        );
      })}
    </svg>
  );
}

// ── Dimension Bar ─────────────────────────────────────────────────────────────
function DimensionBar({
  label, score, weight,
}: { label: string; score: number; weight: number }) {
  const col = scoreColor(score);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px]">
        <span style={{ color: "#6AFF6A" }}>{label}</span>
        <span className="font-mono" style={{ color: col }}>
          {score}<span className="text-[#2A4A2A]"> / 100</span>
          <span className="ml-1 text-[#2A4A2A]">(w={weight})</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-[#111]">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${score}%`, background: col, boxShadow: `0 0 6px ${col}60` }}
        />
      </div>
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────────────────────
function ResultRow({ result }: { result: TestResult }) {
  const [expanded, setExpanded] = useState(false);
  const s = result.score;
  const col = scoreColor(s.total);

  return (
    <>
      <tr
        className="cursor-pointer border-b border-[#0D2A0D] hover:bg-[#0A180A] transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        <td className="px-3 py-2 text-[10px] font-mono text-[#A0A0A0]">{result.sessionName}</td>
        <td className="px-3 py-2">
          <span className="rounded px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider bg-[#0A1A0A] border border-[#1A3A1A] text-[#2A6A2A]">
            {result.tier}
          </span>
        </td>
        <td className="px-3 py-2 font-mono text-[13px] font-black" style={{ color: col }}>
          {s.total}
        </td>
        <td className="px-3 py-2">
          <span className={`rounded border px-1.5 py-0.5 text-[9px] font-black uppercase ${gradeBg(s.grade)}`}>
            {s.grade}
          </span>
        </td>
        <td className="px-3 py-2 text-[10px] text-[#EF4444]">{worstDimension(s)}</td>
        <td className="px-3 py-2 text-[10px] text-[#2A4A2A]">{expanded ? "▲" : "▼"}</td>
      </tr>
      {expanded && (
        <tr className="bg-[#060E06]">
          <td colSpan={6} className="px-4 py-3">
            <div className="space-y-1 text-[10px] font-mono text-[#6A6A6A]">
              {s.lostItems.length === 0 ? (
                <div className="text-[#00FF88]">✓ Nothing lost</div>
              ) : (
                s.lostItems.map((item, i) => <div key={i}>• {item}</div>)
              )}
              <div className="mt-2 grid grid-cols-5 gap-2 text-[9px]">
                {Object.entries(s.dimensions).map(([key, dim]) => (
                  <div key={key} className="space-y-0.5">
                    <div style={{ color: scoreColor(dim.score) }}>{dim.score}</div>
                    <div className="text-[#2A4A2A] uppercase tracking-wider">{key.replace(/([A-Z])/g, " $1").trim()}</div>
                  </div>
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────
export default function ScoreDashboard() {
  const [running, setRunning]     = useState(false);
  const [report, setReport]       = useState<TestReport | null>(null);
  const [history, setHistory]     = useState<TestReport[]>([]);
  const [error, setError]         = useState<string | null>(null);

  // Load history on mount
  useEffect(() => {
    getAllTestReports()
      .then((reports) => {
        setHistory(reports);
        if (reports.length > 0) setReport(reports[0]);
      })
      .catch(() => { /* first launch */ });
  }, []);

  const handleRun = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const newReport = await runAllTests();
      setReport(newReport);
      setHistory((prev) => [newReport, ...prev].slice(0, 50));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, []);

  // ── Aggregate dimension averages across current report ─────────────────────
  const dimAvgs = report
    ? (() => {
        const keys = ["roleFidelity", "codeIntegrity", "semanticRetention", "taskState", "compressionLoss"] as const;
        const weights = { roleFidelity: 0.20, codeIntegrity: 0.25, semanticRetention: 0.25, taskState: 0.15, compressionLoss: 0.15 };
        return keys.map((k) => {
          const avg = Math.round(
            report.results.reduce((s, r) => s + r.score.dimensions[k].score, 0) / report.results.length,
          );
          return { key: k, avg, weight: weights[k] };
        });
      })()
    : [];

  // ── Launch readiness check ─────────────────────────────────────────────────
  const allPass     = report ? report.results.every((r) => r.score.total >= 70) : false;
  const dimAllPass  = dimAvgs.every((d) => d.avg >= 50);
  const launchReady = allPass && dimAllPass;

  const failing = report
    ? report.results.filter((r) => r.score.total < 70).map((r) => `${r.sessionName}/${r.tier}`)
    : [];

  // ── Sparkline values from history ─────────────────────────────────────────
  const sparkValues = [...history].reverse().slice(-10).map((r) => r.summary.averageScore);

  const s = report?.summary;
  const regNum = s?.regressionVsLastRun;

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[#050505] text-[#F5F5F5]">

      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#0D2A0D] bg-[#050505] px-4 py-3">
        <div>
          <div className="text-[12px] font-black uppercase tracking-[0.2em] text-[#00FF88]">Migration Quality</div>
          <div className="text-[9px] uppercase tracking-wider text-[#2A4A2A]">
            {GOLDEN_SESSIONS_COUNT} sessions × 3 tiers = 18 tests
          </div>
        </div>
        <button
          onClick={() => void handleRun()}
          disabled={running}
          className="flex items-center gap-2 rounded-[5px] border border-[#00FF88]/30 bg-[#00FF88]/8 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-[#00FF88] transition-all hover:bg-[#00FF88]/15 hover:shadow-[0_0_12px_rgba(0,255,136,0.3)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? (
            <>
              <span className="inline-block h-3 w-3 animate-spin rounded-full border border-[#00FF88] border-t-transparent" />
              Running…
            </>
          ) : "▶ Run Tests"}
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-3 rounded-[5px] border border-[#EF4444]/30 bg-[#EF4444]/8 px-3 py-2 text-[10px] text-[#EF4444]">
          {error}
        </div>
      )}

      {/* Launch readiness banner */}
      {report && (
        <div className={`mx-4 mt-3 rounded-[5px] border px-3 py-2.5 text-[10px] font-black uppercase tracking-wider ${
          launchReady
            ? "border-[#00FF88]/30 bg-[#00FF88]/8 text-[#00FF88]"
            : "border-[#EF4444]/30 bg-[#EF4444]/8 text-[#EF4444]"
        }`}>
          {launchReady
            ? "✓ Ready for production — all tests ≥ 70, all dimensions ≥ 50"
            : `✗ Not ready — ${failing.length} test(s) below threshold: ${failing.slice(0, 4).join(", ")}${failing.length > 4 ? ` +${failing.length - 4} more` : ""}`
          }
        </div>
      )}

      {/* Summary cards */}
      {report && s && (
        <div className="grid grid-cols-4 gap-2 px-4 pt-4">
          {[
            {
              label: "Score",
              value: <span className="text-3xl font-black tabular-nums" style={{ color: scoreColor(s.averageScore) }}>{s.averageScore}</span>,
              sub: "/ 100",
            },
            {
              label: "Passed",
              value: <span className="text-xl font-black text-[#00FF88]">{s.passed}</span>,
              sub: `/ ${s.totalTests}`,
            },
            {
              label: "Avg Score",
              value: <span className="text-xl font-black tabular-nums" style={{ color: scoreColor(s.averageScore) }}>{s.averageScore}</span>,
              sub: "this run",
            },
            {
              label: "vs Last",
              value: regNum == null
                ? <span className="text-xl font-black text-[#2A4A2A]">—</span>
                : <span className={`text-xl font-black ${(regNum as number) >= 0 ? "text-[#00FF88]" : "text-[#EF4444]"}`}>
                    {(regNum as number) >= 0 ? "▲" : "▼"}{Math.abs(regNum as number)}
                  </span>,
              sub: regNum == null ? "first run" : `${(regNum as number) >= 0 ? "+" : ""}${regNum} pts`,
            },
          ].map(({ label, value, sub }) => (
            <div key={label} className="rounded-[6px] border border-[#0D2A0D] bg-[#080808] px-3 py-3 text-center">
              <div className="text-[9px] uppercase tracking-wider text-[#2A4A2A]">{label}</div>
              <div className="mt-1">{value}</div>
              <div className="text-[9px] text-[#1A3A1A]">{sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Results table */}
      {report && (
        <div className="mt-4 px-4">
          <div className="text-[9px] font-black uppercase tracking-[0.2em] text-[#2A6A2A] mb-2">Results (worst first)</div>
          <div className="overflow-hidden rounded-[6px] border border-[#0D2A0D]">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[#0D2A0D] bg-[#080808]">
                  {["Session", "Tier", "Score", "Grade", "Worst Dim", ""].map((h) => (
                    <th key={h} className="px-3 py-2 text-[9px] font-black uppercase tracking-wider text-[#2A4A2A]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...report.results]
                  .sort((a, b) => a.score.total - b.score.total)
                  .map((r, i) => <ResultRow key={`${r.sessionName}-${r.tier}-${i}`} result={r} />)
                }
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Dimension breakdown */}
      {report && dimAvgs.length > 0 && (
        <div className="mt-4 px-4">
          <div className="text-[9px] font-black uppercase tracking-[0.2em] text-[#2A6A2A] mb-2">Dimension Averages</div>
          <div className="rounded-[6px] border border-[#0D2A0D] bg-[#080808] p-4 space-y-3">
            {dimAvgs.map(({ key, avg, weight }) => (
              <DimensionBar
                key={key}
                label={key.replace(/([A-Z])/g, " $1").trim()}
                score={avg}
                weight={weight}
              />
            ))}
          </div>
        </div>
      )}

      {/* History sparkline */}
      <div className="mt-4 px-4">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-[#2A6A2A] mb-2">
          Score Trend (last {Math.min(sparkValues.length, 10)} runs)
        </div>
        <div className="rounded-[6px] border border-[#0D2A0D] bg-[#080808] p-4">
          <Sparkline values={sparkValues} />
          <div className="mt-1 text-[9px] text-[#1A3A1A]">
            {history.length} total run(s) · Dashed line = 70 launch threshold
          </div>
        </div>
      </div>

      {/* Footer padding */}
      <div className="h-6" />
    </div>
  );
}

// Required for header subtitle — keep in sync with GOLDEN_SESSIONS.length
const GOLDEN_SESSIONS_COUNT = 6;
