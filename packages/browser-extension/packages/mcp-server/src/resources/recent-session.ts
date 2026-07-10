// packages/mcp-server/src/resources/recent-session.ts
//
// MCP resource — auto-injected into IDE context. The most recent captured
// session is always available as a static resource so the IDE AI can read
// it without an explicit tool call.

import { storageBridge } from "../bridge/storage-bridge.js";

export const RECENT_SESSION_URI = "contextmover://recent";

export async function readRecentSession(): Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
  const sessions = storageBridge.getAllSessions(1);

  if (sessions.length === 0) {
    return {
      contents: [{
        uri:      RECENT_SESSION_URI,
        mimeType: "text/plain",
        text:     "No sessions captured yet. Install the ContextMover browser extension and capture a conversation on claude.ai, chatgpt.com, gemini.google.com, grok.com, chat.deepseek.com, or perplexity.ai.",
      }],
    };
  }

  const s    = sessions[0];
  const tail = s.messages.slice(-6);
  const tailFmt = tail
    .map(m => `${m.role}: ${m.content.slice(0, 300)}${m.content.length > 300 ? " …" : ""}`)
    .join("\n\n");

  const text =
`Recent Session: ${s.title}
Platform:       ${s.platform}
Messages:       ${s.messageCount}
Updated:        ${new Date(s.updatedAt).toLocaleString()}

Last exchange:
${tailFmt}`;

  return {
    contents: [{
      uri:      RECENT_SESSION_URI,
      mimeType: "text/plain",
      text,
    }],
  };
}
