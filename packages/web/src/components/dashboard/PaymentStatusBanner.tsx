"use client";
// packages/web/src/components/dashboard/PaymentStatusBanner.tsx
// Reads ?payment=success|cancelled from the URL and renders a dismissible
// banner at the top of the settings page. Auto-dismisses after 5s.

import { useEffect, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";

type Status = "success" | "cancelled" | null;

export function PaymentStatusBanner() {
  const params   = useSearchParams();
  const router   = useRouter();
  const pathname = usePathname();
  const initial  = (params.get("payment") as Status) ?? null;
  const [status, setStatus] = useState<Status>(initial);

  // Auto-dismiss after 5s and clear the query param.
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => {
      setStatus(null);
      router.replace(pathname);
    }, 5_000);
    return () => clearTimeout(t);
  }, [status, router, pathname]);

  if (!status) return null;

  const isSuccess = status === "success";

  return (
    <div
      style={{
        margin:        "0 0 16px",
        padding:       "12px 16px",
        borderRadius:  "8px",
        border:        `1px solid ${isSuccess ? "rgba(0,255,136,0.4)" : "rgba(107,107,107,0.3)"}`,
        background:    isSuccess ? "rgba(0,255,136,0.06)" : "rgba(107,107,107,0.06)",
        color:         isSuccess ? "#00FF88" : "#B8B8B8",
        fontSize:      "13px",
        display:       "flex",
        alignItems:    "center",
        gap:           "10px",
      }}
      role="status"
    >
      <span style={{ fontSize: "16px" }}>{isSuccess ? "✅" : "ℹ️"}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, marginBottom: "2px" }}>
          {isSuccess ? "Payment successful!" : "Payment cancelled."}
        </div>
        <div style={{ fontSize: "12px", opacity: 0.85 }}>
          {isSuccess
            ? "You're now on Pro. Enjoy unlimited migrations."
            : "You're still on the free plan."}
        </div>
      </div>
      <button
        onClick={() => { setStatus(null); router.replace(pathname); }}
        aria-label="Dismiss"
        style={{
          background: "transparent",
          border:     "none",
          color:      "inherit",
          fontSize:   "16px",
          cursor:     "pointer",
          opacity:    0.6,
        }}
      >
        ×
      </button>
    </div>
  );
}
