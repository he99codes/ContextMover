# @contextmover/mcp-server

MCP (Model Context Protocol) server that exposes your captured AI chat
sessions to any MCP-capable IDE — Cursor, Windsurf, VS Code via
Continue.dev, or Claude Desktop.

Pairs with the [ContextMover Chrome extension](https://chromewebstore.google.com/).

## Install

```bash
npx -y @contextmover/mcp-server      # on-demand via your IDE config
# or
npm install -g @contextmover/mcp-server
```

See [SETUP.md](./SETUP.md) for full IDE configuration.

## What it does

- HTTP loopback on `127.0.0.1:49001` so the browser extension can sync
  captured sessions in fire-and-forget fashion.
- Mirrors sessions into `~/.contextmover/sessions.db` (SQLite, WAL mode).
- Speaks MCP over stdio so your IDE AI can list, search, fetch, and
  migrate captured sessions on your behalf.

## Tools

`list_sessions`, `get_session`, `search_sessions`, `migrate_context`,
`get_quality_report`.

## Resources

`contextmover://recent`, `contextmover://summary`.

## Self-test

```bash
npx -y @contextmover/mcp-server --self-test
```

## License

MIT
