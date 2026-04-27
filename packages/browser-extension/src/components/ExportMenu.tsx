// packages/browser-extension/src/components/ExportMenu.tsx
//
// Compact format-picker dropdown used by both the sidebar and popup.
// Opens on click, downloads the selected format, then closes.

import { useEffect, useRef, useState } from "react";
import {
  EXPORT_FORMATS,
  downloadExport,
  type ExportFormat,
} from "@/lib/exporter";
import type { ContextSession } from "@/lib/types";

interface Props {
  session: ContextSession;
  variant?: "icon" | "button";
  align?: "left" | "right";
  onError?: (message: string) => void;
  onSuccess?: (format: ExportFormat) => void;
}

const ORDER: ExportFormat[] = ["xml", "markdown", "plaintext", "json", "txt"];

interface DropdownPos { top: number; left?: number; right?: number; }

export default function ExportMenu({
  session,
  variant = "button",
  align = "right",
  onError,
  onSuccess,
}: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [pos, setPos] = useState<DropdownPos>({ top: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Recompute fixed position whenever the dropdown opens.
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const dropH = 5 * 32 + 28; // 5 items × ~32px + header
    const spaceBelow = window.innerHeight - r.bottom;
    const openUpward = spaceBelow < dropH && r.top > dropH;
    setPos(
      openUpward
        ? { top: r.top - dropH - 4, left: align === "right" ? undefined : r.left, right: align === "right" ? window.innerWidth - r.right : undefined }
        : { top: r.bottom + 4,      left: align === "right" ? undefined : r.left, right: align === "right" ? window.innerWidth - r.right : undefined }
    );
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  function pick(format: ExportFormat) {
    setBusy(format);
    try {
      downloadExport(session, format);
      onSuccess?.(format);
      setOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed — try again.";
      onError?.(message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Export session"
        aria-label="Export session"
        className={
          variant === "icon"
            ? "inline-flex h-7 w-7 items-center justify-center rounded-[4px] border border-[#2A2A2A] text-[#6B6B6B] transition hover:border-[#00FF88]/30 hover:text-[#00FF88]"
            : "inline-flex items-center gap-1 rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-2 py-1 text-[10px] font-medium text-[#6B6B6B] transition hover:border-[#00FF88]/30 hover:text-[#00FF88]"
        }
      >
        {/* Inline download glyph (avoids adding an icon dep). */}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 2v9" />
          <path d="m4.5 7.5 3.5 3.5 3.5-3.5" />
          <path d="M2.5 13.5h11" />
        </svg>
        {variant === "button" && <span>Export</span>}
      </button>

      {open && (
        <div
          style={{
            position: "fixed",
            top:   pos.top,
            left:  pos.left,
            right: pos.right,
            zIndex: 9999,
            width: "11rem",
          }}
          className="rounded-[6px] border border-[#2A2A2A] bg-[#0A0A0A] shadow-[0_8px_24px_rgba(0,0,0,0.75)]"
          role="menu"
        >
          <div className="border-b border-[#2A2A2A] px-3 py-1.5 text-[9px] uppercase tracking-wider text-[#6B6B6B]">
            Export as
          </div>
          {ORDER.map((id) => {
            const meta = EXPORT_FORMATS[id];
            return (
              <button
                key={id}
                type="button"
                onClick={() => pick(id)}
                disabled={busy !== null}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-[#F5F5F5] transition hover:bg-[#1A1A1A] hover:text-[#00FF88] disabled:opacity-50"
                role="menuitem"
              >
                <span className="font-medium">{meta.label}</span>
                <span className="text-[9px] uppercase tracking-wider text-[#6B6B6B]">
                  {busy === id ? "…" : `.${meta.extension}`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
