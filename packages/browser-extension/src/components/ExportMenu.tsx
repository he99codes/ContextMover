// packages/browser-extension/src/components/ExportMenu.tsx
//
// Compact format-picker dropdown used by both the sidebar and popup.
// Opens on click, downloads the selected format, then closes.

import { useEffect, useRef, useState } from "react";
import {
  exportAsMarkdown,
  exportAsText,
  exportAsJSON,
  exportAsCSV,
  copySessionToClipboard,
} from "@/lib/export/session-export";
import type { ContextSession } from "@/lib/types";

interface Props {
  session: ContextSession;
  variant?: "icon" | "button";
  align?: "left" | "right"; // kept for API compatibility
  onError?: (message: string) => void;
  onSuccess?: (label: string) => void;
}

interface SheetItem {
  id:     string;
  icon:   string;
  label:  string;
  ext?:   string;
  action: (session: ContextSession) => Promise<void> | void;
}

const ITEMS: SheetItem[] = [
  { id: "markdown",  icon: "\u{1F4C4}", label: "Markdown",        ext: ".md",   action: (s) => exportAsMarkdown(s) },
  { id: "plaintext", icon: "\u{1F4CB}", label: "Plain Text",      ext: ".txt",  action: (s) => exportAsText(s) },
  { id: "json",      icon: "\u{1F5C2}", label: "JSON",            ext: ".json", action: (s) => exportAsJSON(s) },
  { id: "csv",       icon: "\u{1F4CA}", label: "CSV",             ext: ".csv",  action: (s) => exportAsCSV(s) },
  { id: "clipboard", icon: "\u{1F4CB}", label: "Copy to Clipboard",             action: (s) => copySessionToClipboard(s) },
];

export default function ExportMenu({
  session,
  variant = "button",
  align = "right",
  onError,
  onSuccess,
}: Props) {
  const [open,    setOpen]   = useState(false);
  const [visible, setVisible] = useState(false); // drives slide-up CSS transition
  const [busy,    setBusy]    = useState<string | null>(null);
  const wrapRef      = useRef<HTMLDivElement>(null);
  const btnRef       = useRef<HTMLButtonElement>(null);
  const pickingRef   = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function openSheet() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    setOpen(true);
  }

  function closeSheet() {
    setVisible(false);
    closeTimerRef.current = setTimeout(() => setOpen(false), 160);
  }

  // Kick off the slide-up transition one frame after the sheet mounts.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) closeSheet();
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") closeSheet();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown",   onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown",   onEsc);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function pick(item: SheetItem) {
    if (pickingRef.current) return;
    pickingRef.current = true;
    setBusy(item.id);
    try {
      await Promise.resolve(item.action(session));
      onSuccess?.(item.label);
      closeSheet();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed — try again.";
      onError?.(message);
    } finally {
      setBusy(null);
      pickingRef.current = false;
    }
  }

  const isActive = open;

  return (
    <div ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      {/* Trigger button */}
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          open ? closeSheet() : openSheet();
        }}
        title="Export session"
        aria-label="Export session"
        aria-expanded={open}
        style={isActive ? { background: "rgba(0,210,106,0.1)", color: "#00D26A" } : undefined}
        className={
          variant === "icon"
            ? "inline-flex h-7 w-7 items-center justify-center rounded-[4px] border border-[#2A2A2A] text-[#6B6B6B] transition hover:border-[#00FF88]/30 hover:text-[#00FF88]"
            : "inline-flex items-center gap-1 rounded-[4px] border border-[#2A2A2A] bg-[#1A1A1A] px-2 py-1 text-[10px] font-medium text-[#6B6B6B] transition hover:border-[#00FF88]/30 hover:text-[#00FF88]"
        }
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 2v9" />
          <path d="m4.5 7.5 3.5 3.5 3.5-3.5" />
          <path d="M2.5 13.5h11" />
        </svg>
        {variant === "button" && <span>Export</span>}
      </button>

      {/* Bottom-sheet popup — slides up from bottom of sidebar viewport */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            aria-hidden
            style={{
              position:   "fixed",
              inset:      0,
              zIndex:     9998,
              background: "rgba(0,0,0,0.45)",
              opacity:    visible ? 1 : 0,
              transition: visible
                ? "opacity 200ms ease-out"
                : "opacity 150ms ease-in",
            }}
          />

          {/* Sheet */}
          <div
            role="menu"
            aria-label="Export session"
            style={{
              position:     "fixed",
              bottom:       0,
              left:         0,
              right:        0,
              zIndex:       9999,
              background:   "#1A1A1A",
              borderTop:    "1px solid #2A2A2A",
              borderRadius: "12px 12px 0 0",
              transform:    visible ? "translateY(0)" : "translateY(100%)",
              opacity:      visible ? 1 : 0,
              transition:   visible
                ? "transform 200ms ease-out, opacity 200ms ease-out"
                : "transform 150ms ease-in,  opacity 150ms ease-in",
              boxShadow:    "0 -8px 32px rgba(0,0,0,0.6)",
            }}
          >
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div style={{ width: 36, height: 4, borderRadius: 2, background: "#3A3A3A" }} />
            </div>

            <div className="border-b border-[#2A2A2A] px-4 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-[#6B6B6B]">
              Export Session
            </div>

            {session ? (
              ITEMS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  disabled={busy !== null}
                  onClick={() => void pick(item)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-[#F5F5F5] transition-colors disabled:opacity-50"
                  style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#222222"; (e.currentTarget as HTMLButtonElement).querySelector("span")!.style.color = "#00D26A"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; (e.currentTarget as HTMLButtonElement).querySelector("span")!.style.color = "#6B6B6B"; }}
                >
                  <span style={{ fontSize: 16, lineHeight: 1, color: "#6B6B6B", transition: "color 100ms" }}>{item.icon}</span>
                  <span className="flex-1 text-xs font-medium">{item.label}</span>
                  {item.ext && (
                    <span className="text-[9px] uppercase tracking-wider" style={{ color: "#3A3A3A" }}>
                      {busy === item.id ? "\u2026" : item.ext}
                    </span>
                  )}
                  {!item.ext && busy === item.id && (
                    <span className="text-[9px] text-[#3A3A3A]">\u2026</span>
                  )}
                </button>
              ))
            ) : (
              <div className="px-4 py-4 text-xs text-[#4A4A4A]">Select a session first</div>
            )}

            <div style={{ height: "env(safe-area-inset-bottom, 8px)", minHeight: 8 }} />
          </div>
        </>
      )}
    </div>
  );
}
