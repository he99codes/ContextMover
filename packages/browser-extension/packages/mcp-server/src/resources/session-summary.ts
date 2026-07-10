// packages/mcp-server/src/resources/session-summary.ts
//
// Auto-injected smart summary of the most-recently captured session.
// IDE clients read this resource without an explicit tool call so the
// AI always has fresh context.
//
// Priority order:
//   1. Stored tier-2 (intelligent) summary if synced from the extension
//   2. Stored tier-1 summary as a secondary fallback
//   3. Derived "quick summary" computed on the fly from raw messages

import { storageBridge }    from "../bridge/storage-bridge.js";
import type { StoredSession } from "../types.js";

export const SESSION_SUMMARY_URI = "contextmover://summary";

function buildQuickSummary(session: StoredSession): string {
  const userMessages = session.messages.filter(m => m.role === "user");
  const codeBlocks   = session.messages.flatMap(m => m.content.match(/```[\s\S]*?```/g) ?? []);
  const tail         = session.messages.slice(-4);

  const tailFmt = tail
    .map(m => `${m.role}: ${m.content.slice(0, 200)}${m.content.length > 200 ? " …" : ""}`)
    .join("\n\n");

  return [
    `Session: ${session.title}`,
    `Platform: ${session.platform}`,
    `Messages: ${session.messageCount}`,
    `Code blocks: ${codeBlocks.length}`,
    "",
    "Original goal:",
    userMessages[0]?.content?.slice(0, 300) ?? "Unknown",
    "",
    "Recent context:",
    tailFmt,
  ].join("\n");
}

export async function readSessionSummary(): Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
  const sessions = storageBridge.getAllSessions(1);

  if (sessions.length === 0) {
    return {
      contents: [{
        uri:      SESSION_SUMMARY_URI,
        mimeType: "text/plain",
        text:
`No sessions captured yet.

Install the ContextMover Chrome extension and browse any supported AI
platform to capture sessions. Supported: Claude, ChatGPT, Gemini, Grok,
DeepSeek, Perplexity.`,
      }],
    };
  }

  const session = sessions[0];

  // Prefer the highest-fidelity stored summary; fall back through tiers.
  const tier2  = storageBridge.getSummary(session.id, 2);
  const tier1  = tier2 ? null : storageBridge.getSummary(session.id, 1);
  const summary = tier2 ?? tier1 ?? buildQuickSummary(session);

  const text =
`=== ContextMover Active Session ===

${summary}

=== Session ID: ${session.id} ===
Use get_session for full content, or migrate_context to build an IDE-optimized prompt.`;

  return {
    contents: [{
      uri:      SESSION_SUMMARY_URI,
      mimeType: "text/plain",
      text,
    }],
  };
}
