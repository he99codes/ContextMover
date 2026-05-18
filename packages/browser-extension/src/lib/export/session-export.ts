/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/export/session-export.ts
//
// Simple session-download utilities for the sidebar export bottom-sheet.
// Uses blob URLs (not data: URLs) so large sessions work reliably with
// chrome.downloads.download. The data: URL approach silently fails when
// the encoded string exceeds Chrome's URL length limit (~2 MB).

import type { ContextSession } from "@/lib/types";

// ── Internals ────────────────────────────────────────────────────────────────

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "session";
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().split("T")[0];
}

function filename(session: ContextSession, ext: string): string {
  const slug = slugify(session.title || `${session.platform}-session`);
  const date = formatDate(session.updatedAt ?? session.createdAt ?? Date.now());
  return `${session.platform}_${date}_${slug}.${ext}`;
}

/**
 * Download using chrome.downloads (blob URL) in extension contexts,
 * or fall back to an anchor-click in web contexts.
 */
function download(content: string, name: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url  = URL.createObjectURL(blob);

  if (
    typeof chrome !== "undefined" &&
    chrome.downloads &&
    typeof chrome.downloads.download === "function"
  ) {
    chrome.downloads.download({ url, filename: name, saveAs: false }, () => {
      URL.revokeObjectURL(url);
    });
    return;
  }

  // Fallback for non-extension contexts.
  const a = document.createElement("a");
  a.href     = url;
  a.download = name;
  a.rel      = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// ── Markdown builder (shared by exportAsMarkdown + copySessionToClipboard) ───

export function buildMarkdown(session: ContextSession): string {
  const date = formatDate(session.updatedAt ?? session.createdAt ?? Date.now());
  const lines: string[] = [
    `## ${session.platform} | ${session.title ?? "Untitled"} | ${date}`,
    "",
  ];
  for (const m of session.messages) {
    lines.push(m.role === "user" ? "**User:**" : "**Assistant:**");
    lines.push(m.content);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

export function exportAsMarkdown(session: ContextSession): void {
  download(buildMarkdown(session), filename(session, "md"), "text/markdown");
}

export function exportAsText(session: ContextSession): void {
  const date = formatDate(session.updatedAt ?? session.createdAt ?? Date.now());
  const lines: string[] = [
    `${session.platform} | ${session.title ?? "Untitled"} | ${date}`,
    "=".repeat(60),
    "",
  ];
  for (const m of session.messages) {
    lines.push(m.role === "user" ? "You:" : "AI:");
    lines.push(m.content);
    lines.push("");
  }
  download(lines.join("\n"), filename(session, "txt"), "text/plain");
}

export function exportAsJSON(session: ContextSession): void {
  download(
    JSON.stringify(session, null, 2),
    filename(session, "json"),
    "application/json"
  );
}

export function exportAsCSV(session: ContextSession): void {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = [
    ["role", "content", "timestamp"].join(","),
    ...session.messages.map((m) =>
      [
        esc(m.role),
        esc(m.content ?? ""),
        esc(m.timestamp ? new Date(m.timestamp).toISOString() : ""),
      ].join(",")
    ),
  ];
  download(rows.join("\n"), filename(session, "csv"), "text/csv");
}

export async function copySessionToClipboard(session: ContextSession): Promise<void> {
  if (!navigator.clipboard) throw new Error("Clipboard API not available.");
  await navigator.clipboard.writeText(buildMarkdown(session));
}
