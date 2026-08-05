/**
 * Copyright (c) 2026 ContextMover. All rights reserved.
 * Proprietary and confidential.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContextSession, Platform } from "@/lib/types";
import { PlatformBadge } from "@/components/PlatformLogo";

const PLATFORM_COLORS: Record<Platform, string> = {
  claude: "#E5E5E5",
  chatgpt: "#E5E5E5",
  gemini: "#E5E5E5",
  grok: "#E11D48",
  perplexity: "#06B6D4",
  deepseek: "#8B5CF6",
};

interface Props {
  sessions: ContextSession[];
  excludeIds: string[];
  onAdd: (ids: string[]) => void;
  onClose: () => void;
}

export default function MultiSessionPicker({ sessions, excludeIds, onAdd, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const excludeSet = useMemo(() => new Set(excludeIds), [excludeIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions
      .filter((s) => !excludeSet.has(s.id))
      .filter((s) => !q || (s.title ?? "").toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions, excludeSet, query]);

  const maxAdd = 5;
  const remaining = maxAdd - selectedIds.size;

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < maxAdd) {
        next.add(id);
      }
      return next;
    });
  }

  function handleConfirm() {
    onAdd([...selectedIds]);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return createPortal(
    <div
      onClick={onClose}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)",
        opacity: visible ? 1 : 0,
        transition: "opacity 160ms ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "90%",
          maxWidth: "420px",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: "#0a0a0a",
          border: "1px solid #1A1A2A",
          borderRadius: "8px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.6), 0 0 24px rgba(99,102,241,0.1)",
          overflow: "hidden",
          transform: visible ? "translateY(0)" : "translateY(8px)",
          transition: "transform 160ms ease-out",
        }}
      >
        {/* Header */}
        <div style={{ padding: "10px 12px 8px", borderBottom: "1px solid #141414" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: "11px", fontWeight: 700, color: "#F5F5F5", letterSpacing: "0.02em" }}>
              Add Another Session
            </span>
            <button
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                color: "#6B6B6B",
                cursor: "pointer",
                fontSize: "14px",
                lineHeight: 1,
              }}
            >
              x
            </button>
          </div>
          <div style={{ marginTop: "8px", position: "relative" }}>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations..."
              style={{
                width: "100%",
                background: "#050505",
                border: "1px solid #1A1A2A",
                borderRadius: "4px",
                padding: "5px 8px",
                fontSize: "10px",
                color: "#F5F5F5",
                outline: "none",
              }}
            />
          </div>
        </div>

        {/* Session list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "16px", textAlign: "center", fontSize: "10px", color: "#9CA3AF" }}>
              {sessions.length === 0 ? "No sessions available" : "No results"}
            </div>
          ) : (
            filtered.map((s) => {
              const isSelected = selectedIds.has(s.id);
              const pColor = PLATFORM_COLORS[s.platform];
              return (
                <button
                  key={s.id}
                  onClick={() => toggle(s.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    width: "100%",
                    padding: "6px 12px",
                    background: isSelected ? "rgba(99,102,241,0.08)" : "transparent",
                    border: "none",
                    borderBottom: "1px solid #0D0D0D",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 100ms",
                  }}
                >
                  {/* Checkbox */}
                  <span
                    style={{
                      width: "14px",
                      height: "14px",
                      borderRadius: "3px",
                      border: isSelected ? "1px solid #E5E5E5" : "1px solid #2A2A2A",
                      background: isSelected ? "#E5E5E5" : "transparent",
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "9px",
                      color: "#fff",
                    }}
                  >
                    {isSelected ? "✓" : ""}
                  </span>
                  <PlatformBadge platform={s.platform} logoSize={8} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "10px",
                        fontWeight: 500,
                        color: "#F5F5F5",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {s.title}
                    </div>
                    <div style={{ fontSize: "8px", color: "#6B6B6B" }}>
                      {s.messages.length} turns
                    </div>
                  </div>
                  <span
                    style={{
                      width: "3px",
                      height: "20px",
                      borderRadius: "2px",
                      background: pColor,
                      flexShrink: 0,
                    }}
                  />
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "8px 12px",
            borderTop: "1px solid #141414",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
          }}
        >
          <span style={{ fontSize: "8px", color: "#9CA3AF" }}>
            {selectedIds.size}/{maxAdd} selected
            {remaining <= 2 && remaining > 0 && ` · ${remaining} left`}
          </span>
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              onClick={onClose}
              style={{
                padding: "4px 12px",
                background: "transparent",
                border: "1px solid #2A2A2A",
                borderRadius: "4px",
                color: "#6B6B6B",
                fontSize: "9px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={selectedIds.size === 0}
              style={{
                padding: "4px 12px",
                background: selectedIds.size > 0 ? "#E5E5E5" : "#1A1A2A",
                border: "none",
                borderRadius: "4px",
                color: selectedIds.size > 0 ? "#fff" : "#3A3A3A",
                fontSize: "9px",
                fontWeight: 700,
                cursor: selectedIds.size > 0 ? "pointer" : "not-allowed",
              }}
            >
              Add Selected ({selectedIds.size})
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
