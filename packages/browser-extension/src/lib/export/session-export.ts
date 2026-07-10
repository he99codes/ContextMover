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

const PLATFORM_LABELS: Record<string, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Google Gemini",
  grok: "xAI Grok",
  perplexity: "Perplexity",
  deepseek: "DeepSeek",
};

function formatTimestamp(ts: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  } catch {
    return "";
  }
}

function detectAndFormatCode(content: string): string {
  if (content.includes("```")) return content;
  const lines = content.split("\n");
  const codeLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{4,}\S/.test(lines[i]) && !/^\s*$/.test(lines[i])) codeLines.push(i);
  }
  if (codeLines.length < 3) return content;
  const first = codeLines[0];
  const last = codeLines[codeLines.length - 1];
  if (last - first + 1 !== codeLines.length) return content;
  const before = lines.slice(0, first).join("\n").trimEnd();
  const codeBlock = lines.slice(first, last + 1).map((l) => l.replace(/^\s{4}/, "")).join("\n");
  const after = lines.slice(last + 1).join("\n").trimStart();
  let lang = "";
  if (/^\s*(function|const|let|var|import|export|class|interface|type|async|await)\b/.test(codeBlock)) lang = "typescript";
  else if (/^\s*(def|class|import|from|print|return|if __name__)/.test(codeBlock)) lang = "python";
  else if (/^\s*(func|package|import|var)/.test(codeBlock)) lang = "go";
  else if (/^\s*(public|private|class|void|int|static)/.test(codeBlock)) lang = "java";
  const parts: string[] = [];
  if (before) parts.push(before);
  parts.push("```" + lang + "\n" + codeBlock + "\n```");
  if (after) parts.push(after);
  return parts.join("\n\n");
}

export function buildMarkdown(session: ContextSession): string {
  const date = formatDate(session.updatedAt ?? session.createdAt ?? Date.now());
  const platformLabel = PLATFORM_LABELS[session.platform] ?? session.platform;
  const title = session.title ?? "Untitled";
  const msgCount = session.messages.length;
  const showTOC = msgCount >= 10;

  const lines: string[] = [];

  // YAML front matter
  lines.push("---");
  lines.push(`platform: ${platformLabel}`);
  lines.push(`title: "${title.replace(/"/g, '\\"')}"`);
  lines.push(`date: ${date}`);
  if (session.id) lines.push(`session_id: ${session.id}`);
  lines.push(`message_count: ${msgCount}`);
  lines.push("exported_by: ContextMover");
  lines.push("---");
  lines.push("");

  // Header
  lines.push(`# ${platformLabel} — ${title}`);
  lines.push("");
  lines.push(`> Exported on ${date} via ContextMover`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Table of contents for long sessions
  if (showTOC) {
    lines.push("## Table of Contents");
    lines.push("");
    for (let i = 0; i < msgCount; i++) {
      const m = session.messages[i];
      const roleLabel = m.role === "user" ? "User" : "Assistant";
      const preview = m.content.slice(0, 50).replace(/[\n\r]+/g, " ").trim();
      lines.push(`${i + 1}. [Message ${i + 1} — ${roleLabel}](#message-${i + 1}) — ${preview}…`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // Messages
  for (let i = 0; i < msgCount; i++) {
    const m = session.messages[i];
    const roleLabel = m.role === "user" ? "User" : "Assistant";
    const ts = formatTimestamp(m.timestamp);

    lines.push(`## Message ${i + 1}`);
    lines.push("");
    lines.push(`**Role:** ${roleLabel}`);
    if (ts) lines.push(`**Time:** ${ts}`);
    lines.push("");
    lines.push(detectAndFormatCode(m.content ?? ""));
    lines.push("");
    lines.push("---");
    if (i < msgCount - 1) lines.push("");
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
