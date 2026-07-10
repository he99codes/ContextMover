/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import type { ContextSession, Message } from './types'
import type { IntelligentSummary } from './summarizer'
import type { ChunkEmbedding } from './db'
import type { AttentionMap, AttentionChunk } from './attention-engine'

export interface MigrationFile {
  filename: string
  content: string
  format: 'xml'
  tier: 1 | 2 | 3
  charCount: number
  estimatedTokens: number
  sessionTitle: string
  platform: string
}

// Escape ]]> sequences in user content so they cannot prematurely terminate
// the surrounding CDATA section. Per XML 1.0 §2.7, CDATA cannot contain ]]>;
// the W3C-recommended workaround is to split it as ]]]]><![CDATA[> so the
// closing brackets sit in their own freshly-opened CDATA section.
//
// CRITICAL: without this, any message that itself contains a CDATA block
// (e.g. a previous ContextMover migration file pasted into chat) breaks the
// entire XML — the outer CDATA closes at the first inner ]]> and everything
// after that is parsed as raw XML, corrupting the migration file.
export function cdata(text: unknown): string {
  const s = text == null ? '' : String(text);
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

export function buildFilename(session: ContextSession, tier: number): string {
  const names: Record<number, string> = { 1: 'full', 2: 'summary', 3: 'attention' }
  const slug = session.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)
  const date = new Date().toISOString().slice(0, 10)
  return `contextmover-${names[tier]}-${session.platform}-${date}-${slug}.xml`
}

export function getMessagesFromChunks(
  chunks: ChunkEmbedding[],
  session: ContextSession
): Message[] {
  const seen = new Set<number>()
  const messages: Message[] = []
  
  // CRITICAL: Validate chunks belong to this session to prevent cross-session contamination
  const wrongSessionChunks = chunks.filter(c => c.sessionId !== session.id)
  if (wrongSessionChunks.length > 0) {
    console.error(
      `[CM:file-builder] CRITICAL: ${wrongSessionChunks.length}/${chunks.length} chunks from wrong session! ` +
      `Expected sessionId=${session.id}, got: ${wrongSessionChunks.map(c => c.sessionId).join(', ')}`
    )
  }
  
  for (const chunk of chunks) {
    // Skip chunks from other sessions
    if (chunk.sessionId !== session.id) {
      console.warn(`[CM:file-builder] Skipping chunk from wrong session: ${chunk.sessionId} (expected ${session.id})`)
      continue
    }
    
    // Validate messageIndex is in bounds
    if (chunk.messageIndex < 0 || chunk.messageIndex >= session.messages.length) {
      console.warn(
        `[CM:file-builder] Skipping chunk with out-of-bounds messageIndex: ` +
        `${chunk.messageIndex} (session has ${session.messages.length} messages)`
      )
      continue
    }
    
    if (!seen.has(chunk.messageIndex)) {
      seen.add(chunk.messageIndex)
      messages.push(session.messages[chunk.messageIndex])
    }
  }
  
  // Only tail-pad when the attention engine returned very few chunks.  When
  // chunks.length >= 5 the semantic filter already selected the relevant set;
  // unconditionally appending the tail would silently erase that filtering and
  // produce a T3 file identical in message count to T1.
  if (chunks.length < 5) {
    session.messages.slice(-10).forEach(m => {
      const idx = session.messages.indexOf(m)
      if (!seen.has(idx)) { seen.add(idx); messages.push(m) }
    })
  }
  return messages.sort((a, b) =>
    session.messages.indexOf(a) - session.messages.indexOf(b)
  )
}

export function buildTier1File(session: ContextSession): MigrationFile {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="1" type="full_context">

  <meta>
    <source_platform>${session.platform}</source_platform>
    <session_title>${cdata(session.title)}</session_title>
    <message_count>${session.messages.length}</message_count>
    <exported_at>${new Date().toISOString()}</exported_at>
    <tier>Full Context — all messages verbatim</tier>
  </meta>

  <instructions_for_ai>
    This file contains the complete context from a previous AI conversation.
    Read the full conversation below and continue from exactly where it left off.
    Do not re-explain what was already discussed or decided.
  </instructions_for_ai>

  <conversation>
${session.messages.map((m, i) => `
    <message index="${i + 1}" role="${m.role}">
      ${cdata(m.content)}
    </message>`).join('')}
  </conversation>

</contextmover_migration>`

  return {
    filename: buildFilename(session, 1),
    content,
    format: 'xml',
    tier: 1,
    charCount: content.length,
    estimatedTokens: Math.ceil(content.length / 4),
    sessionTitle: session.title,
    platform: session.platform
  }
}

export function buildTier2File(
  session: ContextSession,
  summary: IntelligentSummary,
  task?: string
): MigrationFile {
  const codeSection = summary.codeBlocks?.length > 0 ? `
  <code_blocks count="${summary.codeBlocks.length}">
${summary.codeBlocks.map((cb: any, i: number) => `
    <code index="${i + 1}" language="${cb.language ?? 'unknown'}"${cb.path ? ` path="${cb.path}"` : ''}>
      ${cdata(cb.code)}
    </code>`).join('')}
  </code_blocks>` : ''

  // [CM-T2-FIX] sanitize current goal — remove tool artifacts and code blocks
  const currentGoal = (summary.currentState ?? '')
    .replace(/^(Reading|Viewed|Edited|Created|Searched|Command|Checked).*$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 400);

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="2" type="smart_summary">

  <meta>
    <source_platform>${session.platform}</source_platform>
    <session_title>${cdata(session.title)}</session_title>
    <original_message_count>${session.messages.length}</original_message_count>
    <compression_ratio>${summary.compressionRatio ?? 0}%</compression_ratio>
    <exported_at>${new Date().toISOString()}</exported_at>
    <tier>Smart Summary — intelligently extracted</tier>
    ${task ? `<focus_task>${cdata(task)}</focus_task>` : ''}
  </meta>

  <instructions_for_ai>
    This is an intelligently summarized context from a previous AI conversation
    (${session.messages.length} messages compressed).
    Read all sections and continue from exactly where this conversation left off.
    All decisions and code below are from the original session.
  </instructions_for_ai>

  <goal>
    <primary>${cdata(summary.goal ?? '')}</primary>
    <current>${cdata(currentGoal)}</current>
  </goal>

  <decisions count="${summary.decisions?.length ?? 0}">
${(summary.decisions ?? []).map((d: string, i: number) =>
  `    <decision index="${i + 1}">${cdata(d)}</decision>`).join('\n')}
  </decisions>

  <bugs_fixed count="${summary.bugsFixed?.length ?? 0}">
${(summary.bugsFixed ?? []).map((b: string, i: number) =>
  `    <bug index="${i + 1}">${cdata(b)}</bug>`).join('\n')}
  </bugs_fixed>
${summary.techStack?.length ? `
  <tech_stack>
${summary.techStack.map((t: string) => `    <tech>${t}</tech>`).join('\n')}
  </tech_stack>` : ''}
${codeSection}

  <conversation_tail count="${summary.tail?.length ?? 0}">
${(summary.tail ?? []).map((m: Message, i: number) => `
    <message index="${i + 1}" role="${m.role}">
      ${cdata(m.content)}
    </message>`).join('')}
  </conversation_tail>

</contextmover_migration>`

  return {
    filename: buildFilename(session, 2),
    content,
    format: 'xml',
    tier: 2,
    charCount: content.length,
    estimatedTokens: Math.ceil(content.length / 4),
    sessionTitle: session.title,
    platform: session.platform
  }
}

// [CM-T3-FIX] populate attention_engine block with scored chunks grouped by type
function renderScoredChunks(chunks: AttentionChunk[]): string {
  const T = 800, N = 5;
  const d = chunks.filter(c => c.type === "message" && /\b(decided|conclusion|agreed|resolution)\b/i.test(c.content)).sort((a,b) => b.relevanceScore - a.relevanceScore).slice(0, N);
  const code = chunks.filter(c => c.type === "code").sort((a,b) => b.relevanceScore - a.relevanceScore).slice(0, N);
  const rest = chunks.filter(c => c.type === "message" && !d.includes(c)).sort((a,b) => b.relevanceScore - a.relevanceScore).slice(0, N);
  const item = (c: AttentionChunk) => `<chunk score="${c.relevanceScore.toFixed(3)}" role="${c.role}">${cdata(c.content.slice(0, T))}${c.content.length > T ? "…" : ""}</chunk>`;
  return `<scored_topics>${rest.map(item).join("")}</scored_topics><key_decisions>${d.map(item).join("")}</key_decisions><architectural_context>${code.map(item).join("")}</architectural_context>`;
}
export function buildTier3File(
  session: ContextSession,
  chunks: ChunkEmbedding[],
  task: string,
  attentionMap?: AttentionMap
): MigrationFile {
  const retrievedMessages = getMessagesFromChunks(chunks, session)

  // Build per-message relevance score lookup from attentionMap when available.
  // Key = message content string; value = highest relevanceScore among all chunks
  // that reference this message.  Used to annotate each <message> tag so the
  // receiving model can see which turns were most topically relevant.
  const scoreByContent = new Map<string, number>()
  if (attentionMap) {
    for (const ac of attentionMap.topChunks) {
      if (ac.type === 'message') {
        const prev = scoreByContent.get(ac.content) ?? 0
        if (ac.relevanceScore > prev) scoreByContent.set(ac.content, ac.relevanceScore)
      }
    }
  }

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="3" type="attention_engine">

  <meta>
    <source_platform>${session.platform}</source_platform>
    <session_title>${cdata(session.title)}</session_title>
    <original_message_count>${session.messages.length}</original_message_count>
    <retrieved_chunks>${chunks.length}</retrieved_chunks>
    <retrieved_messages>${retrievedMessages.length}</retrieved_messages>
    <task>${cdata(task)}</task>
    <exported_at>${new Date().toISOString()}</exported_at>
    <tier>Attention Engine — semantically focused</tier>
  </meta>

  <attention_engine>
    <task>${cdata(task)}</task>
    ${attentionMap ? `
    <highlighted_files>
      ${attentionMap.highlightedFiles?.map((f: string) =>
        `<file>${f}</file>`).join('\n      ')}
    </highlighted_files>
    <compression_ratio>${attentionMap.compressionRatio ?? 0}%</compression_ratio>
    ${renderScoredChunks(attentionMap.topChunks)}` : ''}
  </attention_engine>

  <instructions_for_ai>
    This context was semantically filtered from a ${session.messages.length}-message
    conversation using the ContextMover Attention Engine.
    Only the most relevant content for the task "${task}" is included.
    Continue from exactly where this conversation left off.
    Do not re-explain what was already decided.
  </instructions_for_ai>

  <focused_context>
${retrievedMessages.map((m: Message, i: number) => {
  const score = scoreByContent.get(m.content)
  const scoreAttr = score !== undefined ? ` score="${score.toFixed(3)}"` : ''
  return `
    <message index="${i + 1}" role="${m.role}"${scoreAttr}>
      ${cdata(m.content)}
    </message>`
}).join('')}
  </focused_context>

</contextmover_migration>`

  return {
    filename: buildFilename(session, 3),
    content,
    format: 'xml',
    tier: 3,
    charCount: content.length,
    estimatedTokens: Math.ceil(content.length / 4),
    sessionTitle: session.title,
    platform: session.platform
  }
}
