/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/migrate/build/route.ts
//
// Migration prompt builder — assembles the final XML migration file.
// The exact XML schema, instructions_for_ai text, and tier-specific
// framing are the core ContextMover IP and are only generated here,
// server-side. The extension sends the data payload and receives back
// the ready-to-copy migration prompt.
//
// Auth:  Supabase JWT Bearer token
// Limit: 60 req / hour per user
//
// Input:
//   {
//     tier: 1 | 2 | 3,
//     platform: string,
//     sessionTitle: string,
//     messages: Message[],        // all messages (tier1) or tail-only (tier2/3)
//     summary?: IntelligentSummary, // tier2
//     chunks?: ChunkMessage[],    // tier3 — pre-selected relevant messages
//     task?: string,
//     attentionMap?: { highlightedFiles?: string[]; compressionRatio?: number }
//   }
//
// Output: { filename: string; content: string; charCount: number; estimatedTokens: number }

import { NextRequest, NextResponse } from "next/server";
import { getAuthUserFromRequest } from "@/lib/usage/helpers";
import { checkRateLimit } from "@/lib/rate-limiter";

export const runtime = "nodejs";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

interface CodeBlock {
  language: string;
  path?: string;
  code: string;
}

interface IntelligentSummary {
  goal: string;
  currentState: string;
  decisions: string[];
  bugsFixed: string[];
  completed: string[];
  pending: string[];
  codeBlocks: CodeBlock[];
  tail: Message[];
  originalCount: number;
  compressionRatio: number;
}

interface AttentionMeta {
  highlightedFiles?: string[];
  compressionRatio?: number;
}

interface BuildRequest {
  tier: 1 | 2 | 3;
  platform: string;
  sessionTitle: string;
  messages: Message[];
  originalCount?: number;
  summary?: IntelligentSummary;
  chunks?: Message[];
  task?: string;
  attentionMap?: AttentionMeta;
}

// ── File builders ─────────────────────────────────────────────────────────────
// [IP] The XML schema + instructions_for_ai are the core product IP.
// Modifying the instructions_for_ai text changes how well the receiving AI
// understands the migration context — this is a key differentiator.

function buildSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
}

function buildFilename(tier: number, platform: string, title: string): string {
  const names: Record<number, string> = { 1: "full", 2: "summary", 3: "attention" };
  const slug = buildSlug(title);
  const date = new Date().toISOString().slice(0, 10);
  return `contextmover-${names[tier]}-${platform}-${date}-${slug}.xml`;
}

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

function buildTier1(req: BuildRequest): string {
  const { platform, sessionTitle, messages } = req;
  return `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="1" type="full_context">

  <meta>
    <source_platform>${platform}</source_platform>
    <session_title>${cdata(sessionTitle)}</session_title>
    <message_count>${messages.length}</message_count>
    <exported_at>${new Date().toISOString()}</exported_at>
    <tier>Full Context — all messages verbatim</tier>
  </meta>

  <instructions_for_ai>
    This file contains the complete verbatim transcript of a previous AI conversation.
    You are resuming this session. Read the full exchange below.
    Then continue exactly where it left off — do not re-summarize, re-explain, or
    re-introduce any previously established context, decisions, or code.
    Your first response should be a direct continuation, not a recap.
  </instructions_for_ai>

  <conversation>
${messages.map((m, i) => `
    <message index="${i + 1}" role="${m.role}">
      ${cdata(m.content)}
    </message>`).join("")}
  </conversation>

</contextmover_migration>`;
}

function buildTier2(req: BuildRequest): string {
  const { platform, sessionTitle, messages, summary, task } = req;
  if (!summary) throw new Error("tier2 requires summary");

  const originalCount = summary.originalCount ?? messages.length;

  const codeSection =
    summary.codeBlocks?.length > 0
      ? `
  <code_blocks count="${summary.codeBlocks.length}">
${summary.codeBlocks
        .map(
          (cb, i) => `
    <code index="${i + 1}" language="${cb.language ?? "unknown"}"${cb.path ? ` path="${cb.path}"` : ""}>
      ${cdata(cb.code)}
    </code>`
        )
        .join("")}
  </code_blocks>`
      : "";

  const completedSection =
    summary.completed?.length > 0
      ? `
  <completed_tasks count="${summary.completed.length}">
${summary.completed.map((t, i) => `    <task index="${i + 1}">${cdata(t)}</task>`).join("\n")}
  </completed_tasks>`
      : "";

  const pendingSection =
    summary.pending?.length > 0
      ? `
  <pending_tasks count="${summary.pending.length}">
${summary.pending.map((t, i) => `    <task index="${i + 1}">${cdata(t)}</task>`).join("\n")}
  </pending_tasks>`
      : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="2" type="smart_summary">

  <meta>
    <source_platform>${platform}</source_platform>
    <session_title>${cdata(sessionTitle)}</session_title>
    <original_message_count>${originalCount}</original_message_count>
    <compression_ratio>${summary.compressionRatio ?? 0}%</compression_ratio>
    <exported_at>${new Date().toISOString()}</exported_at>
    <tier>Smart Summary — intelligently extracted</tier>
    ${task ? `<focus_task>${cdata(task)}</focus_task>` : ""}
  </meta>

  <instructions_for_ai>
    This is an intelligently compressed context snapshot of a ${originalCount}-message
    conversation (${summary.compressionRatio ?? 0}% compression).
    You are resuming this session. Read every section before responding.
    All decisions, bugs, and code below are from the original conversation.
    Continue exactly where it left off. Do not re-explain what was established.
    Honor every decision listed — do not revisit or second-guess them.
    Your first response must be a direct continuation.
  </instructions_for_ai>

  <goal>
    <primary>${cdata(summary.goal ?? "")}</primary>
    <current_state>${cdata(summary.currentState ?? "")}</current_state>
  </goal>

  <key_decisions count="${summary.decisions?.length ?? 0}">
${(summary.decisions ?? [])
      .map((d, i) => `    <decision index="${i + 1}">${cdata(d)}</decision>`)
      .join("\n")}
  </key_decisions>

  <bugs_fixed count="${summary.bugsFixed?.length ?? 0}">
${(summary.bugsFixed ?? [])
      .map((b, i) => `    <bug index="${i + 1}">${cdata(b)}</bug>`)
      .join("\n")}
  </bugs_fixed>
${completedSection}
${pendingSection}
${codeSection}

  <conversation_tail count="${summary.tail?.length ?? 0}">
${(summary.tail ?? [])
      .map(
        (m, i) => `
    <message index="${i + 1}" role="${m.role}">
      ${cdata(m.content)}
    </message>`
      )
      .join("")}
  </conversation_tail>

</contextmover_migration>`;
}

function buildTier3(req: BuildRequest): string {
  const { platform, sessionTitle, messages, chunks, task, attentionMap, originalCount } = req;
  const selected = chunks ?? messages;
  const msgCount = originalCount ?? messages.length;

  const attentionSection = attentionMap
    ? `
    <highlighted_files>
      ${(attentionMap.highlightedFiles ?? []).map((f) => `<file>${f}</file>`).join("\n      ")}
    </highlighted_files>
    <compression_ratio>${attentionMap.compressionRatio ?? 0}%</compression_ratio>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="3" type="attention_engine">

  <meta>
    <source_platform>${platform}</source_platform>
    <session_title>${cdata(sessionTitle)}</session_title>
    <original_message_count>${msgCount}</original_message_count>
    <retrieved_chunks>${selected.length}</retrieved_chunks>
    <task>${cdata(task ?? "")}</task>
    <exported_at>${new Date().toISOString()}</exported_at>
    <tier>Attention Engine — semantically focused</tier>
  </meta>

  <attention_engine>
    <task>${cdata(task ?? "")}</task>
    ${attentionSection}
  </attention_engine>

  <instructions_for_ai>
    This context was semantically filtered from a ${msgCount}-message conversation
    using the ContextMover Attention Engine. Only the messages most relevant to
    "${task ?? "the active task"}" are included — the rest were compressed away.
    You are resuming this session. Read every message in focused_context.
    Continue exactly where this conversation left off.
    Do not re-introduce, re-summarize, or re-explain anything already established.
    Your first response must directly address "${task ?? "the active task"}".
  </instructions_for_ai>

  <focused_context>
${selected
      .map(
        (m, i) => `
    <message index="${i + 1}" role="${m.role}">
      ${cdata(m.content)}
    </message>`
      )
      .join("")}
  </focused_context>

</contextmover_migration>`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await checkRateLimit(req, user.id, 60);
  if (!rl.ok) return rl.response;

  let body: BuildRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tier, platform, sessionTitle, messages } = body;

  if (![1, 2, 3].includes(tier)) {
    return NextResponse.json({ error: "tier must be 1, 2, or 3" }, { status: 400 });
  }
  if (!Array.isArray(messages)) {
    return NextResponse.json({ error: "messages must be an array" }, { status: 400 });
  }
  if (!platform || !sessionTitle) {
    return NextResponse.json({ error: "platform and sessionTitle are required" }, { status: 400 });
  }

  let content: string;
  try {
    if (tier === 1) content = buildTier1(body);
    else if (tier === 2) content = buildTier2(body);
    else content = buildTier3(body);
  } catch (err) {
    console.error("[migrate/build] error:", err);
    return NextResponse.json({ error: "Build failed" }, { status: 422 });
  }

  return NextResponse.json({
    filename: buildFilename(tier, platform, sessionTitle),
    content,
    charCount: content.length,
    estimatedTokens: Math.ceil(content.length / 4),
  });
}
