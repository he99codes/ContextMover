// packages/browser-extension/src/sidebar/CapabilitySettings.tsx
//
// User-facing settings for the Attention Engine tier override.
//
// Persists the selected override via capabilityDetector.setUserOverride(),
// which writes to BOTH localStorage (page contexts) and chrome.storage.local
// (so the service worker reads the same value).
//
// "Auto" is the default — it lets capability detection pick the best tier
// for the current machine + battery state.  Any other choice locks the tier
// until the user reverts to Auto.
//
// Drop-in: render anywhere.  No external dependencies beyond React.

import { useEffect, useState } from "react";
import {
  capabilityDetector,
  type Capabilities,
  type Tier,
  type TierOverride,
} from "@/lib/capability-detector";

const OPTIONS: { value: TierOverride; label: string; help: string }[] = [
  { value: "auto",     label: "Auto",     help: "Detect best tier for this machine" },
  { value: "minimal",  label: "Minimal",  help: "Regex only — <100 ms, no model load" },
  { value: "balanced", label: "Balanced", help: "Embedding model on WASM — 1-2 s" },
  { value: "full",     label: "Full",     help: "WebGPU when available — 3-5 s" },
];

const TIER_COLORS: Record<Tier, string> = {
  minimal: "#888888",
  balanced: "#00BFFF",
  full: "#00FF88",
};

export default function CapabilitySettings() {
  const [override, setOverrideState] = useState<TierOverride>("auto");
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [busy, setBusy] = useState(false);

  // Load current override + run a fresh detection on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const [ov, c] = await Promise.all([
          capabilityDetector.getUserOverride(),
          capabilityDetector.detect(true),
        ]);
        if (!cancelled) {
          setOverrideState(ov);
          setCaps(c);
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSelect(next: TierOverride) {
    if (next === override) return;
    setBusy(true);
    try {
      await capabilityDetector.setUserOverride(next);
      setOverrideState(next);
      // Re-detect so the displayed effective tier reflects the new override.
      const c = await capabilityDetector.detect(true);
      setCaps(c);
    } finally {
      setBusy(false);
    }
  }

  const effectiveTier = caps?.tier ?? "balanced";
  const effectiveColor = TIER_COLORS[effectiveTier];

  return (
    <div
      style={{
        background: "#0A0A0A",
        border: "1px solid #1A1A1A",
        borderRadius: "6px",
        padding: "12px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#F5F5F5",
      }}
    >
      <div
        style={{
          fontSize: "10px",
          fontWeight: 900,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "#888",
          marginBottom: "10px",
        }}
      >
        Attention Engine · Compute Tier
      </div>

      {/* ── Tier selector ─────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "6px", marginBottom: "10px" }}>
        {OPTIONS.map((opt) => {
          const active = override === opt.value;
          return (
            <button
              key={opt.value}
              disabled={busy}
              onClick={() => handleSelect(opt.value)}
              title={opt.help}
              style={{
                background: active ? "#0F1A0F" : "#111",
                border: `1px solid ${active ? "#00FF88" : "#222"}`,
                color: active ? "#00FF88" : "#AAA",
                borderRadius: "4px",
                padding: "8px 10px",
                cursor: busy ? "wait" : "pointer",
                fontSize: "10px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                textAlign: "left",
                transition: "border-color 80ms",
              }}
            >
              <div>{opt.label}</div>
              <div style={{ fontSize: "8px", color: "#666", marginTop: "2px", letterSpacing: 0, textTransform: "none", fontWeight: 400 }}>
                {opt.help}
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Live diagnostics ──────────────────────────────────────────────── */}
      {caps && (
        <div style={{ fontSize: "9px", color: "#666", lineHeight: 1.6 }}>
          <div>
            <span style={{ color: "#888" }}>Effective tier:</span>{" "}
            <span style={{ color: effectiveColor, fontWeight: 700, textTransform: "uppercase" }}>
              {effectiveTier}
            </span>
            {caps.overridden && <span style={{ color: "#888" }}> (override)</span>}
          </div>
          <div style={{ color: "#444" }}>{caps.reason}</div>
          <div>
            <span style={{ color: "#888" }}>cores:</span> {caps.cores}
            {caps.deviceMemoryGb !== undefined && <> · <span style={{ color: "#888" }}>ram:</span> {caps.deviceMemoryGb} GB</>}
            {caps.jsHeapLimitMb !== undefined && <> · <span style={{ color: "#888" }}>heap:</span> {caps.jsHeapLimitMb} MB</>}
          </div>
          <div>
            <span style={{ color: "#888" }}>bench:</span> {caps.benchmarkOpsPerMs} ops/ms
            {" · "}<span style={{ color: "#888" }}>webgpu:</span> {caps.hasWebGpu ? "yes" : "no"}
            {caps.onBattery !== undefined && (
              <> · <span style={{ color: "#888" }}>battery:</span> {caps.onBattery ? `on (${Math.round((caps.batteryLevel ?? 0) * 100)}%)` : "charging"}</>
            )}
          </div>
        </div>
      )}

      {busy && (
        <div style={{ marginTop: "8px", fontSize: "9px", color: "#666" }}>
          · Detecting capabilities…
        </div>
      )}
    </div>
  );
}
