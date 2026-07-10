// packages/mcp-server/src/tools/search-sessions.ts

import { z } from "zod";
import { storageBridge }    from "../bridge/storage-bridge.js";
import type { McpToolResult } from "../types.js";

export const searchSessionsTool = {
  name: "search_sessions",
  description:
    "Keyword-search across captured sessions (title + message bodies). " +
    "Use this to find sessions about specific topics, bugs, or features. " +
    "Returns matching session ids — pair with get_session to fetch the content.",
  inputSchema: z.object({
    query: z.string().min(1).max(200).describe("Search term — topic, bug name, feature, code symbol"),
    limit: z.number().int().min(1).max(50).default(10).describe("Max results (1–50)"),
  }),
};

type Input = z.infer<typeof searchSessionsTool.inputSchema>;

export async function searchSessionsHandler(input: Input): Promise<McpToolResult> {
  const results = storageBridge.searchSessions(input.query, input.limit);

  if (results.length === 0) {
    return {
      content: [{
        type: "text",
        text: `No sessions found matching "${input.query}".`,
      }],
    };
  }

  const formatted = results
    .map(s => `${s.id} | ${s.platform} | ${s.title} | ${s.messageCount} msgs | ${new Date(s.updatedAt).toLocaleString()}`)
    .join("\n");

  return {
    content: [{
      type: "text",
      text: `Found ${results.length} session(s) matching "${input.query}":\n\n${formatted}`,
    }],
  };
}
