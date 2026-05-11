// packages/mcp-server/src/tools/semantic-search.ts

import { z } from "zod";

import { embedQuery }          from "../embedder.js";
import { storageBridge }       from "../bridge/storage-bridge.js";
import type { McpToolResult }   from "../types.js";

export const semanticSearchTool = {
  name: "semantic_search",
  description:
    "Search captured sessions by MEANING, not keywords. Finds sessions " +
    "related to a topic even when the exact words differ. More powerful " +
    "than search_sessions. Example: \"authentication bug\" finds sessions " +
    "about JWT, OAuth, login issues even without those exact words. " +
    "Use when keyword search returns nothing useful.",
  inputSchema: z.object({
    query: z.string().min(1).max(500).describe(
      "Natural-language description of what you need. Be specific: " +
      "\"React hook causing infinite re-render\" not just \"React bug\"."
    ),
    topK: z.number().int().min(1).max(20).default(5).describe(
      "Number of sessions to return (1–20)."
    ),
  }),
};

type Input = z.infer<typeof semanticSearchTool.inputSchema>;

export async function semanticSearchHandler(input: Input): Promise<McpToolResult> {
  // ── Primary path: embed the query and run cosine similarity over stored chunks.
  try {
    const queryEmbedding = await embedQuery(input.query);
    const results        = storageBridge.searchSemantic(queryEmbedding, input.topK);

    if (results.length === 0) {
      return {
        content: [{
          type: "text",
          text:
`No semantically similar sessions found for "${input.query}".

Possible reasons:
- No embeddings have been synced yet. Make sure the ContextMover extension
  is running and has captured at least one session with semantic indexing.
- Captures exist but cover unrelated topics.

Try:
- list_sessions       — browse what's available
- search_sessions     — keyword fallback`,
        }],
      };
    }

    const formatted = results.map((r, i) =>
`${i + 1}. [${r.sessionId}] ${r.session?.title ?? r.sessionTitle}
   Platform:      ${r.session?.platform ?? r.sessionPlatform}
   Relevance:     ${(r.score * 100).toFixed(1)}%
   Messages:      ${r.session?.messageCount ?? 0}
   Matched chunk: "${r.chunkText.slice(0, 140).replace(/\s+/g, " ")}${r.chunkText.length > 140 ? "…" : ""}"`
    ).join("\n\n");

    return {
      content: [{
        type: "text",
        text:
`Found ${results.length} semantically related session(s):

${formatted}

Use get_session with one of the IDs above for the full content.`,
      }],
    };
  } catch (err) {
    // ── Fallback path: model failed to load (offline, no disk space, etc).
    //    Degrade gracefully to keyword search so the tool always produces something.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[CM:semantic_search] Embedder failed, falling back to keyword:", message);

    const results = storageBridge.searchSessions(input.query, input.topK);
    if (results.length === 0) {
      return {
        content: [{
          type: "text",
          text: `Semantic embedder unavailable and keyword fallback found no matches for "${input.query}".\nReason: ${message}`,
        }],
      };
    }
    const formatted = results
      .map(s => `${s.id} | ${s.platform} | ${s.title} | ${s.messageCount} msgs`)
      .join("\n");

    return {
      content: [{
        type: "text",
        text: `Semantic embedder unavailable — showing keyword matches instead:\n\n${formatted}`,
      }],
    };
  }
}
