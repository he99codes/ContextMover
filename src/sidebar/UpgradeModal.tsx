/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/sidebar/UpgradeModal.tsx
// Shown when MIGRATE_CONTEXT returns { error: 'LIMIT_REACHED' }.
// Links the user to the pricing page on the marketing site.

// Web-app URL — must mirror the constant in service-worker.ts.
const WEB_APP_URL =
  process.env.NODE_ENV === "production"
    ? "https://contextmover.dev"
    : "http://localhost:3000";

export type LimitType = "simple" | "smart" | "attention";

interface UpgradeModalProps {
  isOpen:    boolean;
  onClose:   () => void;
  limitType: LimitType | null;
  used:      number;
  limit:     number;
}

const LIMIT_MESSAGES: Record<LimitType, { title: string; description: string; icon: string }> = {
  simple: {
    title:       "Full Context limit reached",
    description: "You've used all 50 Full Context migrations this month.",
    icon:        "📄",
  },
  smart: {
    title:       "Smart Summary limit reached",
    description: "You've used all 50 Smart Summary migrations this month.",
    icon:        "🧠",
  },
  attention: {
    title:       "Attention Engine limit reached",
    description: "You've used all 10 Attention Engine migrations this month.",
    icon:        "⚡",
  },
};

const PRO_FEATURES = [
  "Unlimited migrations",
  "Unlimited sessions stored",
  "All prompt templates",
  "IDE + GitHub context",
];

export function UpgradeModal({
  isOpen,
  onClose,
  limitType,
  used,
  limit,
}: UpgradeModalProps) {
  if (!isOpen || !limitType) return null;
  const msg = LIMIT_MESSAGES[limitType];

  return (
    <div
      style={{
        position:        "absolute",
        inset:           0,
        background:      "rgba(0,0,0,0.88)",
        display:         "flex",
        alignItems:      "center",
        justifyContent:  "center",
        padding:         "16px",
        zIndex:          1000,
        backdropFilter:  "blur(4px)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background:   "#0A0A0A",
          border:       "1px solid rgba(0,255,136,0.15)",
          borderRadius: "8px",
          padding:      "20px",
          width:        "100%",
          maxWidth:     "320px",
        }}
      >
        {/* Icon */}
        <div style={{ fontSize: "32px", textAlign: "center", marginBottom: "12px" }}>
          {msg.icon}
        </div>

        {/* Title */}
        <h3
          style={{
            margin:         "0 0 8px",
            fontSize:       "13px",
            fontWeight:     900,
            color:          "#F5F5F5",
            textAlign:      "center",
            textTransform:  "uppercase",
            letterSpacing:  "0.1em",
          }}
        >
          {msg.title}
        </h3>

        {/* Description */}
        <p
          style={{
            margin:     "0 0 16px",
            fontSize:   "11px",
            color:      "#6B6B6B",
            textAlign:  "center",
            lineHeight: 1.6,
          }}
        >
          {msg.description}
        </p>

        {/* Usage bar */}
        <div style={{ marginBottom: "16px" }}>
          <div
            style={{
              display:        "flex",
              justifyContent: "space-between",
              fontSize:       "9px",
              color:          "#6B6B6B",
              marginBottom:   "4px",
            }}
          >
            <span>Used this month</span>
            <span>{used}/{limit}</span>
          </div>
          <div
            style={{
              background:   "#1A1A1A",
              borderRadius: "4px",
              height:       "4px",
              overflow:     "hidden",
            }}
          >
            <div style={{ width: "100%", height: "100%", background: "#00FF88" }} />
          </div>
        </div>

        {/* Pro unlocks */}
        <div
          style={{
            background:   "#111111",
            border:       "1px solid #2A2A2A",
            borderRadius: "6px",
            padding:      "12px",
            marginBottom: "16px",
          }}
        >
          <div
            style={{
              fontSize:       "9px",
              fontWeight:     900,
              color:          "#00FF88",
              textTransform:  "uppercase",
              letterSpacing:  "0.15em",
              marginBottom:   "8px",
            }}
          >
            Pro unlocks
          </div>
          {PRO_FEATURES.map((feature) => (
            <div
              key={feature}
              style={{ fontSize: "10px", color: "#F5F5F5", marginBottom: "4px" }}
            >
              ✓ {feature}
            </div>
          ))}
        </div>

        {/* CTA */}
        <button
          onClick={() => {
            chrome.tabs.create({
              url: `${WEB_APP_URL}/pricing?source=limit_${limitType}`,
            });
            onClose();
          }}
          style={{
            width:          "100%",
            padding:        "12px",
            background:     "#00FF88",
            border:         "none",
            borderRadius:   "4px",
            color:          "#0A0A0A",
            fontSize:       "11px",
            fontWeight:     900,
            textTransform:  "uppercase",
            letterSpacing:  "0.12em",
            cursor:         "pointer",
            marginBottom:   "8px",
            boxShadow:      "0 0 20px rgba(0,255,136,0.4)",
          }}
        >
          Upgrade to Pro
        </button>

        <button
          onClick={onClose}
          style={{
            width:        "100%",
            padding:      "8px",
            background:   "transparent",
            border:       "1px solid #2A2A2A",
            borderRadius: "4px",
            color:        "#6B6B6B",
            fontSize:     "10px",
            cursor:       "pointer",
          }}
        >
          Maybe later
        </button>

        <p
          style={{
            margin:    "8px 0 0",
            fontSize:  "9px",
            color:     "#3A3A3A",
            textAlign: "center",
          }}
        >
          Free limits reset on the 1st of each month
        </p>
      </div>
    </div>
  );
}
