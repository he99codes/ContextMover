// packages/mcp-server/src/tools/list-sessions.ts

import { z } from "zod";
import { storageBridge }    from "../bridge/storage-bridge.js";
import type { McpToolResult } from "../types.js";

export const listSessionsTool = {
  name: "list_sessions",
  description:
    "List captured AI chat sessions from ContextMover. Returns recent sessions " +
    "with metadata (id, platform, title, message count, last update). " +
    "Use this to find sessions before fetching full content with get_session.",
  inputSchema: z.object({
    platform: z
      .enum(["claude", "chatgpt", "gemini", "grok", "deepseek", "perplexity", "all"])
      .default("all")
      .describe("Filter by AI platform or 'all' for everything"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Number of sessions to return (1–50)"),
  }),
};

type Input = z.infer<typeof listSessionsTool.inputSchema>;

export async function listSessionsHandler(input: Input): Promise<McpToolResult> {
  const sessions = input.platform === "all"
    ? storageBridge.getAllSessions(input.limit)
    : storageBridge.getSessionsByPlatform(input.platform, input.limit);

  if (sessions.length === 0) {
    return {
      content: [{
        type: "text",
        text:
          "No sessions found. Capture a conversation in your browser using the " +
          "ContextMover extension first (claude.ai, chatgpt.com, gemini.google.com, " +
          "grok.com, chat.deepseek.com, or perplexity.ai).",
      }],
    };
  }

  const formatted = sessions.map(s => ({
    id:           s.id,
    platform:     s.platform,
    title:        s.title,
    messageCount: s.messageCount,
    hasCode:      s.hasCode,
    qualityScore: s.qualityScore ?? null,
    updatedAt:    new Date(s.updatedAt).toLocaleString(),
  }));

  return {
    content: [{
      type: "text",
      text: JSON.stringify(formatted, null, 2),
    }],
  };
}
