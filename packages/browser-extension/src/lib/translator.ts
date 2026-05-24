/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/translator.ts
// Context Translation Adapter — formats extracted context per target model.
// Each builder uses payload.extracted (structured) when present and falls
// back to payload.summary (plain text) for backward compatibility.

import type { ExtractedContext, Message, MigrationPayload } from "./types";
import type { IntelligentSummary } from "./summarizer";
import type { AttentionMap } from "./attention-engine";
import {
  ANTI_INJECTION_PREAMBLE,
  sanitizeForXml,
  sanitizeForMarkdown,
  wrapArchivedContent,
} from "./prompt-sanitizer";

const MAX_VERBATIM = 6;

// ── Translation cache (TTL-based, max 5 entries, 60s expiry) ─────────────────
// Avoids rebuilding identical prompts on double-click, sidebar retry, or
// precomputed preview. SessionId in key prevents cross-session collisions.

interface TranslatorCacheEntry {
  prompt: string;
  builtAt: number;
}

const promptCache = new Map<string, TranslatorCacheEntry>();
const CACHE_TTL    = 60_000;
const MAX_CACHE_SIZE = 5;

function buildCacheKey(payload: MigrationPayload): string {
  return [
    payload.sourceSession?.id ?? "no-session",
    payload.targetPlatform,
    String(payload.tier ?? 1),
    payload.task ?? "",
    payload.promptTemplateId ?? "",
    payload.caveman ? "1" : "0",
    String(payload.summary?.length ?? 0),
    payload.ideContext ? String(payload.ideContext.length) : "0",
  ].join("|");
}

export default function buildMigrationPrompt(
  payload: MigrationPayload
): string {
  const key = buildCacheKey(payload);
  const cached = promptCache.get(key);

  if (cached && Date.now() - cached.builtAt < CACHE_TTL) {
    console.log("[ContextMover:translator] Cache hit");
    return cached.prompt;
  }

  const result = buildMigrationPromptInternal(payload);

  // Evict oldest entry when at capacity
  if (promptCache.size >= MAX_CACHE_SIZE) {
    const oldest = [...promptCache.entries()].sort((a, b) => a[1].builtAt - b[1].builtAt)[0][0];
    promptCache.delete(oldest);
  }
  promptCache.set(key, { prompt: result, builtAt: Date.now() });
  return result;
}

function buildMigrationPromptInternal(
  payload: MigrationPayload
): string {
  if (payload.summary === undefined && !payload.intelligentSummary) {
    throw new Error('[CM:translator] Empty payload — summarizer stage produced no output');
  }
  // Tier 2 — Smart Summary: delegate to dedicated structured builders.
  if (payload.tier === 2 && payload.intelligentSummary) {
    switch (payload.targetPlatform) {
      case "claude":  return buildClaudePromptTier2(payload);
      case "gemini":  return buildGeminiPromptTier2(payload);
      default:        return buildMarkdownPromptTier2(payload);
    }
  }

  let prompt: string;
  switch (payload.targetPlatform) {
    case "claude":     prompt = buildClaudePrompt(payload);      break;
    case "chatgpt":    prompt = buildChatGPTPrompt(payload);     break;
    case "gemini":     prompt = buildGeminiPrompt(payload);      break;
    case "grok":       prompt = buildGrokPrompt(payload);        break;
    case "perplexity": prompt = buildPerplexityPrompt(payload);  break;
    case "deepseek":   prompt = buildDeepSeekPrompt(payload);   break;
    default: {
      const _exhaustive: never = payload.targetPlatform;
      void _exhaustive;
      prompt = buildChatGPTPrompt(payload);
    }
  }

  // Inject Attention Engine block when summarizeWithAttention() was used.
  const map = payload.attentionMap as AttentionMap | undefined;
  const task = payload.task;
  if (!map || !task) return prompt;

  switch (payload.targetPlatform) {
    case "claude":
      // Inject inside <context_migration>, immediately before <goal>
      return prompt.replace(/\n  <goal>/, "\n" + buildAttentionBlockClaude(task, map) + "\n  <goal>");
    case "gemini":
      return buildAttentionBlockGemini(task, map) + prompt;
    default:
      return buildAttentionBlockMarkdown(task, map) + prompt;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE — Structured XML
// Claude parses XML tags natively. Every section has a semantic tag.
// Code blocks use raw fences inside tags — Claude reads this as plain text,
// not as markup, so no XML escaping is needed for code content.
// ─────────────────────────────────────────────────────────────────────────────
function buildClaudePrompt(payload: MigrationPayload): string {
  const { sourceSession, extracted: ex, ideContext } = payload;
  const now = new Date().toISOString();
  const tail = tailMessages(ex, sourceSession.messages);
  const primaryGoal = ex?.primaryGoal ?? payload.summary;
  const currentFocus = ex?.currentFocus ?? "See recent messages below";
  const ratio = payload.compressionRatio ?? 0;
  const tierLabel = (payload.tier ?? 1) === 3 ? "attention_engine" : (payload.tier ?? 1) === 2 ? "smart_summary" : "tier1";

  const meta = payload.metadata;
  const metaBlock = [
    `  <meta>`,
    `    <source_platform>${sourceSession.platform}</source_platform>`,
    `    <captured_at>${now}</captured_at>`,
    `    <message_count>${sourceSession.messages.length}</message_count>`,
    `    <compression_ratio>${ratio}%</compression_ratio>`,
    `    <migration_tier>${tierLabel}</migration_tier>`,
    `    <session_title>${sourceSession.title}</session_title>`,
    ...(meta?.model ? [`    <model>${meta.model}</model>`] : []),
    ...(meta?.temperature !== undefined ? [`    <temperature>${meta.temperature}</temperature>`] : []),
    `  </meta>`,
  ].join("\n");

  const systemBlock = meta?.systemPrompt
    ? `\n  <system_context>\n${indent(meta.systemPrompt, 4)}\n  </system_context>`
    : "";

  const toolsBlock = meta?.tools?.length
    ? `\n  <available_tools>\n${meta.tools.map((t) => `    <tool name="${t.name}"${t.description ? ` description="${t.description.replace(/"/g, "'")}"` : ""} />`).join("\n")}\n  </available_tools>`
    : "";

  const goalBlock = [
    `  <goal>`,
    `    <primary>`,
    indent(primaryGoal, 6),
    `    </primary>`,
    `    <current>`,
    indent(currentFocus, 6),
    `    </current>`,
    `  </goal>`,
  ].join("\n");

  const completedLines = ex?.completed.length
    ? ex.completed.map((c) => `      - ${c}`).join("\n")
    : `      (none extracted — see conversation_tail)`;
  const pendingLines = ex?.pending.length
    ? ex.pending.map((p) => `      - ${p}`).join("\n")
    : `      (none extracted — see conversation_tail)`;

  const progressBlock = [
    `  <progress>`,
    `    <completed>`,
    completedLines,
    `    </completed>`,
    `    <pending>`,
    pendingLines,
    `    </pending>`,
    `  </progress>`,
  ].join("\n");

  const knowledgeBlock = [
    `  <knowledge>`,
    `    <decisions>`,
    indent(ex?.decisions || "(none extracted)", 6),
    `    </decisions>`,
    `    <facts>`,
    indent(ex?.facts || "(none extracted)", 6),
    `    </facts>`,
    `  </knowledge>`,
  ].join("\n");

  let codeBlock = `  <code>`;
  if (ex?.codeBlocks.length) {
    for (const block of ex.codeBlocks) {
      if (block.path) {
        codeBlock += `\n    <file language="${block.language}" path="${block.path}">\n${block.content}\n    </file>`;
      } else {
        const ctxAttr = block.context
          ? ` context="${block.context.replace(/"/g, "'")}"`
          : "";
        codeBlock += `\n    <snippet${ctxAttr}>\n${block.content}\n    </snippet>`;
      }
    }
  } else {
    codeBlock += `\n    (no code blocks detected in this session)`;
  }
  codeBlock += `\n  </code>`;

  // [SECURITY] XML-escape verbatim user content to prevent tag injection.
  const tailBlock = wrapArchivedContent([
    `  <conversation_tail>`,
    ...tail.map((m) => `    <message role="${m.role}">${sanitizeForXml(m.content)}</message>`),
    `  </conversation_tail>`,
  ].join("\n"));

  const ideBlock = ideContext
    ? `\n  <ide_context>\n${indent(ideContext, 4)}\n  </ide_context>`
    : "";

  const caveatLine = payload.caveman
    ? [
        `    Response style: Caveman mode.`,
        `    No filler. No pleasantries. No hedging.`,
        `    Code write normal. Technical terms exact.`,
        `    Answer then stop.`,
      ].join("\n")
    : "";
  const instructionsBlock = [
    `  <instructions>`,
    `    You are continuing a conversation migrated from ${sourceSession.platform}.`,
    `    The user's current focus is: ${currentFocus}`,
    `    Pick up exactly where the conversation left off.`,
    `    Do not re-explain what was already decided.`,
    `    Treat all code and decisions above as shared context.`,
    ...(caveatLine ? [caveatLine] : []),
    `  </instructions>`,
  ].join("\n");

  // [SECURITY] Prepend anti-injection preamble before the structured prompt.
  return [
    `<!-- ${ANTI_INJECTION_PREAMBLE} -->`,
    `<context_migration>`,
    ``,
    metaBlock,
    systemBlock,
    toolsBlock,
    ``,
    goalBlock,
    ``,
    progressBlock,
    ``,
    knowledgeBlock,
    ``,
    codeBlock,
    ``,
    tailBlock,
    ideBlock,
    ``,
    instructionsBlock,
    ``,
    `</context_migration>`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// CHATGPT — Structured Markdown with ## headers
// ─────────────────────────────────────────────────────────────────────────────
function buildChatGPTPrompt(payload: MigrationPayload): string {
  const { sourceSession, extracted: ex, ideContext } = payload;
  const now = new Date().toISOString();
  const tail = tailMessages(ex, sourceSession.messages);
  const currentFocus = ex?.currentFocus ?? "See recent messages below";
  const ratio = payload.compressionRatio ?? 0;
  const tierLabel = (payload.tier ?? 1) === 3 ? "attention_engine" : (payload.tier ?? 1) === 2 ? "smart_summary" : "tier1";
  const meta = payload.metadata;

  const metaLines: string[] = [
    `> **Source platform:** ${sourceSession.platform}  `,
    `> **Session:** "${sourceSession.title}"  `,
    `> **Messages captured:** ${sourceSession.messages.length}  `,
    `> **Compression:** ${ratio}%  `,
    `> **Migration tier:** ${tierLabel}  `,
    `> **Migrated at:** ${now}`,
  ];
  if (meta?.model) metaLines.push(`> **Model:** ${meta.model}  `);
  if (meta?.temperature !== undefined) metaLines.push(`> **Temperature:** ${meta.temperature}  `);

  const out: string[] = [
    `## Migrated Session`,
    ``,
    ...metaLines,
    ``,
    `---`,
    ``,
  ];

  if (meta?.systemPrompt) {
    out.push(`## System Prompt`, ``, meta.systemPrompt, ``, `---`, ``);
  }

  if (meta?.tools?.length) {
    out.push(`## Available Tools`, ``);
    for (const t of meta.tools) {
      out.push(`- **${t.name}**${t.description ? `: ${t.description}` : ""}`);
    }
    out.push(``, `---`, ``);
  }

  out.push(
    `## Original Goal`,
    ``,
    ex?.primaryGoal ?? payload.summary,
    ``,
    `---`,
    ``,
    `## Progress`,
    ``,
    `### ✅ Completed`,
    ``,
    ex?.completed.length
      ? ex.completed.map((c) => `- ${c}`).join("\n")
      : "_Nothing extracted — check conversation tail_",
    ``,
    `### 🔲 Pending`,
    ``,
    ex?.pending.length
      ? ex.pending.map((p) => `- ${p}`).join("\n")
      : "_Nothing extracted — check conversation tail_",
    ``,
    `---`,
    ``,
    `## Key Decisions`,
    ``,
    ex?.decisions || "_No decisions extracted_",
    ``,
    `---`,
    ``,
    `## Code`,
    ``,
  );

  if (ex?.codeBlocks.length) {
    for (const block of ex.codeBlocks) {
      if (block.path) out.push(`### \`${block.path}\``, ``);
      else if (block.context) out.push(`_${block.context}_`, ``);
      out.push(`\`\`\`${block.language}`, block.content, `\`\`\``, ``);
    }
  } else {
    out.push(`_No code blocks detected in this session_`, ``);
  }

  if (ideContext) {
    out.push(`---`, ``, `## Project Files`, ``, ideContext, ``);
  }

  out.push(
    `---`,
    ``,
    `## Where We Left Off`,
    ``,
    // [SECURITY] Sanitize and delimit verbatim user messages.
    ...(() => [
      wrapArchivedContent(
        tail.flatMap((m) => [
          `**${m.role === "user" ? "User" : "Assistant"}:**`,
          ``,
          sanitizeForMarkdown(m.content),
          ``,
        ]).join("\n")
      ),
    ])(),
    `---`,
    ``,
    `## Instructions`,
    ``,
    `You have been provided with the full prior conversation context above.`,
    `The user's current focus is: **${currentFocus}**`,
    ``,
    `Continue seamlessly from where the conversation left off.`,
    `Do not re-explain decisions already made.`,
    `Treat all code above as shared, agreed-upon context.`,
    ...(payload.caveman ? [
      ``,
      `## Response Style`,
      ``,
      `Caveman mode. No filler. No pleasantries. No hedging. Code write normal. Technical terms exact. Answer then stop.`,
    ] : [])
  );

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// GROK — Casual Markdown, same sections as ChatGPT, conversational tone
// ─────────────────────────────────────────────────────────────────────────────
function buildGrokPrompt(payload: MigrationPayload): string {
  const { sourceSession, extracted: ex, ideContext } = payload;
  const now = new Date().toISOString();
  const tail = tailMessages(ex, sourceSession.messages);
  const currentFocus = ex?.currentFocus ?? "See recent messages below";
  const ratio = payload.compressionRatio ?? 0;
  const tierLabel = (payload.tier ?? 1) === 3 ? "attention_engine" : (payload.tier ?? 1) === 2 ? "smart_summary" : "tier1";
  const meta = payload.metadata;

  const metaLines: string[] = [
    `> **From:** ${sourceSession.platform} | **"${sourceSession.title}"** | ${sourceSession.messages.length} messages | Compression: ${ratio}% | Tier: ${tierLabel} | ${now}`,
  ];
  if (meta?.model) metaLines.push(`> **Model:** ${meta.model}  `);
  if (meta?.temperature !== undefined) metaLines.push(`> **Temperature:** ${meta.temperature}  `);

  const out: string[] = [
    `## ContextMover — Session Import (Grok)`,
    ``,
    ...metaLines,
    ``,
    `---`,
    ``,
    `## Original Goal`,
    ``,
    ex?.primaryGoal ?? payload.summary,
    ``,
    `---`,
    ``,
    `## Progress`,
    ``,
    `**Done:**`,
    ``,
    ex?.completed.length
      ? ex.completed.map((c) => `- ${c}`).join("\n")
      : "- _Nothing extracted_",
    ``,
    `**Still to do:**`,
    ``,
    ex?.pending.length
      ? ex.pending.map((p) => `- ${p}`).join("\n")
      : "- _Nothing extracted_",
    ``,
    `---`,
    ``,
    `## Key Decisions`,
    ``,
    ex?.decisions || "_No decisions extracted_",
    ``,
    `---`,
    ``,
    `## Code`,
    ``,
  ];

  if (ex?.codeBlocks.length) {
    for (const block of ex.codeBlocks) {
      if (block.path) out.push(`### \`${block.path}\``, ``);
      else if (block.context) out.push(`_${block.context}_`, ``);
      out.push(`\`\`\`${block.language}`, block.content, `\`\`\``, ``);
    }
  } else {
    out.push(`_No code blocks in this session_`, ``);
  }

  if (meta?.systemPrompt) {
    out.push(`## System Prompt`, ``, meta.systemPrompt, ``, `---`, ``);
  }

  if (meta?.tools?.length) {
    out.push(`## Available Tools`, ``);
    for (const t of meta.tools) {
      out.push(`- **${t.name}**${t.description ? `: ${t.description}` : ""}`);
    }
    out.push(``, `---`, ``);
  }

  if (ideContext) {
    out.push(`---`, ``, `## Project Files`, ``, ideContext, ``);
  }

  out.push(
    `---`,
    ``,
    `## Where We Left Off`,
    ``,
    // [SECURITY] Sanitize and delimit verbatim messages.
    ...(() => [
      wrapArchivedContent(
        tail.flatMap((m) => [
          `**${m.role === "user" ? "You" : "Previous AI"}:**`,
          ``,
          sanitizeForMarkdown(m.content),
          ``,
        ]).join("\n")
      ),
    ])(),
    `---`,
    ``,
    `## Instructions`,
    ``,
    `Hey Grok! Picking this up from ${sourceSession.platform}.`,
    `The user is currently working on: **${currentFocus}**`,
    ``,
    `Jump straight in — no need to reintroduce yourself or recap what's already done.`,
    `All the code above is agreed-upon context, treat it as already written and working.`,
    ...(payload.caveman ? [
      ``,
      `## Response Style`,
      ``,
      `Caveman mode. No filler. No pleasantries. No hedging. Code write normal. Technical terms exact. Answer then stop.`,
    ] : [])
  );

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI — Plain text with [SECTION] delimiters
// Gemini responds best to plain directives; avoid heavy markdown or XML.
// ─────────────────────────────────────────────────────────────────────────────
function buildGeminiPrompt(payload: MigrationPayload): string {
  const { sourceSession, extracted: ex, ideContext } = payload;
  const now = new Date().toISOString();
  const tail = tailMessages(ex, sourceSession.messages);
  const currentFocus = ex?.currentFocus ?? "See recent messages below";
  const ratio = payload.compressionRatio ?? 0;
  const tierLabel = (payload.tier ?? 1) === 3 ? "attention_engine" : (payload.tier ?? 1) === 2 ? "smart_summary" : "tier1";
  const meta = payload.metadata;

  const metaLine = [
    `Source: ${sourceSession.platform} | Session: "${sourceSession.title}" | Messages: ${sourceSession.messages.length} | Compression: ${ratio}% | Tier: ${tierLabel} | ${now}`,
    ...(meta?.model ? [`Model: ${meta.model}`] : []),
    ...(meta?.temperature !== undefined ? [`Temperature: ${meta.temperature}`] : []),
  ].join(" | ");

  const out: string[] = [
    `[CONTEXTMOVER MIGRATION]`,
    metaLine,
    ``,
    `[GOAL]`,
    ex?.primaryGoal ?? payload.summary,
    ``,
    `[PROGRESS]`,
    `Completed:`,
    ...(ex?.completed.length
      ? ex.completed.map((c) => `  - ${c}`)
      : [`  (none extracted)`]),
    ``,
    `Pending:`,
    ...(ex?.pending.length
      ? ex.pending.map((p) => `  - ${p}`)
      : [`  (none extracted)`]),
    ``,
    `[DECISIONS]`,
    ex?.decisions || "(none extracted)",
    ``,
    `[CODE]`,
  ];

  if (ex?.codeBlocks.length) {
    for (const block of ex.codeBlocks) {
      if (block.path) out.push(`File: ${block.path}`);
      else if (block.context) out.push(`Context: ${block.context}`);
      out.push(`\`\`\`${block.language}`, block.content, `\`\`\``, ``);
    }
  } else {
    out.push(`(no code blocks detected)`, ``);
  }

  if (meta?.systemPrompt) {
    out.push(`[SYSTEM PROMPT]`, meta.systemPrompt, ``);
  }

  if (meta?.tools?.length) {
    out.push(`[AVAILABLE TOOLS]`);
    for (const t of meta.tools) {
      out.push(`  - ${t.name}${t.description ? `: ${t.description}` : ""}`);
    }
    out.push(``);
  }

  if (ideContext) {
    out.push(`[PROJECT FILES]`, ideContext, ``);
  }

  out.push(
    `[CURRENT STATE]`,
    currentFocus,
    ``,
    `[RECENT MESSAGES]`,
    // [SECURITY] Sanitize and delimit verbatim messages.
    wrapArchivedContent(
      tail.flatMap((m) => [`${m.role.toUpperCase()}: ${sanitizeForMarkdown(m.content)}`, ``]).join("\n")
    ),
    `[TASK]`,
    `Continue the conversation from the context above.`,
    `The user is currently focused on: ${currentFocus}`,
    `Do not recap already-decided items. Pick up exactly where the conversation ended.`,
    ...(payload.caveman ? [
      ``,
      `[RESPONSE STYLE]`,
      `Caveman mode. No filler. No pleasantries. No hedging. Code write normal. Technical terms exact. Answer then stop.`,
    ] : [])
  );

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// PERPLEXITY — Plain text, no special formatting
// Perplexity is search-focused; plain text prevents it treating headings as
// search operators. No markdown headers, bold, or italic.
// ─────────────────────────────────────────────────────────────────────────────
function buildPerplexityPrompt(payload: MigrationPayload): string {
  const { sourceSession, extracted: ex, ideContext } = payload;
  const now = new Date().toISOString();
  const tail = tailMessages(ex, sourceSession.messages);
  const currentFocus = ex?.currentFocus ?? "See recent messages below";
  const ratio = payload.compressionRatio ?? 0;
  const tierLabel = (payload.tier ?? 1) === 3 ? "attention_engine" : (payload.tier ?? 1) === 2 ? "smart_summary" : "tier1";
  const meta = payload.metadata;

  const metaLine = [
    `Source: ${sourceSession.platform} | Session: "${sourceSession.title}" | Messages: ${sourceSession.messages.length} | Compression: ${ratio}% | Tier: ${tierLabel} | ${now}`,
    ...(meta?.model ? [`Model: ${meta.model}`] : []),
    ...(meta?.temperature !== undefined ? [`Temperature: ${meta.temperature}`] : []),
  ].join(" | ");

  const out: string[] = [
    `Migrated Context — Perplexity`,
    metaLine,
    ``,
    `GOAL`,
    ex?.primaryGoal ?? payload.summary,
    ``,
    `COMPLETED`,
    ...(ex?.completed.length
      ? ex.completed.map((c) => `  - ${c}`)
      : [`  (none extracted)`]),
    ``,
    `PENDING`,
    ...(ex?.pending.length
      ? ex.pending.map((p) => `  - ${p}`)
      : [`  (none extracted)`]),
    ``,
    `KEY DECISIONS`,
    ex?.decisions || "(none extracted)",
    ``,
    `CODE`,
  ];

  if (ex?.codeBlocks.length) {
    for (const block of ex.codeBlocks) {
      if (block.path) out.push(`File: ${block.path}`);
      else if (block.context) out.push(`Context: ${block.context}`);
      out.push(`\`\`\`${block.language}`, block.content, `\`\`\``, ``);
    }
  } else {
    out.push(`(no code blocks detected in this session)`, ``);
  }

  if (meta?.systemPrompt) {
    out.push(`SYSTEM PROMPT`, meta.systemPrompt, ``);
  }

  if (meta?.tools?.length) {
    out.push(`AVAILABLE TOOLS`);
    for (const t of meta.tools) {
      out.push(`  - ${t.name}${t.description ? `: ${t.description}` : ""}`);
    }
    out.push(``);
  }

  if (ideContext) {
    out.push(`PROJECT FILES`, ideContext, ``);
  }

  out.push(
    `RECENT CONVERSATION`,
    // [SECURITY] Sanitize and delimit verbatim messages.
    wrapArchivedContent(
      tail.flatMap((m) => [
        `${m.role === "user" ? "User" : "Perplexity"}: ${sanitizeForMarkdown(m.content)}`,
        ``,
      ]).join("\n")
    ),
    `TASK`,
    `This is a migrated conversation from ${sourceSession.platform}. Please continue it directly.`,
    `The user is currently focused on: ${currentFocus}`,
    ``,
    `Do not treat this as a new search query. Pick up exactly where the conversation ended,`,
    `treating all code and decisions above as established context.`,
    ...(payload.caveman ? [
      ``,
      `RESPONSE STYLE`,
      `Caveman mode. No filler. No pleasantries. No hedging. Code write normal. Technical terms exact. Answer then stop.`,
    ] : [])
  );

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// DEEPSEEK — Markdown with technical framing
// DeepSeek is strong at code; emphasise code blocks and technical context.
// ─────────────────────────────────────────────────────────────────────────────
function buildDeepSeekPrompt(payload: MigrationPayload): string {
  const { sourceSession, extracted: ex, ideContext } = payload;
  const now = new Date().toISOString();
  const tail = tailMessages(ex, sourceSession.messages);
  const currentFocus = ex?.currentFocus ?? "See recent messages below";
  const ratio = payload.compressionRatio ?? 0;
  const tierLabel = (payload.tier ?? 1) === 3 ? "attention_engine" : (payload.tier ?? 1) === 2 ? "smart_summary" : "tier1";
  const meta = payload.metadata;

  const metaLines: string[] = [
    `**Source:** ${sourceSession.platform} | **"${sourceSession.title}"** | ${sourceSession.messages.length} messages | Compression: ${ratio}% | Tier: ${tierLabel} | ${now}`,
  ];
  if (meta?.model) metaLines.push(`**Model:** ${meta.model}  `);
  if (meta?.temperature !== undefined) metaLines.push(`**Temperature:** ${meta.temperature}  `);

  const out: string[] = [
    `# ContextMover Migration → DeepSeek`,
    ``,
    ...metaLines,
    ``,
    `---`,
    ``,
    `## Objective`,
    ``,
    ex?.primaryGoal ?? payload.summary,
    ``,
    `## Current Focus`,
    ``,
    currentFocus,
    ``,
    `## Completed`,
    ``,
    ex?.completed.length
      ? ex.completed.map((c) => `- ${c}`).join("\n")
      : "_Nothing extracted_",
    ``,
    `## Pending`,
    ``,
    ex?.pending.length
      ? ex.pending.map((p) => `- ${p}`).join("\n")
      : "_Nothing extracted_",
    ``,
    `## Decisions & Facts`,
    ``,
    ex?.decisions || "_None extracted_",
    ``,
    `## Code Context`,
    ``,
  ];

  if (ex?.codeBlocks.length) {
    for (const block of ex.codeBlocks) {
      if (block.path) out.push(`### \`${block.path}\``, ``);
      else if (block.context) out.push(`_${block.context}_`, ``);
      out.push(`\`\`\`${block.language}`, block.content, `\`\`\``, ``);
    }
  } else {
    out.push(`_No code blocks detected in this session_`, ``);
  }

  if (meta?.systemPrompt) {
    out.push(`## System Prompt`, ``, meta.systemPrompt, ``, `---`, ``);
  }

  if (meta?.tools?.length) {
    out.push(`## Available Tools`, ``);
    for (const t of meta.tools) {
      out.push(`- **${t.name}**${t.description ? `: ${t.description}` : ""}`);
    }
    out.push(``, `---`, ``);
  }

  if (ideContext) {
    out.push(`---`, ``, `## Project Files`, ``, ideContext, ``);
  }

  out.push(
    `---`,
    ``,
    `## Recent Conversation`,
    ``,
    // [SECURITY] Sanitize and delimit verbatim messages.
    ...(() => [
      wrapArchivedContent(
        tail.flatMap((m) => [
          `**${m.role === "user" ? "User" : "Assistant"}:**`,
          ``,
          sanitizeForMarkdown(m.content),
          ``,
        ]).join("\n")
      ),
    ])(),
    `---`,
    ``,
    `## Task`,
    ``,
    `Continue this conversation from ${sourceSession.platform}.`,
    `Focus on: **${currentFocus}**`,
    ``,
    `All code above is established context — do not re-explain it.`,
    `Pick up exactly where the conversation ended.`,
    ...(payload.caveman ? [
      ``,
      `## Response Style`,
      ``,
      `Caveman mode. No filler. No pleasantries. No hedging. Code write normal. Technical terms exact. Answer then stop.`,
    ] : [])
  );

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 — Smart Summary builders
// One per format family: Claude XML / Markdown (ChatGPT, Grok, Perplexity,
// DeepSeek) / Gemini plain text.
// ─────────────────────────────────────────────────────────────────────────────

function buildClaudePromptTier2(payload: MigrationPayload): string {
  const is = payload.intelligentSummary as IntelligentSummary;
  const { sourceSession, ideContext } = payload;
  const now = new Date().toISOString();
  const ratio = payload.compressionRatio ?? is.compressionRatio ?? 0;

  const decisionsXml = is.decisions.length
    ? is.decisions.map((d) => `      - ${sanitizeForXml(d)}`).join("\n")
    : `      (none)`;
  const bugsXml = is.bugsFixed.length
    ? is.bugsFixed.map((b) => `      - ${sanitizeForXml(b)}`).join("\n")
    : `      (none)`;
  const completedXml = is.completed?.length
    ? is.completed.map((c) => `      - ${sanitizeForXml(c)}`).join("\n")
    : `      (none)`;
  const pendingXml = is.pending?.length
    ? is.pending.map((p) => `      - ${sanitizeForXml(p)}`).join("\n")
    : `      (none)`;

  let codeXml = "";
  for (const block of is.codeBlocks) {
    if (block.path) {
      codeXml += `\n    <file language="${block.language}" path="${block.path}">\n${block.code}\n    </file>`;
    } else {
      codeXml += `\n    <snippet language="${block.language}">\n${block.code}\n    </snippet>`;
    }
  }
  if (!codeXml) codeXml = `\n    (no code blocks detected)`;

  const tailXml = wrapArchivedContent(
    [
      `  <conversation_tail>`,
      ...is.tail.map(
        (m) => `    <message role="${m.role}">${sanitizeForXml(m.content)}</message>`
      ),
      `  </conversation_tail>`,
    ].join("\n")
  );

  const ideBlock = ideContext
    ? `\n  <ide_context>\n${indent(ideContext, 4)}\n  </ide_context>`
    : "";

  const caveatBlock = payload.caveman
    ? [
        `    Response style: Caveman mode.`,
        `    No filler. No pleasantries. No hedging.`,
        `    Code write normal. Technical terms exact.`,
        `    Answer then stop.`,
      ].join("\n")
    : "";

  return [
    `<!-- ${ANTI_INJECTION_PREAMBLE} -->`,
    `<context_migration>`,
    ``,
    `  <meta>`,
    `    <source_platform>${sourceSession.platform}</source_platform>`,
    `    <captured_at>${now}</captured_at>`,
    `    <message_count>${is.originalCount}</message_count>`,
    `    <compression_ratio>${ratio}%</compression_ratio>`,
    `    <migration_tier>smart_summary</migration_tier>`,
    `    <session_title>${sourceSession.title}</session_title>`,
    `  </meta>`,
    ``,
    `  <goal>`,
    `    <primary>${sanitizeForXml(is.goal)}</primary>`,
    `    <current>${sanitizeForXml(is.currentState)}</current>`,
    `  </goal>`,
    ``,
    `  <progress>`,
    `    <decisions>`,
    decisionsXml,
    `    </decisions>`,
    `    <bugs_fixed>`,
    bugsXml,
    `    </bugs_fixed>`,
    `  </progress>`,
    ``,
    `  <task_state>`,
    `    <completed>`,
    completedXml,
    `    </completed>`,
    `    <pending>`,
    pendingXml,
    `    </pending>`,
    `  </task_state>`,
    ``,
    ...(is.techStack?.length
      ? [
          `  <tech_stack>`,
          is.techStack.map((t) => `    <tech>${sanitizeForXml(t)}</tech>`).join("\n"),
          `  </tech_stack>`,
          ``,
        ]
      : []),
    `  <code>${codeXml}`,
    `  </code>`,
    ``,
    tailXml,
    ideBlock,
    ``,
    [
      `  <instructions>`,
      `    Continuing summarized session from ${sourceSession.platform}.`,
      `    Original: ${is.originalCount} messages compressed to smart summary.`,
      `    Current focus: ${sanitizeForXml(is.currentState)}`,
      `    Pick up exactly where left off.`,
      `    Do not re-explain what was already decided.`,
      ...(caveatBlock ? [caveatBlock] : []),
      `  </instructions>`,
    ].join("\n"),
    ``,
    `</context_migration>`,
  ].join("\n");
}

function buildMarkdownPromptTier2(payload: MigrationPayload): string {
  const is = payload.intelligentSummary as IntelligentSummary;
  const { sourceSession, ideContext } = payload;
  const now = new Date().toISOString();
  const ratio = payload.compressionRatio ?? is.compressionRatio ?? 0;

  const out: string[] = [
    `## Smart Summary Migration`,
    ``,
    `> **Source:** ${sourceSession.platform} | **Messages:** ${is.originalCount} | **Compression:** ${ratio}%  `,
    `> **Session:** "${sourceSession.title}" | **Migrated at:** ${now}`,
    ``,
    `---`,
    ``,
    `## Goal`,
    ``,
    is.goal,
    ``,
    `## Current Focus`,
    ``,
    is.currentState,
    ``,
    `---`,
    ``,
    `## Decisions`,
    ``,
    is.decisions.length
      ? is.decisions.map((d) => `- ${d}`).join("\n")
      : `_No decisions extracted_`,
    ``,
    `---`,
    ``,
    `## Bugs Fixed`,
    ``,
    is.bugsFixed.length
      ? is.bugsFixed.map((b) => `- ${b}`).join("\n")
      : `_No bugs extracted_`,
    ``,
    `---`,
    ``,
    `## Task State`,
    ``,
    is.completed?.length
      ? is.completed.map((c) => `- ✅ ${c}`).join("\n")
      : `_No completed items extracted_`,
    ``,
    is.pending?.length
      ? is.pending.map((p) => `- 🔲 ${p}`).join("\n")
      : `_No pending items extracted_`,
    ``,
    ...(is.techStack?.length
      ? [
          `---`,
          ``,
          `## Tech Stack`,
          ``,
          is.techStack.map((t) => `\`${t}\``).join(" · "),
          ``,
        ]
      : []),
    `---`,
    ``,
    `## Code`,
    ``,
  ];

  if (is.codeBlocks.length) {
    for (const block of is.codeBlocks) {
      if (block.path) out.push(`### \`${block.path}\``, ``);
      out.push(`\`\`\`${block.language}`, block.code, `\`\`\``, ``);
    }
  } else {
    out.push(`_No code blocks detected_`, ``);
  }

  if (ideContext) {
    out.push(`---`, ``, `## Project Files`, ``, ideContext, ``);
  }

  out.push(
    `---`,
    ``,
    `## Recent Conversation`,
    ``,
    wrapArchivedContent(
      is.tail
        .flatMap((m) => [
          `**${m.role === "user" ? "User" : "Assistant"}:**`,
          ``,
          sanitizeForMarkdown(m.content),
          ``,
        ])
        .join("\n")
    ),
    `---`,
    ``,
    `## Instructions`,
    ``,
    `Continuing summarized session from ${sourceSession.platform}.`,
    `Original: ${is.originalCount} messages compressed to smart summary.`,
    `Current focus: **${is.currentState}**`,
    ``,
    `Pick up exactly where left off. Do not re-explain what was already decided.`,
    ...(payload.caveman
      ? [
          ``,
          `## Response Style`,
          ``,
          `Caveman mode. No filler. No pleasantries. No hedging. Code write normal. Technical terms exact. Answer then stop.`,
        ]
      : [])
  );

  return out.join("\n");
}

function buildGeminiPromptTier2(payload: MigrationPayload): string {
  const is = payload.intelligentSummary as IntelligentSummary;
  const { sourceSession, ideContext } = payload;
  const now = new Date().toISOString();
  const ratio = payload.compressionRatio ?? is.compressionRatio ?? 0;

  const out: string[] = [
    `[CONTEXTMOVER SMART SUMMARY]`,
    `Source: ${sourceSession.platform} | Messages: ${is.originalCount} | Compression: ${ratio}% | ${now}`,
    ``,
    `[GOAL]`,
    is.goal,
    ``,
    `[CURRENT FOCUS]`,
    is.currentState,
    ``,
    `[DECISIONS]`,
    ...(is.decisions.length
      ? is.decisions.map((d) => `  - ${d}`)
      : [`  (none)`]),
    ``,
    `[BUGS FIXED]`,
    ...(is.bugsFixed.length
      ? is.bugsFixed.map((b) => `  - ${b}`)
      : [`  (none)`]),
    ``,
    ...(is.techStack?.length
      ? [`[TECH STACK]`, is.techStack.join(", "), ``]
      : []),
    `[CODE]`,
  ];

  if (is.codeBlocks.length) {
    for (const block of is.codeBlocks) {
      if (block.path) out.push(`File: ${block.path}`);
      out.push(`\`\`\`${block.language}`, block.code, `\`\`\``, ``);
    }
  } else {
    out.push(`(no code blocks detected)`, ``);
  }

  if (ideContext) {
    out.push(`[PROJECT FILES]`, ideContext, ``);
  }

  out.push(
    `[RECENT CONVERSATION]`,
    wrapArchivedContent(
      is.tail
        .flatMap((m) => [
          `${m.role.toUpperCase()}: ${sanitizeForMarkdown(m.content)}`,
          ``,
        ])
        .join("\n")
    ),
    `[TASK]`,
    `Continuing summarized session from ${sourceSession.platform}.`,
    `Original: ${is.originalCount} messages compressed to smart summary.`,
    `Current focus: ${is.currentState}`,
    `Pick up exactly where left off. Do not re-explain what was already decided.`,
    ...(payload.caveman
      ? [
          ``,
          `[RESPONSE STYLE]`,
          `Caveman mode. No filler. No pleasantries. No hedging. Code write normal. Technical terms exact. Answer then stop.`,
        ]
      : [])
  );

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────
// Attention Engine prompt blocks
// ─────────────────────────────────────────────────────────────────

function buildAttentionBlockClaude(task: string, map: AttentionMap): string {
  const files = map.highlightedFiles.length
    ? map.highlightedFiles.map((f) => `      <file>${f}</file>`).join("\n")
    : `      (none)`;
  const mods = map.highlightedModules.length
    ? map.highlightedModules.map((m) => `      <module>${m}</module>`).join("\n")
    : `      (none)`;
  return [
    `  <attention_engine>`,
    `    <task>${task}</task>`,
    `    <structural_context>`,
    indent(JSON.stringify(map.structuralContext, null, 2), 6),
    `    </structural_context>`,
    `    <attention_map>`,
    `      <threshold>${map.threshold}</threshold>`,
    `      <compression_ratio>${map.compressionRatio}%</compression_ratio>`,
    `      <highlighted_files>`,
    files,
    `      </highlighted_files>`,
    `      <highlighted_modules>`,
    mods,
    `      </highlighted_modules>`,
    `    </attention_map>`,
    `    <rules>`,
    `      Structural context above is the full application map.`,
    `      Keep 100% of it at all times.`,
    `      Only expand on code and decisions with high attention score.`,
    `      Compress or ignore everything else.`,
    `      Your focused task: ${task}`,
    `      Continuing focused work on: ${task}`,
    `    </rules>`,
    `  </attention_engine>`,
  ].join("\n");
}

function buildAttentionBlockMarkdown(task: string, map: AttentionMap): string {
  return [
    `## Attention Engine`,
    ``,
    `**Task:** ${task}`,
    `**Compression:** ${map.compressionRatio}% of original context`,
    `**Highlighted files:** ${map.highlightedFiles.join(", ") || "(none)"}`,
    `**Highlighted modules:** ${map.highlightedModules.join(", ") || "(none)"}`,
    `**Structural context:** [see JSON below]`,
    "```json",
    JSON.stringify(map.structuralContext),
    "```",
    `> Focus only on high-attention content. Keep structural context always.`,
    ``,
    `---`,
    ``,
  ].join("\n");
}

function buildAttentionBlockGemini(task: string, map: AttentionMap): string {
  return [
    `[ATTENTION ENGINE]`,
    `Task: ${task}`,
    `Compression: ${map.compressionRatio}%`,
    `Highlighted: ${map.highlightedFiles.join(", ") || "(none)"}`,
    `Structural map: ${JSON.stringify(map.structuralContext)}`,
    `[RULE] Keep structural context. Focus on high-attention content only.`,
    ``,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────

function tailMessages(
  ex: ExtractedContext | undefined,
  allMessages: Message[]
): Message[] {
  return ex?.conversationTail ?? allMessages.slice(-MAX_VERBATIM);
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

export {
  buildClaudePrompt,
  buildChatGPTPrompt,
  buildGeminiPrompt,
  buildGrokPrompt,
  buildPerplexityPrompt,
  buildDeepSeekPrompt,
};
