#!/usr/bin/env node
// packages/mcp-server/src/index.ts
//
// Entry point — published as the `contextmover-mcp` binary.
// Boots:
//   1. SQLite storage (auto-created at ~/.contextmover/sessions.db)
//   2. HTTP extension bridge on 127.0.0.1:49001 (optional — silently
//      skipped if the port is in use)
//   3. MCP server on stdio (the IDE owns stdin/stdout)
//
// IMPORTANT: never write to stdout — MCP stdio uses it for protocol frames.
// All logs go to stderr via console.error.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer, SERVER_VERSION } from "./server.js";
import { startExtensionBridge }             from "./bridge/extension-bridge.js";
import { storageBridge }                    from "./bridge/storage-bridge.js";

async function selfTest(): Promise<void> {
  console.error(`[CM:mcp] Self-test v${SERVER_VERSION}`);
  console.error(`[CM:mcp] DB:   ${(storageBridge as unknown as { getDbPath?: () => string }).getDbPath?.() ?? "<unknown>"}`);

  // Sanity: SQLite read.
  const stats = storageBridge.getStats();
  console.error(`[CM:mcp] Stats: ${JSON.stringify(stats)}`);

  // Sanity: tool registration.
  const server = await createMcpServer();
  console.error(`[CM:mcp] Server created — ${server.isConnected() ? "connected" : "ready"}`);

  // Sanity: insert + read.
  const probeId = `__selftest_${Date.now()}`;
  storageBridge.upsertSession({
    id:           probeId,
    platform:     "claude",
    title:        "self-test",
    messages:     [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
    createdAt:    Date.now(),
    updatedAt:    Date.now(),
    messageCount: 2,
    hasCode:      false,
  });
  const probe = storageBridge.getSession(probeId);
  if (!probe || probe.messages.length !== 2) {
    console.error("[CM:mcp] Self-test FAILED: probe roundtrip lost messages");
    process.exit(1);
  }
  console.error(`[CM:mcp] Self-test OK — round-tripped probe session`);
  process.exit(0);
}

async function main(): Promise<void> {
  // Allow --self-test for CI / dev sanity checks (does not bind any ports).
  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }

  console.error(`[CM:mcp] ContextMover MCP Server v${SERVER_VERSION} starting...`);

  // ── 1) Extension HTTP bridge — MUST be awaited so the listen() callback
  //       fires before the MCP stdio transport binds stdin. Otherwise the
  //       IDE could ask the server to call back into the bridge before the
  //       socket is actually accepting connections.
  //       startExtensionBridge() resolves with port=-1 on EADDRINUSE so a
  //       second instance launched by an IDE still produces a working MCP
  //       transport (the older instance keeps owning the bridge port).
  try {
    const bridge = await startExtensionBridge();
    if (bridge.port < 0) {
      console.error("[CM:mcp] WARNING: Extension sync DISABLED in this instance.");
      console.error("[CM:mcp] WARNING: Another MCP server already owns 127.0.0.1:49001.");
      console.error("[CM:mcp] WARNING: New captures will reach that instance, not this one.");
    }
  } catch (err) {
    console.error("[CM:mcp] Extension bridge failed to start:", err);
    // Non-fatal — MCP transport still works for read-only IDE queries
    // against any sessions already in the SQLite file.
  }

  // ── 2) MCP stdio server (the part IDEs actually talk to) ─────────────────
  const server    = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[CM:mcp] MCP server ready on stdio");

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = (signal: string) => {
    console.error(`[CM:mcp] ${signal} received — shutting down`);
    try { storageBridge.close?.(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch(err => {
  console.error("[CM:mcp] Fatal error:", err);
  process.exit(1);
});
