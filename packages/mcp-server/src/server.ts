// packages/mcp-server/src/server.ts
//
// Builds an McpServer instance, registers all tools + resources, and
// returns it ready to be connected to a transport (stdio for IDEs,
// or SSE/HTTP if invoked elsewhere).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { listSessionsTool,        listSessionsHandler }        from "./tools/list-sessions.js";
import { getSessionTool,          getSessionHandler }          from "./tools/get-session.js";
import { searchSessionsTool,      searchSessionsHandler }      from "./tools/search-sessions.js";
import { migrateContextTool,      migrateContextHandler }      from "./tools/migrate-context.js";
import { getQualityReportTool,    getQualityReportHandler }    from "./tools/get-quality-report.js";
import { semanticSearchTool,      semanticSearchHandler }      from "./tools/semantic-search.js";
import { getFileContextTool,      getFileContextHandler }      from "./tools/get-file-context.js";
import { applyPromptTemplateTool, applyPromptTemplateHandler } from "./tools/apply-prompt-template.js";

import { RECENT_SESSION_URI,    readRecentSession }    from "./resources/recent-session.js";
import { SESSION_SUMMARY_URI,   readSessionSummary }   from "./resources/session-summary.js";

export const SERVER_NAME    = "contextmover";
export const SERVER_VERSION = "0.1.0";

export async function createMcpServer(): Promise<McpServer> {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } }
  );

  // ── Tools ────────────────────────────────────────────────────────────────
  // Cast handler args to the input type — McpServer's ToolCallback infers from
  // the raw shape and produces an equivalent shape that's structurally identical
  // to our z.infer<typeof tool.inputSchema>.
  server.tool(
    listSessionsTool.name,
    listSessionsTool.description,
    listSessionsTool.inputSchema.shape,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (args: any) => listSessionsHandler(args)
  );

  server.tool(
    getSessionTool.name,
    getSessionTool.description,
    getSessionTool.inputSchema.shape,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (args: any) => getSessionHandler(args)
  );

  server.tool(
    searchSessionsTool.name,
    searchSessionsTool.description,
    searchSessionsTool.inputSchema.shape,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (args: any) => searchSessionsHandler(args)
  );

  server.tool(
    migrateContextTool.name,
    migrateContextTool.description,
    migrateContextTool.inputSchema.shape,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (args: any) => migrateContextHandler(args)
  );

  // Zero-arg overload — no schema, just description + callback.
  server.tool(
    getQualityReportTool.name,
    getQualityReportTool.description,
    () => getQualityReportHandler({})
  );

  // ── Add-on 1: Semantic search ───────────────────────────────────────────
  server.tool(
    semanticSearchTool.name,
    semanticSearchTool.description,
    semanticSearchTool.inputSchema.shape,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (args: any) => semanticSearchHandler(args)
  );

  // ── Add-on 3: File context ──────────────────────────────────────────────
  server.tool(
    getFileContextTool.name,
    getFileContextTool.description,
    getFileContextTool.inputSchema.shape,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (args: any) => getFileContextHandler(args)
  );

  // ── Add-on 4: Prompt templates ──────────────────────────────────────────
  server.tool(
    applyPromptTemplateTool.name,
    applyPromptTemplateTool.description,
    applyPromptTemplateTool.inputSchema.shape,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (args: any) => applyPromptTemplateHandler(args)
  );

  // ── Resources ────────────────────────────────────────────────────────────
  server.resource(
    "recent-session",
    RECENT_SESSION_URI,
    { mimeType: "text/plain", description: "Most recently captured AI chat session" },
    async () => readRecentSession()
  );

  server.resource(
    "session-summary",
    SESSION_SUMMARY_URI,
    {
      mimeType:    "text/plain",
      description: "Auto-injected smart summary of the most recent session — goal, code, recent context",
    },
    async () => readSessionSummary()
  );

  return server;
}
