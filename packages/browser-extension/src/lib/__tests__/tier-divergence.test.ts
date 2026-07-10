/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

/**
 * Tier divergence test — Crime and Punishment fixture (1.18 MB)
 *
 * Verifies:
 *   3A-1  T1/T2/T3 produce distinct SHA-256 hashes and strictly ordered char counts.
 *   3A-2  T3 tail-pad fix — exactly TOP_K messages are retained; no extra 10-message
 *         tail pad when chunk count >= 5.  This test FAILS before the
 *         getMessagesFromChunks fix and PASSES after.
 *
 * Notes on size expectations for literary text (no code blocks):
 *   T1 ≈ 100% of input (all 200 messages verbatim + XML overhead)
 *   T2 ≈ 3-5% of input  (structured extract: goal + currentState + decisions + 6-msg tail)
 *   T3 ≈ 25% of input   (top-50/200 keyword-relevant messages verbatim)
 *   T2 < T3 for literary text (unlike coding sessions where T2 preserves large code blocks).
 *   T1 > T3 > T2 is therefore the correct ordering for C&P.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { buildTier1File, buildTier2File, buildTier3File } from '../file-builder'
import { summarizeIntelligent } from '../summarizer'
import type { ContextSession, Message } from '../types'
import type { ChunkEmbedding } from '../db'
import type { MigrationFile } from '../file-builder'

// path from packages/browser-extension/src/lib/__tests__/ → ContextMover root
const FIXTURE_PATH = resolve(__dirname, '../../../../../crime and punishment.txt')
const QUERY = 'What does Raskolnikov feel about his crime?'
const MSG_COUNT = 200
const TOP_K = 50

// ── helpers ────────────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function keywordScore(text: string): number {
  const lower = text.toLowerCase()
  return ['raskolnikov', 'crime', 'guilt', 'feel', 'punishment'].reduce(
    (n, w) => n + (lower.split(w).length - 1),
    0
  )
}

function keywordDensity(content: string): number {
  const lower = content.toLowerCase()
  const hits = ['raskolnikov', 'crime', 'guilt'].reduce(
    (n, w) => n + (lower.split(w).length - 1),
    0
  )
  return hits / content.length
}

function makeChunk(session: ContextSession, messages: Message[], msgIdx: number, chunkIdx: number): ChunkEmbedding {
  return {
    id: `${session.id}:${chunkIdx}`,
    sessionId: session.id,
    chunkIndex: chunkIdx,
    text: messages[msgIdx].content.slice(0, 512),
    embedding: [],
    role: messages[msgIdx].role,
    messageIndex: msgIdx,
    hasCode: false,
    tokenCount: Math.ceil(messages[msgIdx].content.length / 4),
    createdAt: Date.now(),
  }
}

// ── shared fixture ─────────────────────────────────────────────────────────────

let session: ContextSession
let messages: Message[]
let t1: MigrationFile
let t2: MigrationFile
let t3: MigrationFile
let chunks: ChunkEmbedding[]

beforeAll(() => {
  if (!existsSync(FIXTURE_PATH)) return

  const text = readFileSync(FIXTURE_PATH, 'utf8')
  const chunkSize = Math.ceil(text.length / MSG_COUNT)

  messages = Array.from({ length: MSG_COUNT }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: text.slice(i * chunkSize, (i + 1) * chunkSize),
    timestamp: Date.now() + i,
  }))

  session = {
    id: 'cnp-tier-test',
    title: 'Crime and Punishment',
    platform: 'claude',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages,
  }

  // T1 — all 200 messages verbatim
  t1 = buildTier1File(session)

  // T2 — structured intelligent summary (pure-logic, no ML)
  const summary = summarizeIntelligent(messages, QUERY)
  t2 = buildTier2File(session, summary, QUERY)

  // T3 — top-50 keyword-relevant messages, excluding last 10 so the tail-pad
  // fix is clearly exercised (the last-10 will NOT already be in the chunk set).
  const scored = messages
    .map((m, i) => ({ i, score: keywordScore(m.content) }))
    .filter(({ i }) => i < MSG_COUNT - 10)
  scored.sort((a, b) => b.score - a.score)
  const topKIndices = scored.slice(0, TOP_K)

  chunks = topKIndices.map(({ i }, ci) => makeChunk(session, messages, i, ci))
  t3 = buildTier3File(session, chunks, QUERY)
})

// ── 3A-1 — divergence assertions ───────────────────────────────────────────────

describe('3A-1: tier files are distinct and size-ordered', () => {
  it('fixture file exists', () => {
    expect(existsSync(FIXTURE_PATH), `fixture not found at ${FIXTURE_PATH}`).toBe(true)
  })

  it('all three SHA-256 hashes are different', () => {
    const h1 = sha256(t1.content)
    const h2 = sha256(t2.content)
    const h3 = sha256(t3.content)
    expect(h1, 'T1 sha256 === T2 sha256').not.toBe(h2)
    expect(h1, 'T1 sha256 === T3 sha256').not.toBe(h3)
    expect(h2, 'T2 sha256 === T3 sha256').not.toBe(h3)
  })

  it('T1 is larger than T2 and T3', () => {
    expect(t1.charCount, 'T1 should be larger than T2').toBeGreaterThan(t2.charCount)
    expect(t1.charCount, 'T1 should be larger than T3').toBeGreaterThan(t3.charCount)
  })

  it('T1 preserves >= 90% of raw input chars', () => {
    const inputChars = messages.reduce((s, m) => s + m.content.length, 0)
    expect(t1.charCount, 'T1 should be >= 90% of input chars').toBeGreaterThanOrEqual(
      inputChars * 0.90
    )
  })

  it('T3 <= 40% of T1 (top-50/200 messages = ~25% of content + overhead)', () => {
    expect(t3.charCount, 'T3 should be at most 40% of T1').toBeLessThanOrEqual(
      t1.charCount * 0.40
    )
  })

  it('T2 << T1 (structured extract has no code blocks from C&P)', () => {
    expect(t2.charCount, 'T2 should be < 10% of T1').toBeLessThan(t1.charCount * 0.10)
  })

  it('T3 keyword density > T1 (attention engine focused on query topic)', () => {
    const d1 = keywordDensity(t1.content)
    const d3 = keywordDensity(t3.content)
    expect(d3, 'T3 keyword density should exceed T1').toBeGreaterThan(d1)
  })

  it('T3 tier field is 3, T2 tier field is 2, T1 tier field is 1', () => {
    expect(t1.tier).toBe(1)
    expect(t2.tier).toBe(2)
    expect(t3.tier).toBe(3)
  })
})

// ── 3A-2 — tail-pad fix regression ────────────────────────────────────────────
// This test FAILS before fix (getMessagesFromChunks always appends last-10)
// and PASSES after fix (tail-pad guarded by chunks.length < 5).

describe('3A-2: getMessagesFromChunks tail-pad fix', () => {
  it(`T3 contains exactly ${TOP_K} messages — no extra tail padding when chunks.length >= 5`, () => {
    // The chunks were built from indices 0..189 (last 10 excluded).
    // Before fix: getMessagesFromChunks unconditionally appends last-10 messages
    //             (indices 190-199) → 60 <message> tags instead of 50.
    // After fix:  only tail-pads when chunks.length < 5 → exactly 50.
    const msgTags = (t3.content.match(/<message /g) ?? []).length
    expect(
      msgTags,
      `Expected exactly ${TOP_K} <message> tags but got ${msgTags}. ` +
      'If this is 60, the tail-pad fix in getMessagesFromChunks is not applied.'
    ).toBe(TOP_K)
  })

  it('T3 with 3 chunks (< 5) still tail-pads to ensure minimal context', () => {
    if (!existsSync(FIXTURE_PATH)) return

    const tinyChunks: ChunkEmbedding[] = [0, 1, 2].map((i, ci) =>
      makeChunk(session, messages, i, ci)
    )
    const t3tiny = buildTier3File(session, tinyChunks, QUERY)
    const msgTags = (t3tiny.content.match(/<message /g) ?? []).length
    // 3 explicit + up to 10 tail = between 3 and 13
    expect(msgTags, 'tiny chunk set should tail-pad').toBeGreaterThan(3)
    expect(msgTags).toBeLessThanOrEqual(13)
  })
})
