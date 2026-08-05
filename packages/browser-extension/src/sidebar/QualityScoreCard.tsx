/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/sidebar/QualityScoreCard.tsx
// Migration Quality scorecard.
// Shown for 8 seconds after every successful migration. Click to pin open.
// Click × (or wait for the auto-dismiss timer) to close.

import { useEffect, useRef, useState } from "react";
import type { QualityScore } from "@/lib/quality/migration-scorer";

const PLATFORM_LABEL: Record<string, string> = {
  claude:     "Claude",
  chatgpt:    "ChatGPT",
  gemini:     "Gemini",
  grok:       "Grok",
  perplexity: "Perplexity",
  deepseek:   "DeepSeek",
};

const TIER_LABEL: Record<1 | 2 | 3, string> = {
  1: "Full Context",
  2: "Smart Summary",
  3: "Attention Engine",
};

interface DimDef {
  key: keyof QualityScore["breakdown"];
  label: string;
  max: number;
}

const DIMS: DimDef[] = [
  { key: "messageSurvival",       label: "Messages",    max: 25 },
  { key: "codeIntegrity",         label: "Code",        max: 20 },
  { key: "roleAccuracy",          label: "Roles",       max: 15 },
  { key: "contextFreshness",      label: "Freshness",   max: 15 },
  { key: "keySignalRetention",    label: "Signals",     max: 15 },
  { key: "compressionEfficiency", label: "Compression", max: 10 },
];

// Auto-dismiss after 8 seconds unless user pinned the card open.
const AUTO_DISMISS_MS = 8_000;

interface QualityScoreCardProps {
  score: QualityScore;
  coverageStats?: {
    messagesUsed: number;
    messagesScored: number;
    categoryCounts: Record<string, number>;
  };
  onDismiss: () => void;
}

export function QualityScoreCard({ score, coverageStats, onDismiss }: QualityScoreCardProps) {
  const [pinned, setPinned] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss timer — cleared if the user pins the card.
  useEffect(() => {
    if (pinned) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    timerRef.current = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [pinned, onDismiss]);

  const tone = scoreTone(score.total);
  const platform = PLATFORM_LABEL[score.meta.platform] ?? score.meta.platform;
  const tier = TIER_LABEL[score.meta.tier];
  const time = new Date(score.meta.timestamp).toLocaleTimeString([], {
    hour:   "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      role="status"
      aria-live="polite"
      onClick={(e) => {
        // Don't pin if the user clicks the close button.
        if ((e.target as HTMLElement).closest("[data-cf-dismiss]")) return;
        setPinned(true);
      }}
      style={{
        position:        "relative",
        background:      "#0E0E0E",
        border:          `1px solid ${tone.borderColor}`,
        borderRadius:    10,
        padding:         "14px 16px",
        margin:          "10px 0",
        color:           "#E8E8E8",
        fontSize:        12,
        fontFamily:      "system-ui, -apple-system, sans-serif",
        boxShadow:       `0 0 0 1px ${tone.borderColor}22, 0 4px 14px rgba(0,0,0,0.35)`,
        cursor:          pinned ? "default" : "pointer",
        userSelect:      "none",
      }}
    >
      {/* Header */}
      <div
        style={{
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-between",
          marginBottom:   10,
        }}
      >
        <span style={{ fontWeight: 600, color: "#00D26A", letterSpacing: 0.4 }}>
          Migration Quality
        </span>
        <button
          data-cf-dismiss
          aria-label="Dismiss"
          onClick={onDismiss}
          style={{
            background:    "transparent",
            border:        "none",
            color:         "#666",
            cursor:        "pointer",
            fontSize:      16,
            lineHeight:    1,
            padding:       "0 4px",
          }}
        >
          ×
        </button>
      </div>

      {/* Score + grade */}
      <div
        style={{
          display:    "flex",
          alignItems: "baseline",
          gap:        10,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize:   28,
            fontWeight: 700,
            color:      tone.scoreColor,
            lineHeight: 1,
          }}
        >
          {score.total}
          <span style={{ fontSize: 14, color: "#666", fontWeight: 500 }}>/100</span>
        </span>
        <span style={{ fontSize: 13, color: tone.scoreColor, fontWeight: 600 }}>
          {tone.icon} {score.grade}
        </span>
      </div>

      {/* Total bar */}
      <ProgressBar value={score.total} max={100} compact />

      {/* Per-dimension grid */}
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
        {DIMS.map((d) => {
          const v = score.breakdown[d.key];
          return (
            <div
              key={d.key}
              style={{
                display:        "grid",
                gridTemplateColumns: "78px 1fr 50px",
                alignItems:     "center",
                gap:            8,
                fontSize:       11,
              }}
            >
              <span style={{ color: "#888" }}>{d.label}</span>
              <ProgressBar value={v} max={d.max} />
              <span style={{ color: "#A8A8A8", textAlign: "right" }}>
                {v.toFixed(1)}/{d.max}
              </span>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div
        style={{
          marginTop: 12,
          paddingTop: 10,
          borderTop: "1px solid #1A1A1A",
          color: "#666",
          fontSize: 11,
        }}
      >
        {platform} · {tier} · {time}
        {pinned ? "" : "  · click to pin"}
      </div>
      {score.meta.tier === 2 && coverageStats && (
        <div style={{ marginTop: 6, fontSize: 11 }}>
          {(() => {
            const pct = Math.round((coverageStats.messagesUsed / score.meta.originalMessages) * 100) || 0;
            const color = pct > 40 ? "var(--color-text-success, #00FF88)" : pct >= 20 ? "var(--color-text-warning, #00D26A)" : "var(--color-text-danger, #00FF88)";
            return (
              <span style={{ color }}>
                Coverage: {pct}% of session messages
              </span>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProgressBar
// ─────────────────────────────────────────────────────────────────────────────

function ProgressBar({
  value,
  max,
  compact = false,
}: {
  value: number;
  max:   number;
  compact?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      style={{
        position:     "relative",
        width:        "100%",
        height:       compact ? 6 : 5,
        background:   "#1A1A1A",
        borderRadius: 3,
        overflow:     "hidden",
      }}
    >
      <div
        style={{
          width:      `${pct}%`,
          height:     "100%",
          background: "#00D26A",
          transition: "width 220ms ease-out",
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tone helpers
// ─────────────────────────────────────────────────────────────────────────────

function scoreTone(total: number): {
  borderColor: string;
  scoreColor:  string;
  icon:        string;
} {
  if (total >= 90) {
    return { borderColor: "#00D26A", scoreColor: "#00D26A", icon: "✅" };
  }
  if (total >= 75) {
    return { borderColor: "#00D26A", scoreColor: "#00FF88", icon: "✅" };
  }
  if (total >= 60) {
    return { borderColor: "#E8B339", scoreColor: "#E8B339", icon: "⚠️" };
  }
  return { borderColor: "#E84A4A", scoreColor: "#E84A4A", icon: "❌" };
}
