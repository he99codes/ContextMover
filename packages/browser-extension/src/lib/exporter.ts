// packages/browser-extension/src/lib/exporter.ts
//
// Format-agnostic export engine.  Produces 5 deterministic, well-structured
// formats from a ContextSession:
//
//   exportAsXML       — Claude-optimized <context_migration> envelope
//   exportAsMarkdown  — ChatGPT/Grok-friendly fenced-code Markdown
//   exportAsPlainText — Gemini-friendly bracketed sections
//   exportAsJSON      — pretty-printed canonical session
//   exportAsTXT       — clean human-readable transcript
//
// Plus DOM helpers: triggerDownload, copyToClipboard, getFilename.

import type { ContextSession, Message, Platform } from "@/lib/types";

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

// ── Validation ───────────────────────────────────────────────────────────────
function validateForExport(session: ContextSession): void {
  if (!session) throw new Error("No session provided.");
  if (!Array.isArray(session.messages) || session.messages.length === 0) {
    throw new Error("Session has no messages.");
  }
  const ts = session.updatedAt ?? session.createdAt ?? Date.now();
  if (!Number.isFinite(ts) || ts <= 0) {
    throw new Error("Session has an invalid timestamp.");
  }
}

// ── Public formatter API ────────────────────────────────────────────────────
export function exportAsXML(session: ContextSession): string {
  validateForExport(session);
  const ctx = analyse(session);
  const meta = sessionMeta(session);

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

export function exportAsMarkdown(session: ContextSession): string {
  validateForExport(session);
  const ctx = analyse(session);
  const meta = sessionMeta(session);

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

  const conversationLines = session.messages
    .map((m) => `**${m.role === "user" ? "User" : "Assistant"}:** ${m.content}`)
    .join("\n\n");

  return [
    `# ContextForge Export`,
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

export function exportAsPlainText(session: ContextSession): string {
  validateForExport(session);
  const ctx = analyse(session);
  const meta = sessionMeta(session);

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

  const conv = session.messages
    .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`)
    .join("\n\n");

  return [
    `[CONTEXTFORGE EXPORT]`,
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

export function exportAsJSON(session: ContextSession): string {
  validateForExport(session);
  return JSON.stringify(session, null, 2);
}

export function exportAsTXT(session: ContextSession): string {
  validateForExport(session);
  const meta = sessionMeta(session);
  const lines: string[] = [
    `--- ContextForge Export ---`,
    `Platform: ${meta.platform}`,
    `Date:     ${meta.humanDate}`,
    `Title:    ${meta.title}`,
    `Messages: ${meta.messageCount}`,
    `---`,
    ``,
  ];
  for (const m of session.messages) {
    const speaker = m.role === "user" ? "You" : capitalize(meta.platform);
    lines.push(`${speaker}:`);
    lines.push(m.content);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Render dispatcher ───────────────────────────────────────────────────────
export function renderExport(session: ContextSession, format: ExportFormat): string {
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
  // Some browsers (Firefox) require the anchor to be in the DOM to fire click.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Defer revocation so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function copyToClipboard(content: string): Promise<void> {
  if (!navigator.clipboard) {
    throw new Error("Clipboard API is not available in this context.");
  }
  await navigator.clipboard.writeText(content);
}

export function getFilename(session: ContextSession, format: ExportFormat): string {
  const meta = sessionMeta(session);
  const slug = slugify(meta.title || `${meta.platform}-session`).slice(0, 30) || "session";
  const ext = EXPORT_FORMATS[format].extension;
  return `contextforge_${meta.platform}_${meta.dateStamp}_${slug}.${ext}`;
}

export function downloadExport(session: ContextSession, format: ExportFormat): void {
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
  tail: Message[];
}

function analyse(session: ContextSession): AnalysedContext {
  const userMessages = session.messages.filter((m) => m.role === "user");
  const assistantMessages = session.messages.filter((m) => m.role === "assistant");

  const primaryGoal = bestSentence(userMessages.slice(0, 3), "primary intent")
    || `Continue the existing ${session.platform} conversation.`;

  const currentFocus = bestSentence(userMessages.slice(-3), "latest direction")
    || primaryGoal;

  const completed = extractCompleted(assistantMessages);
  const pending = extractPending(userMessages);

  const decisions = extractDecisions(assistantMessages);
  const facts = extractFacts(assistantMessages);

  const codeBlocks = collectCodeBlocks(session.messages);
  const tail = session.messages.slice(-6);

  return {
    primaryGoal,
    currentFocus,
    completed,
    pending,
    decisions,
    facts,
    codeBlocks,
    tail,
  };
}

function bestSentence(messages: Message[], _label: string): string {
  for (const m of messages) {
    const sentence = firstMeaningfulSentence(m.content);
    if (sentence) return sentence;
  }
  return "";
}

function firstMeaningfulSentence(text: string): string {
  if (!text) return "";
  // Strip code fences before looking for sentences.
  const stripped = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  const match = stripped.match(/[^.?!]{8,300}[.?!]/);
  const sentence = (match ? match[0] : stripped).trim();
  return sentence.length > 280 ? `${sentence.slice(0, 277)}…` : sentence;
}

const COMPLETED_PATTERNS = [
  /\b(?:done|completed|finished|implemented|fixed|added|created|deployed|merged|shipped)\b/i,
  /\b(?:we|I|you)\s+(?:have|already|just)\b/i,
];

function extractCompleted(assistantMessages: Message[]): string[] {
  const items: string[] = [];
  for (const m of assistantMessages) {
    const sentences = splitSentences(m.content);
    for (const s of sentences) {
      if (COMPLETED_PATTERNS.some((p) => p.test(s)) && s.length < 220) {
        const clean = s.trim();
        if (clean && !items.includes(clean)) items.push(clean);
        if (items.length >= 8) return items;
      }
    }
  }
  return items;
}

const PENDING_PATTERNS = [
  /\?\s*$/,
  /\b(?:todo|pending|next|need\s+to|should|might|could|how\s+do|why\s+does|what\s+about)\b/i,
];

function extractPending(userMessages: Message[]): string[] {
  const items: string[] = [];
  for (const m of userMessages.slice(-6)) {
    const sentences = splitSentences(m.content);
    for (const s of sentences) {
      if (PENDING_PATTERNS.some((p) => p.test(s)) && s.length < 220) {
        const clean = s.trim();
        if (clean && !items.includes(clean)) items.push(clean);
        if (items.length >= 8) return items;
      }
    }
  }
  return items;
}

const DECISION_KEYWORDS = /\b(?:decided|chose|selected|using|opting|architect|approach|pattern)\b/i;
const FACT_KEYWORDS = /\b(?:must|requires|cannot|because|since|always|never|constraint|limit)\b/i;

function extractDecisions(assistantMessages: Message[]): string {
  const hits: string[] = [];
  for (const m of assistantMessages) {
    for (const s of splitSentences(m.content)) {
      if (DECISION_KEYWORDS.test(s) && s.length < 240) {
        hits.push(s.trim());
        if (hits.length >= 6) break;
      }
    }
    if (hits.length >= 6) break;
  }
  return hits.join(" ");
}

function extractFacts(assistantMessages: Message[]): string {
  const hits: string[] = [];
  for (const m of assistantMessages) {
    for (const s of splitSentences(m.content)) {
      if (FACT_KEYWORDS.test(s) && s.length < 240) {
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

function collectCodeBlocks(messages: Message[]): { language: string; code: string; context?: string }[] {
  const blocks: { language: string; code: string; context?: string }[] = [];
  for (const m of messages) {
    // Prefer pre-extracted blocks (from fetch interceptor) when present.
    const pre = (m as Message & { codeBlocks?: { language: string; code: string }[] }).codeBlocks;
    if (Array.isArray(pre) && pre.length > 0) {
      for (const b of pre) blocks.push({ language: b.language, code: b.code });
      continue;
    }
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

function sessionMeta(session: ContextSession): {
  platform: Platform;
  title: string;
  messageCount: number;
  isoDate: string;
  humanDate: string;
  dateStamp: string;
} {
  const ts = session.updatedAt ?? session.createdAt ?? Date.now();
  const d = new Date(ts);
  const fallbackTitle = `${capitalize(session.platform)} session ${d.toISOString().slice(0, 10)}`;
  const title = (session.title ?? "").trim() || fallbackTitle;
  return {
    platform: session.platform,
    title,
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
