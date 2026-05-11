/// <reference lib="webworker" />
//
// packages/browser-extension/src/lib/workers/indexing.worker.ts
//
// Heavy chunk + embed work runs here, off the main thread.
// Hosted by the offscreen document (see src/offscreen/offscreen.ts).
// IndexedDB writes happen on the offscreen document's thread, NOT here —
// keeps this worker stateless and crash-safe.

import { chunkMessages, type Chunk } from "../semantic-index/chunker";
import { modelRegistry } from "../semantic-index/model-registry";
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
      await modelRegistry.initialize(hardware, (pct) => {
        self.postMessage({
          id,
          type: "PROGRESS",
          progress: 20 + pct * 0.5,
          stage: "Loading AI model...",
        });
      });

      self.postMessage({
        id,
        type: "PROGRESS",
        progress: 70,
        stage: `Embedding ${chunks.length} chunks...`,
      });
      const embeddings = await modelRegistry.embedBatch(chunks.map((c) => c.text));

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
      const { text, hardware } = data.payload;
      await modelRegistry.initialize(hardware);
      const embedding = await modelRegistry.embed(text);
      self.postMessage({ id, type: "EMBED_DONE", embedding });
      return;
    }

    if ((data as { type: string }).type === "WARMUP") {
      const { getHardwareProfile } = await import("../attention-engine");
      const hw = await getHardwareProfile().catch(() => null);
      if (hw) await modelRegistry.initialize(hw).catch(() => {});
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
