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

export function escapeXmlAttr(text: unknown): string {
  const s = text == null ? '' : String(text);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .slice(0, 200);
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
    
    // [BUG-5 FIX] Clamp messageIndex to valid range instead of skipping.
    if (session.messages.length === 0) continue
    const clampedIdx = Math.max(0, Math.min(chunk.messageIndex, session.messages.length - 1))
    if (!seen.has(clampedIdx)) {
      seen.add(clampedIdx)
      messages.push(session.messages[clampedIdx])
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

// [CM-T2-FIX-2] Detect code blocks that are DOM probe / utility scripts —
// large self-executing IIFE scripts that are tools, not project code.
// These pollute the output and waste token budget.
function isDomProbeScript(code: string): boolean {
  if (code.length < 30) return false;
  // ContextMover DOM probe marker — always filter regardless of length
  if (/CONTEXTMOVER.*DOM PROBE|DOM PROBE.*CONTEXTMOVER/i.test(code)) return true;
  // console.log referencing CONTEXTMOVER — diagnostic utility script
  if (/console\.log.*CONTEXTMOVER/i.test(code)) return true;
  // Self-executing IIFE pattern: (function name() { ... })()
  if (/^\s*\(function\s+\w+\s*\(\s*\)/.test(code)) return true;
  // Large querySelectorAll scanning loops (> 500 chars) — DOM utility, not project code
  if (code.length > 500 && /querySelectorAll|querySelector/.test(code) && /\.forEach\s*\(|for\s*\(/.test(code)) return true;
  return false;
}

export function buildTier2File(
  session: ContextSession,
  summary: IntelligentSummary,
  task?: string,
  unindexedMessages?: Message[]
): MigrationFile {
  // [CM-T2-FIX-2] Filter out DOM probe scripts and oversized utility blocks
  const filteredCodeBlocks = (summary.codeBlocks ?? []).filter((cb: any) => !isDomProbeScript(cb.code));

  const codeSection = filteredCodeBlocks.length > 0 ? `
  <code_blocks count="${filteredCodeBlocks.length}">
${filteredCodeBlocks.map((cb: any, i: number) => `
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
${unindexedMessages && unindexedMessages.length > 0 ? `
  <unindexed_context count="${unindexedMessages.length}">
    <!-- Raw messages not covered by semantic indexing — included for completeness -->
${unindexedMessages.map((m: Message, i: number) => `
    <message index="${i + 1}" role="${m.role}">
      ${cdata(m.content)}
    </message>`).join('')}
  </unindexed_context>` : ''}

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

// [CM-T3-FIX-v2] populate attention_engine block with scored chunks grouped by type
// Guarantees non-empty output as long as at least one chunk is provided.
const DECISION_RE = /\b(decided|decision|conclusion|agreed|agree|resolution|chose|choose|switched|switch|fixed|resolved|approach|selected|determined|confirmed|plan|strategy|architecture|refactor|migrate|adopted|pivoted|went with|settled on|root cause|bug|issue|error|problem)\b/i;
function renderScoredChunks(chunks: AttentionChunk[]): string {
  if (chunks.length === 0) return '';
  const T = 1200, N = 8;
  const byScore = [...chunks].sort((a, b) => b.relevanceScore - a.relevanceScore);
  const decisions = byScore
    .filter(c => c.type === 'message' && DECISION_RE.test(c.content))
    .slice(0, N);
  const code = byScore.filter(c => c.type === 'code').slice(0, N);
  const dSet = new Set(decisions);
  const cSet = new Set(code);
  const context = byScore.filter(c => !dSet.has(c) && !cSet.has(c)).slice(0, N);
  // If no decisions matched the regex, promote top-scored general messages
  if (decisions.length === 0 && context.length > 2) {
    decisions.push(...context.splice(0, Math.min(3, context.length)));
  }
  const item = (c: AttentionChunk) =>
    `\n      <chunk score="${c.relevanceScore.toFixed(3)}" role="${c.role}">${cdata(c.content.slice(0, T))}${c.content.length > T ? '…' : ''}</chunk>`;
  const sections: string[] = [];
  if (context.length > 0)
    sections.push(`<relevant_context count="${context.length}">${context.map(item).join('')}\n    </relevant_context>`);
  if (decisions.length > 0)
    sections.push(`<key_decisions count="${decisions.length}">${decisions.map(item).join('')}\n    </key_decisions>`);
  if (code.length > 0)
    sections.push(`<code_context count="${code.length}">${code.map(item).join('')}\n    </code_context>`);
  return sections.join('\n    ');
}

export function buildTier3File(
  session: ContextSession,
  chunks: ChunkEmbedding[],
  task: string,
  attentionMap?: AttentionMap,
  unindexedMessages?: Message[]
): MigrationFile {
  const retrievedMessages = getMessagesFromChunks(chunks, session)

  // [CM-T3-FIX] Guarantee the last 6 messages are in focused_context only when
  // the chunk set is very small (< 5).  For larger chunk sets the semantic filter
  // has already selected the relevant set; unconditionally appending the tail
  // would silently inflate the message count and defeat the attention engine.
  const TAIL_GUARANTEE = 6
  const retrievedSet = new Set(retrievedMessages.map(m => m.content))
  const extraTail = chunks.length < 5
    ? session.messages.slice(-TAIL_GUARANTEE).filter(m => !retrievedSet.has(m.content))
    : []
  const focusedMessages = [
    ...retrievedMessages,
    ...extraTail,
  ].sort((a, b) => session.messages.indexOf(a) - session.messages.indexOf(b))

  // Build per-message relevance score lookup — from attentionMap topChunks if available,
  // otherwise from the synthesized chunks so focused_context always has scores.
  const compressionPct = attentionMap?.compressionRatio
    ?? Math.round((1 - focusedMessages.length / Math.max(1, session.messages.length)) * 100)
  const synthChunks = (): AttentionChunk[] => focusedMessages.map((m, i) => ({
    id: `synth-${i}`,
    sessionId: session.id,
    type: 'message' as const,
    content: m.content,
    role: m.role as 'user' | 'assistant',
    relevanceScore: Math.max(0.1, 1 - i / Math.max(1, focusedMessages.length - 1)),
    embedding: [],
    timestamp: m.timestamp ?? 0,
  }))

  const scoreByContent = new Map<string, number>()
  const scoreSrc = attentionMap?.topChunks ?? synthChunks()
  for (const ac of scoreSrc) {
    if (ac.type === 'message') {
      const prev = scoreByContent.get(ac.content) ?? 0
      if (ac.relevanceScore > prev) scoreByContent.set(ac.content, ac.relevanceScore)
    }
  }

  // Build attention_engine block — use attentionMap.topChunks when available,
  // otherwise synthesize AttentionChunk-like objects from the retrieved chunks.
  // GUARANTEE: this block is never empty — if renderScoredChunks returns '' we
  // fall through to a plain list of focused messages with synthetic scores.

  let attentionBlock: string
  if (attentionMap && attentionMap.topChunks.length > 0) {
    const files = (attentionMap.highlightedFiles ?? []).map((f: string) => `\n      <file>${f}</file>`).join('')
    const scored = renderScoredChunks(attentionMap.topChunks)
    attentionBlock = `
    <highlighted_files>${files}
    </highlighted_files>
    <compression_ratio>${compressionPct}%</compression_ratio>
    ${scored || renderScoredChunks(synthChunks())}`
  } else {
    attentionBlock = `
    <compression_ratio>${compressionPct}%</compression_ratio>
    ${renderScoredChunks(synthChunks())}`
  }

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="3" type="attention_engine">

  <meta>
    <source_platform>${session.platform}</source_platform>
    <session_title>${cdata(session.title)}</session_title>
    <original_message_count>${session.messages.length}</original_message_count>
    <retrieved_chunks>${chunks.length}</retrieved_chunks>
    <retrieved_messages>${focusedMessages.length}</retrieved_messages>
    <task>${cdata(task)}</task>
    <exported_at>${new Date().toISOString()}</exported_at>
    <tier>Attention Engine — semantically focused</tier>
  </meta>

  <attention_engine>
    <task>${cdata(task)}</task>
    ${attentionBlock}
  </attention_engine>

  <instructions_for_ai>
    This context was semantically filtered from a ${session.messages.length}-message conversation
    using the ContextMover Attention Engine. ${focusedMessages.length} messages were selected
    (${compressionPct}% compression). Only the messages most relevant to the task are included.
    You are resuming this session. Read every message in focused_context.
    Continue exactly where this conversation left off.
    Do not re-introduce, re-summarize, or re-explain anything already established.
    Your first response must directly address the task: ${cdata(task)}.
  </instructions_for_ai>

  <focused_context>
${focusedMessages.map((m: Message, i: number) => {
  const score = scoreByContent.get(m.content)
  const scoreAttr = score !== undefined ? ` score="${score.toFixed(3)}"` : ''
  return `
    <message index="${i + 1}" role="${m.role}"${scoreAttr}>
      ${cdata(m.content)}
    </message>`
}).join('')}
  </focused_context>
${unindexedMessages && unindexedMessages.length > 0 ? `
  <unindexed_context count="${unindexedMessages.length}">
    <!-- Raw messages not covered by semantic indexing — included for completeness -->
${unindexedMessages.map((m: Message, i: number) => `
    <message index="${i + 1}" role="${m.role}">
      ${cdata(m.content)}
    </message>`).join('')}
  </unindexed_context>` : ''}

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

// ─────────────────────────────────────────────────────────────────────────────
// [Feature 3] Multi-Session Migration file builders
// These wrap the single-session builders, concatenating sessions with
// clear separator headers so the target LLM can distinguish them.
// ─────────────────────────────────────────────────────────────────────────────

export function buildMultiSessionFilename(sessions: ContextSession[], tier: number): string {
  const names: Record<number, string> = { 1: 'full', 2: 'summary', 3: 'attention' }
  const primarySlug = (sessions[0]?.title ?? 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)
  const date = new Date().toISOString().slice(0, 10)
  return `contextmover-${names[tier]}-multi-${sessions.length}x-${date}-${primarySlug}.xml`
}

export function buildMultiSessionTier1File(sessions: ContextSession[]): MigrationFile {
  const sessionSections = sessions.map((s, si) => {
    const safeTitle = escapeXmlAttr(s.title)
    const header = `  <!-- ═══ Session ${si + 1}/${sessions.length}: ${s.platform} — ${safeTitle} ═══ -->`
    const messages = s.messages.map((m, i) => `
    <message index="${i + 1}" role="${m.role}" session="${si + 1}">
      ${cdata(m.content)}
    </message>`).join('')
    return `${header}\n  <session_section index="${si + 1}" platform="${s.platform}" title="${safeTitle}" message_count="${s.messages.length}">
    <conversation>${messages}
    </conversation>
  </session_section>`
  }).join('\n\n')

  const totalMessages = sessions.reduce((sum, s) => sum + s.messages.length, 0)
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="1" type="full_context" multi_session="${sessions.length}">

  <meta>
    <source_platforms>${sessions.map((s) => s.platform).join(', ')}</source_platforms>
    <session_count>${sessions.length}</session_count>
    <total_message_count>${totalMessages}</total_message_count>
    <exported_at>${new Date().toISOString()}</exported_at>
    <tier>Full Context — all messages verbatim (${sessions.length} sessions)</tier>
  </meta>

  <instructions_for_ai>
    This file contains the complete context from ${sessions.length} previous AI conversations.
    Each session is separated by a session_section boundary with its platform and title.
    Read all conversations below and synthesize context across all sessions.
    Do not re-explain what was already discussed or decided in any session.
  </instructions_for_ai>

${sessionSections}

</contextmover_migration>`

  return {
    filename: buildMultiSessionFilename(sessions, 1),
    content,
    format: 'xml',
    tier: 1,
    charCount: content.length,
    estimatedTokens: Math.ceil(content.length / 4),
    sessionTitle: sessions.map((s) => s.title).join(' + '),
    platform: sessions[0]?.platform ?? 'unknown',
  }
}

export function buildMultiSessionTier2File(
  sessions: ContextSession[],
  summaries: IntelligentSummary[],
  task?: string,
): MigrationFile {
  const sessionSections = sessions.map((s, si) => {
    const summary = summaries[si]
    if (!summary) return ''
    const filteredCodeBlocks = (summary.codeBlocks ?? []).filter((cb: any) => !isDomProbeScript(cb.code))
    const codeSection = filteredCodeBlocks.length > 0 ? `
    <code_blocks count="${filteredCodeBlocks.length}">
${filteredCodeBlocks.map((cb: any, i: number) => `
      <code index="${i + 1}" language="${cb.language ?? 'unknown'}"${cb.path ? ` path="${cb.path}"` : ''}>
        ${cdata(cb.code)}
      </code>`).join('')}
    </code_blocks>` : ''

    const decisions = (summary.decisions ?? []).map((d: string, i: number) =>
      `      <decision index="${i + 1}">${cdata(d)}</decision>`).join('\n')
    const tail = (summary.tail ?? []).map((m: Message, i: number) =>
      `      <message index="${i + 1}" role="${m.role}">
        ${cdata(m.content)}
      </message>`).join('')

    return `  <session_section index="${si + 1}" platform="${s.platform}" title="${escapeXmlAttr(s.title)}">
    <goal>
      <primary>${cdata(summary.goal ?? '')}</primary>
    </goal>
    <decisions count="${summary.decisions?.length ?? 0}">
${decisions}
    </decisions>${codeSection}
    <conversation_tail count="${summary.tail?.length ?? 0}">
${tail}
    </conversation_tail>
  </session_section>`
  }).join('\n\n')

  const totalMessages = sessions.reduce((sum, s) => sum + s.messages.length, 0)
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="2" type="smart_summary" multi_session="${sessions.length}">

  <meta>
    <source_platforms>${sessions.map((s) => s.platform).join(', ')}</source_platforms>
    <session_count>${sessions.length}</session_count>
    <total_message_count>${totalMessages}</total_message_count>
    <exported_at>${new Date().toISOString()}</exported_at>
    <tier>Smart Summary — intelligently extracted (${sessions.length} sessions)</tier>
    ${task ? `<focus_task>${cdata(task)}</focus_task>` : ''}
  </meta>

  <instructions_for_ai>
    This file contains intelligently summarized context from ${sessions.length} AI conversations.
    Each session's key decisions, code, and conversation tail are included.
    Synthesize across all sessions and continue from where the combined context leaves off.
  </instructions_for_ai>

${sessionSections}

</contextmover_migration>`

  return {
    filename: buildMultiSessionFilename(sessions, 2),
    content,
    format: 'xml',
    tier: 2,
    charCount: content.length,
    estimatedTokens: Math.ceil(content.length / 4),
    sessionTitle: sessions.map((s) => s.title).join(' + '),
    platform: sessions[0]?.platform ?? 'unknown',
  }
}

export function buildMultiSessionTier3File(
  sessions: ContextSession[],
  allChunks: ChunkEmbedding[],
  task: string,
  attentionMaps?: AttentionMap[],
): MigrationFile {
  const sessionSections = sessions.map((s, si) => {
    const sessionChunks = allChunks.filter((c) => c.sessionId === s.id)
    const retrievedMessages = getMessagesFromChunks(sessionChunks, s)
    const attentionMap = attentionMaps?.[si]

    const TAIL_GUARANTEE = 6
    const retrievedSet = new Set(retrievedMessages.map((m) => m.content))
    const extraTail = sessionChunks.length < 5
      ? s.messages.slice(-TAIL_GUARANTEE).filter((m) => !retrievedSet.has(m.content))
      : []
    const focusedMessages = [...retrievedMessages, ...extraTail]
      .sort((a, b) => s.messages.indexOf(a) - s.messages.indexOf(b))

    const compressionPct = attentionMap?.compressionRatio
      ?? Math.round((1 - focusedMessages.length / Math.max(1, s.messages.length)) * 100)

    const synthChunks = (): AttentionChunk[] => focusedMessages.map((m, i) => ({
      id: `synth-${si}-${i}`,
      sessionId: s.id,
      type: 'message' as const,
      content: m.content,
      role: m.role as 'user' | 'assistant',
      relevanceScore: Math.max(0.1, 1 - i / Math.max(1, focusedMessages.length - 1)),
      embedding: [],
      timestamp: m.timestamp ?? 0,
    }))

    const scoreSrc = attentionMap?.topChunks ?? synthChunks()
    const scoreByContent = new Map<string, number>()
    for (const ac of scoreSrc) {
      if (ac.type === 'message') {
        const prev = scoreByContent.get(ac.content) ?? 0
        if (ac.relevanceScore > prev) scoreByContent.set(ac.content, ac.relevanceScore)
      }
    }

    const messagesXml = focusedMessages.map((m: Message, i: number) => {
      const score = scoreByContent.get(m.content)
      const scoreAttr = score !== undefined ? ` score="${score.toFixed(3)}"` : ''
      return `
      <message index="${i + 1}" role="${m.role}"${scoreAttr}>
        ${cdata(m.content)}
      </message>`
    }).join('')

    return `  <session_section index="${si + 1}" platform="${s.platform}" title="${escapeXmlAttr(s.title)}" compression="${compressionPct}%">
    <focused_context>${messagesXml}
    </focused_context>
  </session_section>`
  }).join('\n\n')

  const totalMessages = sessions.reduce((sum, s) => sum + s.messages.length, 0)
  const totalChunks = allChunks.length
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="3" type="attention_engine" multi_session="${sessions.length}">

  <meta>
    <source_platforms>${sessions.map((s) => s.platform).join(', ')}</source_platforms>
    <session_count>${sessions.length}</session_count>
    <total_message_count>${totalMessages}</total_message_count>
    <retrieved_chunks>${totalChunks}</retrieved_chunks>
    <task>${cdata(task)}</task>
    <exported_at>${new Date().toISOString()}</exported_at>
    <tier>Attention Engine — semantically focused (${sessions.length} sessions)</tier>
  </meta>

  <instructions_for_ai>
    This context was semantically filtered from ${sessions.length} conversations
    (${totalMessages} total messages) using the ContextMover Attention Engine.
    Only messages most relevant to the task are included from each session.
    Synthesize across all sessions and continue from where the combined context leaves off.
    Your first response must directly address the task: ${cdata(task)}.
  </instructions_for_ai>

${sessionSections}

</contextmover_migration>`

  return {
    filename: buildMultiSessionFilename(sessions, 3),
    content,
    format: 'xml',
    tier: 3,
    charCount: content.length,
    estimatedTokens: Math.ceil(content.length / 4),
    sessionTitle: sessions.map((s) => s.title).join(' + '),
    platform: sessions[0]?.platform ?? 'unknown',
  }
}
