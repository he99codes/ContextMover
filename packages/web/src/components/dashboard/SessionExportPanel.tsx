"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { useMemo, useState } from "react";
import { Copy, Check, Download, AlertCircle, FileCode2 } from "lucide-react";
import {
  EXPORT_FORMATS,
  copyToClipboard,
  downloadExport,
  renderExport,
  type ExportFormat,
} from "@/lib/exporter";
import type { Session } from "@/types";
import { cn } from "@/lib/utils";

interface Props {
  session: Session;
}

const ORDER: ExportFormat[] = ["xml", "markdown", "plaintext", "json", "txt"];

export function SessionExportPanel({ session }: Props) {
  const [format, setFormat] = useState<ExportFormat>("xml");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackContent, setFallbackContent] = useState<string | null>(null);

  // Render the preview synchronously when format/session changes. Memoised so
  // toggling the panel does not pay re-render cost on every keystroke elsewhere.
  const preview = useMemo(() => {
    try {
      return renderExport(session, format);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export render failed.";
      setError(msg);
      return "";
    }
  }, [session, format]);

  const meta = EXPORT_FORMATS[format];
  const previewExcerpt = preview.length > 4000 ? `${preview.slice(0, 4000)}\n\n…(truncated for preview, full content downloads)` : preview;

  async function handleCopy() {
    setError(null);
    try {
      await copyToClipboard(preview);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Clipboard write failed.";
      setError(msg);
      setFallbackContent(preview);
    }
  }

  function handleDownload() {
    setError(null);
    try {
      downloadExport(session, format);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed — try again.";
      setError(msg);
    }
  }

  return (
    <div className="rounded-[8px] border border-[#2A2A2A] bg-[#1A1A1A]">
      <div className="flex items-center gap-2 border-b border-[#2A2A2A] px-5 py-3">
        <div className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] border border-[#00FF88]/20 bg-[#00FF88]/10 text-[#00FF88]">
          <FileCode2 size={14} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[#F5F5F5]">Export</div>
          <div className="text-[11px] text-[#6B6B6B]">
            Download or copy this session in 5 formats.
          </div>
        </div>
      </div>

      {/* Format picker */}
      <div className="grid grid-cols-1 gap-1.5 px-5 pt-4 sm:grid-cols-2">
        {ORDER.map((id) => {
          const m = EXPORT_FORMATS[id];
          const active = id === format;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setFormat(id)}
              className={cn(
                "flex items-center justify-between gap-2 rounded-[4px] border px-3 py-2 text-left transition",
                active
                  ? "border-[#00FF88]/30 bg-[#00FF88]/10 text-[#00FF88] shadow-[0_0_8px_rgba(0,255,136,0.08)]"
                  : "border-[#2A2A2A] bg-[#0A0A0A] text-[#F5F5F5] hover:border-[#3A3A3A]"
              )}
              aria-pressed={active}
            >
              <div className="min-w-0">
                <div className="text-xs font-semibold">{m.label}</div>
                <div className="mt-0.5 truncate text-[10px] text-[#6B6B6B]">
                  {m.description}
                </div>
              </div>
              <span className={cn(
                "shrink-0 rounded-[3px] border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider",
                active
                  ? "border-[#00FF88]/30 text-[#00FF88]"
                  : "border-[#2A2A2A] text-[#6B6B6B]"
              )}>
                .{m.extension}
              </span>
            </button>
          );
        })}
      </div>

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-2 px-5 pt-3">
        <button
          type="button"
          onClick={handleDownload}
          className="inline-flex items-center gap-1.5 rounded-[4px] bg-[#00FF88] px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-[#00D26A] hover:shadow-[0_0_10px_rgba(0,255,136,0.3)]"
        >
          <Download size={13} />
          Download {meta.label.toLowerCase()}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-[4px] border border-[#2A2A2A] bg-[#0A0A0A] px-3 py-1.5 text-xs font-medium text-[#F5F5F5] transition hover:border-[#00FF88]/30 hover:text-[#00FF88]"
        >
          {copied ? <Check size={13} className="text-[#00FF88]" /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy to clipboard"}
        </button>
      </div>

      {error && (
        <div className="mx-5 mt-3 flex items-start gap-2 rounded-[4px] border border-[#00FF88]/30 bg-[#00FF88]/10 px-3 py-2 text-[11px] text-[#00FF88]">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Preview */}
      <div className="px-5 pb-5 pt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-[#6B6B6B]">Preview</div>
          <div className="text-[10px] text-[#6B6B6B] tabular-nums">{preview.length.toLocaleString()} chars</div>
        </div>
        <pre className="max-h-[420px] overflow-auto rounded-[6px] border border-[#2A2A2A] bg-[#0A0A0A] px-3 py-3 text-[11px] leading-5 text-[#F5F5F5]/90 whitespace-pre-wrap break-words">
          {previewExcerpt || "(empty)"}
        </pre>
      </div>

      {fallbackContent && (
        <div className="border-t border-[#2A2A2A] px-5 py-3">
          <div className="mb-1.5 text-[11px] font-semibold text-[#F5F5F5]">
            Clipboard unavailable — copy manually:
          </div>
          <textarea
            readOnly
            className="h-32 w-full rounded-[4px] border border-[#2A2A2A] bg-[#0A0A0A] p-2 text-[11px] text-[#F5F5F5]"
            value={fallbackContent}
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
        </div>
      )}
    </div>
  );
}
