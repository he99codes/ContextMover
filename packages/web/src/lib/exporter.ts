// packages/web/src/lib/exporter.ts
//
// Web-app mirror of the extension exporter.  Adapts the Supabase `Session`
// row (snake_case timestamps, nullable title) to the canonical export shape
// before delegating to the same five formatters as the extension.

import type { Session, Platform } from "@/types";

export type ExportFormat = "xml" | "markdown" | "plaintext" | "json" | "txt";

export interface ExportFormatMeta {
  id: ExportFormat;
  label: string;
  description: string;
  extension: string;
  mimeType: string;
}

export const EXPORT_FORMATS: Record<ExportFormat, ExportFormatMeta> = {
  xml: {
    id: "xml",
    label: "XML",
    description: "Claude-optimized — structured context_migration envelope.",
    extension: "xml",
    mimeType: "application/xml",
  },
  markdown: {
    id: "markdown",
    label: "Markdown",
    description: "ChatGPT / Grok — readable headers, fenced code.",
    extension: "md",
    mimeType: "text/markdown",
  },
  plaintext: {
    id: "plaintext",
    label: "Plain text",
    description: "Gemini — bracketed sections, no formatting.",
    extension: "txt",
    mimeType: "text/plain",
  },
  json: {
    id: "json",
    label: "JSON",
    description: "Raw session — pretty-printed, developer-friendly.",
    extension: "json",
    mimeType: "application/json",
  },
  txt: {
    id: "txt",
    label: "Transcript",
    description: "Plain transcript — clean, human-readable.",
    extension: "txt",
    mimeType: "text/plain",
  },
};

interface NormalizedSession {
  id: string;
  platform: Platform;
  title: string;
  messages: { role: "user" | "assistant"; content: string; timestamp: number }[];
  createdAt: number;
  updatedAt: number;
}

function normalize(session: Session): NormalizedSession {
  if (!session) throw new Error("No session provided.");
  if (!Array.isArray(session.messages) || session.messages.length === 0) {
    throw new Error("Session has no messages.");
  }
  const createdAt = Date.parse(session.created_at) || Date.now();
  const updatedAt = Date.parse(session.updated_at) || createdAt;
  const fallbackTitle = `${capitalize(session.platform)} session ${new Date(updatedAt).toISOString().slice(0, 10)}`;
  return {
    id: session.id,
    platform: session.platform,
    title: (session.title ?? "").trim() || fallbackTitle,
    messages: session.messages.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: typeof m.timestamp === "number" ? m.timestamp : updatedAt,
    })),
    createdAt,
    updatedAt,
  };
}

// ── Public formatter API ────────────────────────────────────────────────────
export function exportAsXML(session: Session): string {
  const ns = normalize(session);
  const ctx = analyse(ns);
  const meta = sessionMeta(ns);

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<context_migration>`,
    `  <meta>`,
    `    <source_platform>${esc(meta.platform)}</source_platform>`,
    `    <captured_at>${esc(meta.isoDate)}</captured_at>`,
    `    <message_count>${meta.messageCount}</message_count>`,
    `    <session_title>${esc(meta.title)}</session_title>`,
    `  </meta>`,
    `  <goal>`,
    `    <primary>${esc(ctx.primaryGoal)}</primary>`,
    `    <current>${esc(ctx.currentFocus)}</current>`,
    `  </goal>`,
    `  <progress>`,
    `    <completed>${listAsXmlItems(ctx.completed, "    ")}</completed>`,
    `    <pending>${listAsXmlItems(ctx.pending, "    ")}</pending>`,
    `  </progress>`,
    `  <knowledge>`,
    `    <decisions>${esc(ctx.decisions)}</decisions>`,
    `    <facts>${esc(ctx.facts)}</facts>`,
    `  </knowledge>`,
    `  <code>`,
    ...ctx.codeBlocks.map((b) =>
      `    <snippet language="${esc(b.language || "text")}" context="${esc(b.context ?? "")}"><![CDATA[\n${b.code}\n]]></snippet>`
    ),
    `  </code>`,
    `  <conversation_tail>`,
    ...ctx.tail.map(
      (m) => `    <message role="${esc(m.role)}"><![CDATA[\n${m.content}\n]]></message>`
    ),
    `  </conversation_tail>`,
    `  <instructions>`,
    `    You are continuing a conversation migrated from ${esc(meta.platform)}.`,
    `    Current focus: ${esc(ctx.currentFocus)}`,
    `    Pick up exactly where the conversation left off.`,
    `    Do not re-explain what was already decided.`,
    `  </instructions>`,
    `</context_migration>`,
    "",
  ].join("\n");
}

export function exportAsMarkdown(session: Session): string {
  const ns = normalize(session);
  const ctx = analyse(ns);
  const meta = sessionMeta(ns);

  const completedList = ctx.completed.length
    ? ctx.completed.map((c) => `- ${c}`).join("\n")
    : "_None recorded._";
  const pendingList = ctx.pending.length
    ? ctx.pending.map((p) => `- ${p}`).join("\n")
    : "_None recorded._";

  const codeSection = ctx.codeBlocks.length
    ? ctx.codeBlocks
        .map((b) => `\`\`\`${b.language || ""}\n${b.code}\n\`\`\``)
        .join("\n\n")
    : "_No code blocks captured._";

  const conversationLines = ns.messages
    .map((m) => `**${m.role === "user" ? "User" : "Assistant"}:** ${m.content}`)
    .join("\n\n");

  return [
    `# ContextMover Export`,
    `**Source:** ${meta.platform}  `,
    `**Date:** ${meta.humanDate}  `,
    `**Messages:** ${meta.messageCount}  `,
    `**Title:** ${meta.title}`,
    ``,
    `## Original Goal`,
    ctx.primaryGoal,
    ``,
    `## Current Focus`,
    ctx.currentFocus,
    ``,
    `## Progress`,
    `### Completed`,
    completedList,
    ``,
    `### Pending`,
    pendingList,
    ``,
    `## Key Decisions`,
    ctx.decisions || "_None recorded._",
    ``,
    `## Established Facts`,
    ctx.facts || "_None recorded._",
    ``,
    `## Code`,
    codeSection,
    ``,
    `## Conversation`,
    conversationLines,
    ``,
    `## Instructions`,
    `Continue from where this conversation left off.`,
    `Current focus: ${ctx.currentFocus}`,
    ``,
  ].join("\n");
}

export function exportAsPlainText(session: Session): string {
  const ns = normalize(session);
  const ctx = analyse(ns);
  const meta = sessionMeta(ns);

  const completed = ctx.completed.length
    ? ctx.completed.map((c) => `- ${c}`).join("\n")
    : "(none)";
  const pending = ctx.pending.length
    ? ctx.pending.map((p) => `- ${p}`).join("\n")
    : "(none)";

  const code = ctx.codeBlocks.length
    ? ctx.codeBlocks
        .map((b) => `--- ${b.language || "code"} ---\n${b.code}\n--- end ---`)
        .join("\n\n")
    : "(none)";

  const conv = ns.messages
    .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`)
    .join("\n\n");

  return [
    `[CONTEXTMOVER EXPORT]`,
    `Source: ${meta.platform}`,
    `Date: ${meta.humanDate}`,
    `Messages: ${meta.messageCount}`,
    `Title: ${meta.title}`,
    ``,
    `[GOAL]`,
    ctx.primaryGoal,
    ``,
    `[CURRENT FOCUS]`,
    ctx.currentFocus,
    ``,
    `[PROGRESS - COMPLETED]`,
    completed,
    ``,
    `[PROGRESS - PENDING]`,
    pending,
    ``,
    `[DECISIONS]`,
    ctx.decisions || "(none)",
    ``,
    `[FACTS]`,
    ctx.facts || "(none)",
    ``,
    `[CODE]`,
    code,
    ``,
    `[CONVERSATION]`,
    conv,
    ``,
    `[TASK]`,
    `Continue from where this conversation left off.`,
    `Current focus: ${ctx.currentFocus}`,
    ``,
  ].join("\n");
}

export function exportAsJSON(session: Session): string {
  normalize(session); // validate
  return JSON.stringify(session, null, 2);
}

export function exportAsTXT(session: Session): string {
  const ns = normalize(session);
  const meta = sessionMeta(ns);
  const lines: string[] = [
    `--- ContextMover Export ---`,
    `Platform: ${meta.platform}`,
    `Date:     ${meta.humanDate}`,
    `Title:    ${meta.title}`,
    `Messages: ${meta.messageCount}`,
    `---`,
    ``,
  ];
  for (const m of ns.messages) {
    const speaker = m.role === "user" ? "You" : capitalize(meta.platform);
    lines.push(`${speaker}:`);
    lines.push(m.content);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Render dispatcher ───────────────────────────────────────────────────────
export function renderExport(session: Session, format: ExportFormat): string {
  switch (format) {
    case "xml":       return exportAsXML(session);
    case "markdown":  return exportAsMarkdown(session);
    case "plaintext": return exportAsPlainText(session);
    case "json":      return exportAsJSON(session);
    case "txt":       return exportAsTXT(session);
  }
}

// ── DOM helpers ─────────────────────────────────────────────────────────────
export function triggerDownload(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function copyToClipboard(content: string): Promise<void> {
  if (!navigator.clipboard) {
    throw new Error("Clipboard API is not available in this context.");
  }
  await navigator.clipboard.writeText(content);
}

export function getFilename(session: Session, format: ExportFormat): string {
  const ns = normalize(session);
  const meta = sessionMeta(ns);
  const slug = slugify(meta.title || `${meta.platform}-session`).slice(0, 30) || "session";
  const ext = EXPORT_FORMATS[format].extension;
  return `contextmover_${meta.platform}_${meta.dateStamp}_${slug}.${ext}`;
}

export function downloadExport(session: Session, format: ExportFormat): void {
  const content = renderExport(session, format);
  const filename = getFilename(session, format);
  triggerDownload(content, filename, EXPORT_FORMATS[format].mimeType);
}

// ── Internals ───────────────────────────────────────────────────────────────
interface AnalysedContext {
  primaryGoal: string;
  currentFocus: string;
  completed: string[];
  pending: string[];
  decisions: string;
  facts: string;
  codeBlocks: { language: string; code: string; context?: string }[];
  tail: NormalizedSession["messages"];
}

function analyse(session: NormalizedSession): AnalysedContext {
  const userMessages = session.messages.filter((m) => m.role === "user");
  const assistantMessages = session.messages.filter((m) => m.role === "assistant");

  const primaryGoal = bestSentence(userMessages.slice(0, 3))
    || `Continue the existing ${session.platform} conversation.`;
  const currentFocus = bestSentence(userMessages.slice(-3)) || primaryGoal;

  return {
    primaryGoal,
    currentFocus,
    completed: extractMatching(assistantMessages, COMPLETED_PATTERNS),
    pending: extractMatching(userMessages.slice(-6), PENDING_PATTERNS),
    decisions: extractKeyword(assistantMessages, DECISION_KEYWORDS),
    facts: extractKeyword(assistantMessages, FACT_KEYWORDS),
    codeBlocks: collectCodeBlocks(session.messages),
    tail: session.messages.slice(-6),
  };
}

function bestSentence(messages: NormalizedSession["messages"]): string {
  for (const m of messages) {
    const sentence = firstMeaningfulSentence(m.content);
    if (sentence) return sentence;
  }
  return "";
}

function firstMeaningfulSentence(text: string): string {
  if (!text) return "";
  const stripped = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  const match = stripped.match(/[^.?!]{8,300}[.?!]/);
  const sentence = (match ? match[0] : stripped).trim();
  return sentence.length > 280 ? `${sentence.slice(0, 277)}…` : sentence;
}

const COMPLETED_PATTERNS = [
  /\b(?:done|completed|finished|implemented|fixed|added|created|deployed|merged|shipped)\b/i,
  /\b(?:we|I|you)\s+(?:have|already|just)\b/i,
];
const PENDING_PATTERNS = [
  /\?\s*$/,
  /\b(?:todo|pending|next|need\s+to|should|might|could|how\s+do|why\s+does|what\s+about)\b/i,
];
const DECISION_KEYWORDS = /\b(?:decided|chose|selected|using|opting|architect|approach|pattern)\b/i;
const FACT_KEYWORDS = /\b(?:must|requires|cannot|because|since|always|never|constraint|limit)\b/i;

function extractMatching(messages: NormalizedSession["messages"], patterns: RegExp[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const s of splitSentences(m.content)) {
      if (patterns.some((p) => p.test(s)) && s.length < 220) {
        const clean = s.trim();
        if (clean && !out.includes(clean)) out.push(clean);
        if (out.length >= 8) return out;
      }
    }
  }
  return out;
}

function extractKeyword(messages: NormalizedSession["messages"], pattern: RegExp): string {
  const hits: string[] = [];
  for (const m of messages) {
    for (const s of splitSentences(m.content)) {
      if (pattern.test(s) && s.length < 240) {
        hits.push(s.trim());
        if (hits.length >= 6) break;
      }
    }
    if (hits.length >= 6) break;
  }
  return hits.join(" ");
}

function splitSentences(text: string): string[] {
  if (!text) return [];
  const stripped = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return stripped.split(/(?<=[.?!])\s+/).filter(Boolean);
}

function collectCodeBlocks(messages: NormalizedSession["messages"]): { language: string; code: string; context?: string }[] {
  const blocks: { language: string; code: string; context?: string }[] = [];
  for (const m of messages) {
    const re = /```([\w+\-./]*)\n?([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(m.content)) !== null) {
      const language = (match[1] ?? "").trim();
      const code = (match[2] ?? "").replace(/\n+$/, "");
      if (code) blocks.push({ language, code });
    }
  }
  return blocks;
}

function sessionMeta(session: NormalizedSession): {
  platform: Platform;
  title: string;
  messageCount: number;
  isoDate: string;
  humanDate: string;
  dateStamp: string;
} {
  const d = new Date(session.updatedAt);
  return {
    platform: session.platform,
    title: session.title,
    messageCount: session.messages.length,
    isoDate: d.toISOString(),
    humanDate: d.toLocaleString(),
    dateStamp: d.toISOString().slice(0, 10),
  };
}

function listAsXmlItems(items: string[], indent: string): string {
  if (items.length === 0) return "";
  const lines = items.map((i) => `${indent}  <item>${esc(i)}</item>`);
  return `\n${lines.join("\n")}\n${indent}`;
}

function esc(input: string): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function capitalize(input: string): string {
  return input ? input[0].toUpperCase() + input.slice(1) : input;
}
