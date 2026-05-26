/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

/// <reference lib="webworker" />
//
// packages/browser-extension/src/lib/workers/indexing.worker.ts
//
// Heavy chunk + embed work runs here, off the main thread.
// Hosted by the offscreen document (see src/offscreen/offscreen.ts).
// IndexedDB writes happen on the offscreen document's thread, NOT here —
// keeps this worker stateless and crash-safe.

import { chunkMessages, type Chunk } from "../semantic-index/chunker";
import { embedTexts, embedText, warmup } from "../inference/embedder";
import type { HardwareProfile } from "../attention-engine";
import type { ContextSession } from "../types";

interface IncomingIndex {
  type: "INDEX_SESSION";
  id: string;
  payload: { session: ContextSession; hardware: HardwareProfile };
}

interface IncomingEmbed {
  type: "EMBED_QUERY";
  id: string;
  payload: { text: string; hardware: HardwareProfile };
}

type Incoming = IncomingIndex | IncomingEmbed;

self.onmessage = async (ev: MessageEvent<Incoming>) => {
  const data = ev.data;
  if (!data || typeof data !== "object") return;
  const { type, id } = data;

  try {
    if (type === "INDEX_SESSION") {
      const { session, hardware } = data.payload;

      self.postMessage({ id, type: "PROGRESS", progress: 10, stage: "Chunking messages..." });
      const chunks = chunkMessages(session.messages);

      self.postMessage({ id, type: "PROGRESS", progress: 20, stage: "Loading model..." });
      await warmup();

      self.postMessage({
        id,
        type: "PROGRESS",
        progress: 70,
        stage: `Embedding ${chunks.length} chunks...`,
      });
      const embeddings = await embedTexts(chunks.map((c) => c.text));

      const result: { id: string; type: "INDEX_DONE"; chunks: Chunk[]; embeddings: number[][] } = {
        id,
        type: "INDEX_DONE",
        chunks,
        embeddings,
      };
      self.postMessage(result);
      return;
    }

    if (type === "EMBED_QUERY") {
      const { text } = data.payload;
      await warmup();
      const embedding = await embedText(text);
      self.postMessage({ id, type: "EMBED_DONE", embedding });
      return;
    }

    if ((data as { type: string }).type === "WARMUP") {
      await warmup().catch(() => {});
      self.postMessage({ id, type: "WARMUP_DONE" });
      return;
    }
  } catch (err) {
    self.postMessage({
      id,
      type: "ERROR",
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export {}; // tell TS this is a module
