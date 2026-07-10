// packages/mcp-server/src/tools/get-session.ts

import { z } from "zod";
import { storageBridge }    from "../bridge/storage-bridge.js";
import type { McpToolResult } from "../types.js";

export const getSessionTool = {
  name: "get_session",
  description:
    "Get the content of a specific captured session. " +
    "tier='full' returns every message verbatim; " +
    "tier='summary' returns the pre-built compressed summary if available; " +
    "tier='smart' returns goal + recent tail + extracted code blocks " +
    "(best default for resuming work). Use session IDs from list_sessions.",
  inputSchema: z.object({
    sessionId: z.string().min(1).describe("Session ID returned by list_sessions"),
    tier: z
      .enum(["full", "summary", "smart"])
      .default("smart")
      .describe("full | summary | smart — see tool description"),
  }),
};

type Input = z.infer<typeof getSessionTool.inputSchema>;

export async function getSessionHandler(input: Input): Promise<McpToolResult> {
  const session = storageBridge.getSession(input.sessionId);
  if (!session) {
    return {
      content: [{
        type: "text",
        text: `Session ${input.sessionId} not found. Use list_sessions to see available sessions.`,
      }],
    };
  }

  // ── Full ────────────────────────────────────────────────────────────────
  if (input.tier === "full") {
    const body = session.messages
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n---\n\n");

    return {
      content: [{
        type: "text",
        text: `# ${session.title}\n\nPlatform: ${session.platform}\nMessages: ${session.messageCount}\n\n${body}`,
      }],
    };
  }

  // ── Stored summary (best-effort) ────────────────────────────────────────
  if (input.tier === "summary") {
    const stored = storageBridge.getSummary(input.sessionId, 1);
    if (stored) {
      return { content: [{ type: "text", text: stored }] };
    }
    // Fall through to smart if no pre-built summary exists.
  }

  // ── Smart: goal + tail + code blocks ────────────────────────────────────
  const userMessages = session.messages.filter(m => m.role === "user");
  const codeBlocks   = session.messages.flatMap(m => m.content.match(/```[\s\S]*?```/g) ?? []);
  const tail         = session.messages.slice(-6);

  const goal = userMessages[0]?.content ?? "Unknown";
  const tailFmt = tail
    .map(m => `**${m.role}:** ${m.content.slice(0, 500)}${m.content.length > 500 ? " …" : ""}`)
    .join("\n\n");
  const codeFmt = codeBlocks.slice(0, 5).join("\n\n") || "_(no code blocks captured)_";

  const text =
`# ${session.title}

Platform: ${session.platform}
Messages: ${session.messageCount}
Code blocks: ${codeBlocks.length}

## Original Goal
${goal}

## Recent Context (last ${tail.length} messages)
${tailFmt}

## Code Produced
${codeFmt}

## Continue from here
Pick up exactly where this session left off. Do not re-explain what was already decided.`;

  return { content: [{ type: "text", text }] };
}
