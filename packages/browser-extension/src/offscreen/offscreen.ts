/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/offscreen/offscreen.ts
//
// Hidden offscreen document. Runs chunking + embedding on its own thread
// (the offscreen document IS already a separate process from the SW — no
// nested worker needed). IndexedDB writes happen here where Dexie is stable.
//
// Message protocol with SW:
//   IN:  { type: 'OFFSCREEN_INDEX_SESSION', session, hardware, requestId }
//        { type: 'OFFSCREEN_EMBED_QUERY',   text,    hardware, requestId }
//        { type: 'OFFSCREEN_WARMUP' }
//        { type: 'OFFSCREEN_PING' }
//   OUT: chrome.runtime.sendMessage (broadcast back to SW listeners)
//        { type: 'OFFSCREEN_PROGRESS', requestId, progress, stage }
//        { type: 'OFFSCREEN_INDEX_DONE', requestId, chunkCount }
//        { type: 'OFFSCREEN_EMBED_DONE', requestId, embedding }
//        { type: 'OFFSCREEN_ERROR', requestId, error }

import type { ContextSession } from "../lib/types";
import type { HardwareProfile } from "../lib/attention-engine";
import { chunkMessages, type Chunk } from "../lib/semantic-index/chunker";
import { embedText, embedTexts, warmup } from "../lib/inference/embedder";
import { dexieDb, type ChunkEmbedding } from "../lib/db";
import { hashMessages } from "../lib/semantic-index/hasher";

console.log("[CM:offscreen] booted");

// Pre-load the model so it's hot before the first real request arrives.
// Signal OFFSCREEN_READY when done so the SW can release queued embed requests.
warmup().then(() => {
  chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" }).catch(() => {});
  console.log("[CM:offscreen] ready — embedder pipeline initialized");
}).catch(() => {
  // Warmup failed, but still signal ready to prevent the SW from blocking forever.
  chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" }).catch(() => {});
  console.warn("[CM:offscreen] warmup failed — signalling ready to unblock embed queue");
});

// ── Helpers ────────────────────────────────────────────────────────────────

function progress(requestId: string, pct: number, stage: string) {
  chrome.runtime.sendMessage({ type: "OFFSCREEN_PROGRESS", requestId, progress: pct, stage }).catch(() => {});
}

// ── Indexing pipeline ──────────────────────────────────────────────────────

async function indexSession(
  session: ContextSession,
  hardware: HardwareProfile,
  requestId: string
): Promise<{ chunkCount: number }> {
  progress(requestId, 10, "Chunking messages...");
  const chunks: Chunk[] = chunkMessages(session.messages);

  progress(requestId, 20, "Loading model...");
  await warmup();

  progress(requestId, 70, `Embedding ${chunks.length} chunks...`);
  const embeddings = await embedTexts(chunks.map((c) => c.text));

  progress(requestId, 90, "Persisting to storage...");

  // Delete stale chunks and write fresh ones
  await dexieDb.chunkEmbeddings.where("sessionId").equals(session.id).delete();

  const modelId = "Xenova/all-MiniLM-L6-v2";

  const chunkRecords: ChunkEmbedding[] = chunks.map((chunk: Chunk, i: number) => ({
    id: `${session.id}:${i}`,
    sessionId: session.id,
    chunkIndex: i,
    text: chunk.text,
    embedding: embeddings[i],
    role: chunk.role,
    messageIndex: chunk.messageIndex,
    hasCode: chunk.hasCode,
    language: chunk.language,
    tokenCount: chunk.tokenCount,
    createdAt: Date.now(),
  }));
  await dexieDb.chunkEmbeddings.bulkPut(chunkRecords);

  await dexieDb.sessionHashes.put({
    sessionId: session.id,
    hash: hashMessages(session.messages),
    chunkCount: chunks.length,
    messageCount: session.messages.length,
    model: modelId,
    indexedAt: Date.now(),
  });

  return { chunkCount: chunks.length };
}

// ── chrome.runtime message router ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "OFFSCREEN_INDEX_SESSION") {
    const { session, hardware, requestId } = msg as {
      session: ContextSession;
      hardware: HardwareProfile;
      requestId: string;
    };
    indexSession(session, hardware, requestId)
      .then((res) => {
        chrome.runtime.sendMessage({ type: "OFFSCREEN_INDEX_DONE", requestId, chunkCount: res.chunkCount }).catch(() => {});
        sendResponse({ ok: true, chunkCount: res.chunkCount });
      })
      .catch((err: Error) => {
        chrome.runtime.sendMessage({ type: "OFFSCREEN_ERROR", requestId, error: err.message }).catch(() => {});
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (msg.type === "OFFSCREEN_EMBED_QUERY") {
    const { text, requestId } = msg as { text: string; requestId: string };
    embedText(text)
      .then((embedding) => {
        chrome.runtime.sendMessage({
          type: "OFFSCREEN_EMBED_DONE",
          requestId,
          embedding
        }).catch(() => {});
        sendResponse({ ok: true, embedding });
      })
      .catch((err: Error) => {
        chrome.runtime.sendMessage({
          type: "OFFSCREEN_ERROR",
          requestId,
          error: err.message
        }).catch(() => {});
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (msg.type === "OFFSCREEN_WARMUP") {
    // Pre-load model so it's hot when the user clicks Migrate
    warmup().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "OFFSCREEN_PING") {
    sendResponse({ alive: true });
    return false;
  }

  return false;
});
