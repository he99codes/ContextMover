/**
 * Synthetic validation tests for Tier 2 and Tier 3 extraction quality.
 * Run with: npx tsx src/lib/__tests__/tier2-tier3-validate.ts
 */

import { summarizeIntelligent } from '../summarizer'
import { buildTier2File, buildTier3File, getMessagesFromChunks } from '../file-builder'
import type { ContextSession } from '../types'
import type { ChunkEmbedding } from '../db'

// ── Helpers ──────────────────────────────────────────────────────────────────

function pass(label: string) { console.log(`  ✅ ${label}`) }
function fail(label: string, detail?: string) {
  console.error(`  ❌ ${label}${detail ? `: ${detail}` : ''}`)
  process.exitCode = 1
}
function section(label: string) { console.log(`\n── ${label} ──`) }

function makeSession(messages: Array<{ role: string; content: string }>, id = 'test-session-1'): ContextSession {
  return {
    id,
    platform: 'claude' as any,
    title: 'Test Session',
    url: 'https://claude.ai/chat/test',
    messages: messages.map((m, i) => ({ ...m, timestamp: i * 1000 })) as any,
    createdAt: 0,
    updatedAt: 0,
    messageCount: messages.length,
  } as any
}

function makeChunk(session: ContextSession, idx: number, score: number): ChunkEmbedding {
  return {
    id: `chunk-${idx}`,
    sessionId: session.id,
    messageIndex: idx,
    content: session.messages[idx]?.content ?? '',
    role: session.messages[idx]?.role ?? 'user',
    chunkIndex: 0,
    embedding: [],
    score,
  } as any
}

// ── Synthetic data ────────────────────────────────────────────────────────────

const CODING_MESSAGES: Array<{ role: string; content: string }> = [
  { role: 'user', content: 'I want to build a real-time chat app using React and WebSockets. The backend should be Node.js with Express.' },
  { role: 'assistant', content: 'Great choice. We will use React for the frontend, Node.js/Express on the backend, and socket.io for real-time communication. This works because socket.io abstracts the WebSocket protocol and provides fallbacks.' },
  { role: 'user', content: 'How should I structure the rooms feature?' },
  { role: 'assistant', content: 'We decided to use a Map<string, Set<socketId>> on the server side. Each room ID maps to a set of connected socket IDs. This approach scales well and is simple to implement.' },
  { role: 'user', content: 'The join room function is not working. It throws a TypeError: cannot read property of undefined.' },
  { role: 'assistant', content: 'The bug was caused by accessing rooms.get(roomId) before checking if the room exists. The fix is to use rooms.has(roomId) guard first. Fixed it by adding: if (!rooms.has(roomId)) rooms.set(roomId, new Set())' },
  { role: 'user', content: 'Now the message broadcast is wrong — messages are going to all rooms instead of just the target room.' },
  { role: 'assistant', content: 'The root cause was that socket.to(roomId).emit() was being called on the server socket instead of io.to(roomId).emit(). We switched to io.to(roomId).emit() which correctly targets all clients in that room.' },
  { role: 'user', content: 'What about authentication? Should we use JWT or sessions?' },
  { role: 'assistant', content: 'We chose JWT for this project rather than sessions. JWTs are stateless and work better with WebSocket handshakes. The approach is: validate JWT in the socket.io handshake middleware, reject unauthenticated connections before they enter the room.' },
  { role: 'user', content: 'The frontend keeps disconnecting. It isn\'t reconnecting automatically.' },
  { role: 'assistant', content: 'The reconnection wasn\'t firing because we disabled it accidentally. The fix is to set reconnection: true and reconnectionAttempts: 5 in the socket.io client options.' },
  { role: 'user', content: 'Can we add message persistence to a database?' },
  { role: 'assistant', content: 'Yes. We are using PostgreSQL with the pg library. Messages are inserted on every broadcast event. The schema: messages(id, room_id, user_id, content, created_at). We went with PostgreSQL rather than MongoDB because we already have relational data in there.' },
  { role: 'user', content: 'show me the final room join handler' },
  { role: 'assistant', content: 'Here is the final implementation:\n\n```typescript\n// src/server/rooms.ts\nimport { Server, Socket } from "socket.io";\nimport { Pool } from "pg";\nimport React from "react";\n\nconst joinRoom = (socket: Socket, roomId: string, userId: string) => {\n  if (!rooms.has(roomId)) rooms.set(roomId, new Set());\n  rooms.get(roomId)!.add(socket.id);\n  socket.join(roomId);\n  io.to(roomId).emit("user_joined", { userId, roomId });\n};\n```\n\nThis replaced the old broken version that used socket.to() instead of io.to().' },
]

const MODEL_COMPARISON_MESSAGES: Array<{ role: string; content: string }> = [
  { role: 'user', content: 'which AI model should I use for my coding tasks?' },
  { role: 'assistant', content: 'Gemini 2.5 Pro is excellent for complex reasoning. Claude Sonnet is great for code. GPT-4o works well for general tasks. Haiku is faster and cheaper for simple tasks. I would recommend Claude for your use case since it handles long codebases well.' },
  { role: 'user', content: 'what about Llama or Mistral?' },
  { role: 'assistant', content: 'Llama 3.1 and Mistral are open-source alternatives. Llama uses parallel tool calls. Mistral has a 32k context window. SWE-bench shows Gemini 3 Flash achieves 78% on SWE-bench Verified. However for domain-specific tasks like yours, Claude or GPT-4o Pro are recommended. Haiku is more prone to going quiet on ambiguity.' },
]

// ── Test 1: Tier 2 decisions are NOT populated by model-comparison content ───

section('TEST 1: Tier 2 meta-discussion filter')
{
  const session = makeSession(MODEL_COMPARISON_MESSAGES)
  const summary = summarizeIntelligent(session.messages)

  const hasModelAdvice = summary.decisions.some(d =>
    /Haiku is more prone|parallel tool calls|SWE-bench|open-source/i.test(d)
  )
  if (hasModelAdvice) {
    fail('decisions contain meta-discussion sentences', summary.decisions[0]?.slice(0, 80))
  } else {
    pass('meta-discussion sentences filtered from decisions')
  }

  const hasBugFP = summary.bugsFixed.some(b =>
    /root cause analysis|domain-specific|haiku is more/i.test(b)
  )
  if (hasBugFP) {
    fail('bugsFixed contains false positives from model discussion', summary.bugsFixed[0]?.slice(0, 80))
  } else {
    pass('bugsFixed has no false positives from meta-discussion')
  }
}

// ── Test 2: Tier 2 correctly extracts real decisions from coding session ──────

section('TEST 2: Tier 2 extracts real coding decisions')
{
  const session = makeSession(CODING_MESSAGES)
  const summary = summarizeIntelligent(session.messages)

  // Should find JWT decision
  const hasJWT = summary.decisions.some(d => /JWT|jwt|json web token/i.test(d))
  hasJWT ? pass('JWT decision extracted') : fail('JWT decision NOT found', `decisions=${JSON.stringify(summary.decisions)}`)

  // Should find PostgreSQL decision
  const hasPG = summary.decisions.some(d => /postgres|PostgreSQL/i.test(d))
  hasPG ? pass('PostgreSQL decision extracted') : fail('PostgreSQL decision NOT found')

  // Should NOT include pure generic sentences
  const hasGeneric = summary.decisions.some(d => /Great choice|great for code|works well for general/i.test(d))
  !hasGeneric ? pass('no generic filler in decisions') : fail('generic filler in decisions')
}

// ── Test 3: Tier 2 correctly extracts real bugs ───────────────────────────────

section('TEST 3: Tier 2 bug extraction')
{
  const session = makeSession(CODING_MESSAGES)
  const summary = summarizeIntelligent(session.messages)

  // Bug: TypeError from accessing undefined
  const hasTyE = summary.bugsFixed.some(b => /caused by|rooms\.get|TypeError|rooms\.has/i.test(b))
  hasTyE ? pass('TypeError bug extracted') : fail('TypeError bug NOT found', `bugs=${JSON.stringify(summary.bugsFixed)}`)

  // Bug: wrong room target
  const hasRoom = summary.bugsFixed.some(b => /root cause|socket\.to|io\.to|all rooms/i.test(b))
  hasRoom ? pass('broadcast bug extracted') : fail('broadcast room bug NOT found')
}

// ── Test 4: Tier 2 code blocks filter out DOM probe scripts ──────────────────

section('TEST 4: DOM probe code block filtering')
{
  const domProbeContent = `(function claudeDOMProbe() {
  console.log('\\n========== CONTEXTMOVER: CLAUDE DOM PROBE ==========\\n');
  const allTestIds = [...new Set([...document.querySelectorAll('[data-testid]')].map(el => el.dataset.testid))].sort();
  console.log('ALL data-testid VALUES:\\n' + allTestIds.join('\\n') + '\\n');
  document.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(attr => {
      if (/role|author|turn|human|assistant|user|message/i.test(attr.name + attr.value)) {
        const key = attr.name + '=' + attr.value;
      }
    });
  });
})()`

  const msgsWithProbe: Array<{ role: string; content: string }> = [
    ...CODING_MESSAGES,
    { role: 'assistant', content: `Run this script in DevTools:\n\`\`\`javascript\n${domProbeContent}\n\`\`\`` },
  ]
  const session = makeSession(msgsWithProbe)
  const summary = summarizeIntelligent(session.messages)
  const file = buildTier2File(session, summary)

  // DOM probe should NOT appear in <code_blocks> section (filtered out)
  // It may still appear in <conversation_tail> as verbatim message content — that's OK
  const codeBlocksSection = file.content.match(/<code_blocks[\s\S]*?<\/code_blocks>/)?.[0] ?? ''
  const probeInCodeBlocks = codeBlocksSection.includes('CONTEXTMOVER: CLAUDE DOM PROBE') ||
    codeBlocksSection.includes('claudeDOMProbe')
  !probeInCodeBlocks ? pass('DOM probe scripts filtered from <code_blocks> section') : fail('DOM probe script leaked into <code_blocks> section')

  // Confirm the code_blocks section exists but has 0 probe entries
  const codeCount = (file.content.match(/<code index=/g) ?? []).length
  const hasNoProbeCode = !probeInCodeBlocks
  hasNoProbeCode ? pass(`code_blocks has ${codeCount} entry/entries, none are DOM probes`) : fail(`code_blocks contains probe scripts (${codeCount} entries)`)
}

// ── Test 5: Tier 2 tail is always present ────────────────────────────────────

section('TEST 5: Tier 2 conversation_tail always populated')
{
  const session = makeSession(CODING_MESSAGES)
  const summary = summarizeIntelligent(session.messages)
  const file = buildTier2File(session, summary)

  const hasTail = file.content.includes('<conversation_tail count=')
  hasTail ? pass('conversation_tail section present') : fail('conversation_tail section MISSING')

  const tailCountMatch = file.content.match(/conversation_tail count="(\d+)"/)
  const tailCount = tailCountMatch ? parseInt(tailCountMatch[1]) : 0
  tailCount >= 1 ? pass(`conversation_tail has ${tailCount} messages`) : fail('conversation_tail is empty')

  // Last message should be in tail
  const lastMsg = CODING_MESSAGES[CODING_MESSAGES.length - 1].content.slice(0, 40)
  const lastInFile = file.content.includes(lastMsg)
  lastInFile ? pass('last message appears in output') : fail('last message MISSING from output')
}

// ── Test 6: Tier 3 focused_context includes tail guarantee ───────────────────

section('TEST 6: Tier 3 tail guarantee in focused_context')
{
  const session = makeSession(CODING_MESSAGES)
  // Only score first 5 messages — last 8 should still appear via tail guarantee
  const chunks: ChunkEmbedding[] = [0, 1, 2, 3, 4].map(i => makeChunk(session, i, 0.9 - i * 0.1))
  const file = buildTier3File(session, chunks, 'Fix the chat room broadcast bug')

  // Last message content should be in output despite not being in chunks
  const lastMsg = CODING_MESSAGES[CODING_MESSAGES.length - 1].content.slice(0, 40)
  const lastInFocused = file.content.includes(lastMsg)
  lastInFocused ? pass('tail messages present in focused_context despite not being retrieved') : fail('tail guarantee MISSING — last messages not in Tier 3 output')

  const msgCountMatch = file.content.match(/<retrieved_messages>(\d+)<\/retrieved_messages>/)
  const msgCount = msgCountMatch ? parseInt(msgCountMatch[1]) : 0
  ;(msgCount > 5) ? pass(`retrieved_messages=${msgCount} (includes tail padding)`) : fail(`retrieved_messages=${msgCount} — too low, tail not added`)
}

// ── Test 7: Tier 3 attention_engine block is never empty ─────────────────────

section('TEST 7: Tier 3 attention_engine block populated without attentionMap')
{
  const session = makeSession(CODING_MESSAGES)
  const chunks: ChunkEmbedding[] = [3, 5, 7].map(i => makeChunk(session, i, 0.8))
  // No attentionMap passed
  const file = buildTier3File(session, chunks, 'Fix the bug')

  const hasTopics = file.content.includes('<scored_topics>')
  hasTopics ? pass('scored_topics block present without attentionMap') : fail('scored_topics MISSING when attentionMap is undefined')

  const hasDecisions = file.content.includes('<key_decisions>')
  hasDecisions ? pass('key_decisions block present') : fail('key_decisions MISSING')

  const isEmpty = /<attention_engine>\s*<task>[^<]+<\/task>\s*<\/attention_engine>/.test(file.content)
  !isEmpty ? pass('attention_engine block has content beyond just task') : fail('attention_engine block is effectively empty')
}

// ── Test 8: Tier 2 tech stack is plausible (no hallucinated Angular etc) ─────

section('TEST 8: Tech stack accuracy')
{
  const session = makeSession(MODEL_COMPARISON_MESSAGES)
  const summary = summarizeIntelligent(session.messages)

  const hasAngular = summary.techStack?.includes('Angular') ?? false
  !hasAngular ? pass('Angular not hallucinated in model-comparison session') : fail('Angular incorrectly detected in model-comparison session')

  const session2 = makeSession(CODING_MESSAGES)
  const summary2 = summarizeIntelligent(session2.messages)

  const hasPG2 = summary2.techStack?.includes('PostgreSQL') ?? false
  hasPG2 ? pass('PostgreSQL detected in coding session') : fail('PostgreSQL NOT detected in coding session')

  const hasReact = summary2.techStack?.some(t => /react/i.test(t)) ?? false
  hasReact ? pass('React detected in coding session') : fail('React NOT detected in coding session')
}

console.log('\n── DONE ──\n')
