// packages/mcp-server/src/tools/get-quality-report.ts

import { z } from "zod";
import { storageBridge }    from "../bridge/storage-bridge.js";
import type { McpToolResult } from "../types.js";

export const getQualityReportTool = {
  name: "get_quality_report",
  description:
    "Get aggregate statistics across all captured sessions: total count, " +
    "platform breakdown, last capture timestamp, and average quality score " +
    "(from migration scoring, if available). Useful for diagnostics.",
  inputSchema: z.object({}),
};

type Input = z.infer<typeof getQualityReportTool.inputSchema>;

export async function getQualityReportHandler(_input: Input): Promise<McpToolResult> {
  const stats = storageBridge.getStats();

  // Compute average quality score over the last 50 sessions.
  const recent = storageBridge.getAllSessions(50);
  const scored = recent.filter(s => typeof s.qualityScore === "number");
  const avgQuality = scored.length > 0
    ? scored.reduce((a, s) => a + (s.qualityScore ?? 0), 0) / scored.length
    : null;

  const report = {
    totalSessions:  stats.totalSessions,
    platforms:      stats.platforms,
    lastUpdated:    stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleString() : null,
    scoredSessions: scored.length,
    averageQuality: avgQuality !== null ? Math.round(avgQuality * 10) / 10 : null,
  };

  return {
    content: [{
      type: "text",
      text: JSON.stringify(report, null, 2),
    }],
  };
}
