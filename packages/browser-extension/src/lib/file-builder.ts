import type { ContextSession, Message } from './types'
import type { IntelligentSummary } from './summarizer'
import type { ChunkEmbedding } from './db'
import type { AttentionMap } from './attention-engine'

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
  for (const chunk of chunks) {
    if (!seen.has(chunk.messageIndex)) {
      seen.add(chunk.messageIndex)
      messages.push(session.messages[chunk.messageIndex])
    }
  }
  session.messages.slice(-6).forEach(m => {
    const idx = session.messages.indexOf(m)
    if (!seen.has(idx)) { seen.add(idx); messages.push(m) }
  })
  return messages.sort((a, b) =>
    session.messages.indexOf(a) - session.messages.indexOf(b)
  )
}

export function buildTier1File(session: ContextSession): MigrationFile {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="1" type="full_context">

  <meta>
    <source_platform>${session.platform}</source_platform>
    <session_title><![CDATA[${session.title}]]></session_title>
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
      <![CDATA[${m.content}]]>
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
      <![CDATA[${cb.code}]]>
    </code>`).join('')}
  </code_blocks>` : ''

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="2" type="smart_summary">

  <meta>
    <source_platform>${session.platform}</source_platform>
    <session_title><![CDATA[${session.title}]]></session_title>
    <original_message_count>${session.messages.length}</original_message_count>
    <compression_ratio>${summary.compressionRatio ?? 0}%</compression_ratio>
    <exported_at>${new Date().toISOString()}</exported_at>
    <tier>Smart Summary — intelligently extracted</tier>
    ${task ? `<focus_task><![CDATA[${task}]]></focus_task>` : ''}
  </meta>

  <instructions_for_ai>
    This is an intelligently summarized context from a previous AI conversation
    (${session.messages.length} messages compressed).
    Read all sections and continue from exactly where this conversation left off.
    All decisions and code below are from the original session.
  </instructions_for_ai>

  <goal>
    <primary><![CDATA[${summary.goal ?? ''}]]></primary>
    <current><![CDATA[${summary.currentState ?? ''}]]></current>
  </goal>

  <decisions count="${summary.decisions?.length ?? 0}">
${(summary.decisions ?? []).map((d: string, i: number) =>
  `    <decision index="${i + 1}"><![CDATA[${d}]]></decision>`).join('\n')}
  </decisions>

  <bugs_fixed count="${summary.bugsFixed?.length ?? 0}">
${(summary.bugsFixed ?? []).map((b: string, i: number) =>
  `    <bug index="${i + 1}"><![CDATA[${b}]]></bug>`).join('\n')}
  </bugs_fixed>
${codeSection}

  <conversation_tail count="${summary.tail?.length ?? 0}">
${(summary.tail ?? []).map((m: Message, i: number) => `
    <message index="${i + 1}" role="${m.role}">
      <![CDATA[${m.content}]]>
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

export function buildTier3File(
  session: ContextSession,
  chunks: ChunkEmbedding[],
  task: string,
  attentionMap?: AttentionMap
): MigrationFile {
  const retrievedMessages = getMessagesFromChunks(chunks, session)

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<contextmover_migration tier="3" type="attention_engine">

  <meta>
    <source_platform>${session.platform}</source_platform>
    <session_title><![CDATA[${session.title}]]></session_title>
    <original_message_count>${session.messages.length}</original_message_count>
    <retrieved_chunks>${chunks.length}</retrieved_chunks>
    <task><![CDATA[${task}]]></task>
    <exported_at>${new Date().toISOString()}</exported_at>
    <tier>Attention Engine — semantically focused</tier>
  </meta>

  <attention_engine>
    <task><![CDATA[${task}]]></task>
    ${attentionMap ? `
    <highlighted_files>
      ${attentionMap.highlightedFiles?.map((f: string) =>
        `<file>${f}</file>`).join('\n      ')}
    </highlighted_files>
    <compression_ratio>${attentionMap.compressionRatio ?? 0}%</compression_ratio>` : ''}
  </attention_engine>

  <instructions_for_ai>
    This context was semantically filtered from a ${session.messages.length}-message
    conversation using the ContextMover Attention Engine.
    Only the most relevant content for the task "${task}" is included.
    Continue from exactly where this conversation left off.
    Do not re-explain what was already decided.
  </instructions_for_ai>

  <focused_context>
${retrievedMessages.map((m: Message, i: number) => `
    <message index="${i + 1}" role="${m.role}">
      <![CDATA[${m.content}]]>
    </message>`).join('')}
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
