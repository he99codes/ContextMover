// packages/mcp-server/src/resources/session-summary.ts
//
// Aggregate summary resource — gives the IDE AI a one-shot overview of the
// last few captured sessions without needing to call list_sessions first.

import { storageBridge } from "../bridge/storage-bridge.js";

export const SESSION_SUMMARY_URI = "contextmover://summary";

export async function readSessionSummary(): Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
  const sessions = storageBridge.getAllSessions(10);
  const stats    = storageBridge.getStats();

  if (sessions.length === 0) {
    return {
      contents: [{
        uri:      SESSION_SUMMARY_URI,
        mimeType: "text/plain",
        text:     "No sessions captured yet.",
      }],
    };
  }

  const lines = sessions.map((s, i) =>
    `${i + 1}. [${s.platform}] ${s.title} — ${s.messageCount} msgs (${new Date(s.updatedAt).toLocaleDateString()})  id=${s.id}`
  );

  const platformLine = Object.entries(stats.platforms)
    .map(([p, n]) => `${p}: ${n}`)
    .join(", ");

  const text =
`ContextMover — Session Summary

Total sessions: ${stats.totalSessions}
By platform:    ${platformLine || "(none)"}
Last updated:   ${stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleString() : "never"}

Recent sessions:
${lines.join("\n")}`;

  return {
    contents: [{
      uri:      SESSION_SUMMARY_URI,
      mimeType: "text/plain",
      text,
    }],
  };
}
