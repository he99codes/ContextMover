// packages/browser-extension/src/lib/translator.ts
// Context Translation Adapter — formats extracted context per target model.
// Each builder uses payload.extracted (structured) when present and falls
// back to payload.summary (plain text) for backward compatibility.

import type { ExtractedContext, Message, MigrationPayload } from "./types";

const MAX_VERBATIM = 6;

export default function buildMigrationPrompt(
  payload: MigrationPayload
): string {
  switch (payload.targetPlatform) {
    case "claude":
      return buildClaudePrompt(payload);
    case "chatgpt":
      return buildChatGPTPrompt(payload);
    case "gemini":
      return buildGeminiPrompt(payload);
    case "grok":
      return buildGrokPrompt(payload);
    case "perplexity":
      return buildPerplexityPrompt(payload);
    case "deepseek":
      return buildDeepSeekPrompt(payload);
    default: {
      const _exhaustive: never = payload.targetPlatform;
      void _exhaustive;
      return buildChatGPTPrompt(payload);
    }
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

  const metaBlock = [
    `  <meta>`,
    `    <source_platform>${sourceSession.platform}</source_platform>`,
    `    <captured_at>${now}</captured_at>`,
    `    <message_count>${sourceSession.messages.length}</message_count>`,
    `    <session_title>${sourceSession.title}</session_title>`,
    `  </meta>`,
  ].join("\n");

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

  const tailBlock = [
    `  <conversation_tail>`,
    ...tail.map((m) => `    <message role="${m.role}">${m.content}</message>`),
    `  </conversation_tail>`,
  ].join("\n");

  const ideBlock = ideContext
    ? `\n  <ide_context>\n${indent(ideContext, 4)}\n  </ide_context>`
    : "";

  const caveatLine = payload.caveman
    ? `    Caveman mode: no filler, no pleasantries, answer then stop, code write normal, technical terms keep exact.`
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

  return [
    `<context_migration>`,
    ``,
    metaBlock,
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

  const out: string[] = [
    `## Migrated Session`,
    ``,
    `> **Source platform:** ${sourceSession.platform}  `,
    `> **Session:** "${sourceSession.title}"  `,
    `> **Messages captured:** ${sourceSession.messages.length}  `,
    `> **Migrated at:** ${now}`,
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

  if (ideContext) {
    out.push(`---`, ``, `## Current Codebase State (VS Code)`, ``, ideContext, ``);
  }

  out.push(
    `---`,
    ``,
    `## Where We Left Off`,
    ``,
    ...tail.flatMap((m) => [
      `**${m.role === "user" ? "User" : "Assistant"}:**`,
      ``,
      m.content,
      ``,
    ]),
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
    ...(payload.caveman ? [`Caveman mode: no filler, no pleasantries, answer then stop, code write normal, technical terms keep exact.`] : [])
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

  const out: string[] = [
    `## ContextForge — Session Import (Grok)`,
    ``,
    `> **From:** ${sourceSession.platform} | **"${sourceSession.title}"** | ${sourceSession.messages.length} messages | ${now}`,
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

  if (ideContext) {
    out.push(`---`, ``, `## Codebase State (VS Code)`, ``, ideContext, ``);
  }

  out.push(
    `---`,
    ``,
    `## Where We Left Off`,
    ``,
    ...tail.flatMap((m) => [
      `**${m.role === "user" ? "You" : "Previous AI"}:**`,
      ``,
      m.content,
      ``,
    ]),
    `---`,
    ``,
    `## Instructions`,
    ``,
    `Hey Grok! Picking this up from ${sourceSession.platform}.`,
    `The user is currently working on: **${currentFocus}**`,
    ``,
    `Jump straight in — no need to reintroduce yourself or recap what's already done.`,
    `All the code above is agreed-upon context, treat it as already written and working.`,
    ...(payload.caveman ? [`Caveman mode: no filler, no pleasantries, answer then stop, code write normal, technical terms keep exact.`] : [])
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

  const out: string[] = [
    `[CONTEXTFORGE MIGRATION]`,
    `Source: ${sourceSession.platform} | Session: "${sourceSession.title}" | ${sourceSession.messages.length} messages | ${now}`,
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

  if (ideContext) {
    out.push(`[IDE CONTEXT]`, ideContext, ``);
  }

  out.push(
    `[CURRENT STATE]`,
    currentFocus,
    ``,
    `[RECENT MESSAGES]`,
    ...tail.flatMap((m) => [`${m.role.toUpperCase()}: ${m.content}`, ``]),
    `[TASK]`,
    `Continue the conversation from the context above.`,
    `The user is currently focused on: ${currentFocus}`,
    `Do not recap already-decided items. Pick up exactly where the conversation ended.`,
    ...(payload.caveman ? [`Caveman mode: no filler, no pleasantries, answer then stop, code write normal, technical terms keep exact.`] : [])
  );

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// PERPLEXITY — Markdown with plain-prose instructions
// Perplexity is a search-focused AI; guide it to treat the context as a
// conversation continuation rather than a new search query.
// ─────────────────────────────────────────────────────────────────────────────
function buildPerplexityPrompt(payload: MigrationPayload): string {
  const { sourceSession, extracted: ex, ideContext } = payload;
  const now = new Date().toISOString();
  const tail = tailMessages(ex, sourceSession.messages);
  const currentFocus = ex?.currentFocus ?? "See recent messages below";

  const out: string[] = [
    `## Migrated Context — Perplexity`,
    ``,
    `> **From:** ${sourceSession.platform} | **"${sourceSession.title}"** | ${sourceSession.messages.length} messages | ${now}`,
    ``,
    `---`,
    ``,
    `## Goal`,
    ``,
    ex?.primaryGoal ?? payload.summary,
    ``,
    `## Progress`,
    ``,
    `**Completed:** ${ex?.completed.length ? ex.completed.map(c => `\n- ${c}`).join("") : " (none extracted)"}`,
    ``,
    `**Pending:** ${ex?.pending.length ? ex.pending.map(p => `\n- ${p}`).join("") : " (none extracted)"}`,
    ``,
    `## Key Decisions`,
    ``,
    ex?.decisions || "(none extracted)",
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
    out.push(`_No code blocks detected in this session_`, ``);
  }

  if (ideContext) {
    out.push(`---`, ``, `## Codebase State`, ``, ideContext, ``);
  }

  out.push(
    `---`,
    ``,
    `## Where We Left Off`,
    ``,
    ...tail.flatMap((m) => [
      `**${m.role === "user" ? "User" : "Perplexity"}:**`,
      ``,
      m.content,
      ``,
    ]),
    `---`,
    ``,
    `## Instructions`,
    ``,
    `This is a migrated conversation from ${sourceSession.platform}. Please continue it directly.`,
    `The user is currently focused on: **${currentFocus}**`,
    ``,
    `Do not treat this as a new search query. Pick up exactly where the conversation ended,`,
    `treating all code and decisions above as established context.`,
    ...(payload.caveman ? [`Caveman mode: no filler, no pleasantries, answer then stop, code write normal, technical terms keep exact.`] : [])
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

  const out: string[] = [
    `# ContextForge Migration → DeepSeek`,
    ``,
    `**Source:** ${sourceSession.platform} | **"${sourceSession.title}"** | ${sourceSession.messages.length} messages | ${now}`,
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

  if (ideContext) {
    out.push(`---`, ``, `## Live Codebase (VS Code)`, ``, ideContext, ``);
  }

  out.push(
    `---`,
    ``,
    `## Recent Conversation`,
    ``,
    ...tail.flatMap((m) => [
      `**${m.role === "user" ? "User" : "Assistant"}:**`,
      ``,
      m.content,
      ``,
    ]),
    `---`,
    ``,
    `## Task`,
    ``,
    `Continue this conversation from ${sourceSession.platform}.`,
    `Focus on: **${currentFocus}**`,
    ``,
    `All code above is established context — do not re-explain it.`,
    `Pick up exactly where the conversation ended.`,
    ...(payload.caveman ? [`Caveman mode: no filler, no pleasantries, answer then stop, code write normal, technical terms keep exact.`] : [])
  );

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

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
