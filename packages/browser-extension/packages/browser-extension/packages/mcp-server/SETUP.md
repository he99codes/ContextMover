# ContextMover MCP Server — Setup

Bring your captured AI chat sessions (Claude, ChatGPT, Gemini, Grok,
DeepSeek, Perplexity) directly into your IDE AI via the Model Context
Protocol.

## How it works

```
Chrome extension (captures)
       │
       ▼   POST /sessions
Local MCP bridge  ⇄  SQLite (~/.contextmover/sessions.db)
       │
       ▼   stdio
IDE AI (Cursor / Windsurf / VS Code · Continue / Claude Desktop)
```

The extension fires-and-forgets every captured session to a loopback
HTTP endpoint. The MCP server reads from the same SQLite file and
exposes 5 tools and 2 resources over MCP stdio to your IDE.

You don't have to install the MCP server — the extension works without
it. Install only if you want IDE access.

---

## Install

No clone required — `npx -y @contextmover/mcp-server` will fetch it
on demand the first time your IDE starts the process.

For a permanent install:

```bash
npm install -g @contextmover/mcp-server
```

---

## Configure your IDE

### Cursor

Open `~/.cursor/mcp.json` (create if missing) and add:

```json
{
  "mcpServers": {
    "contextmover": {
      "command": "npx",
      "args": ["-y", "@contextmover/mcp-server"]
    }
  }
}
```

Restart Cursor.

### Windsurf

Open `~/.codeium/windsurf/mcp_config.json` and add the same block as
Cursor above. Restart Windsurf.

### Claude Desktop

Open `claude_desktop_config.json` (location varies by OS):

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Add:

```json
{
  "mcpServers": {
    "contextmover": {
      "command": "npx",
      "args": ["-y", "@contextmover/mcp-server"]
    }
  }
}
```

Restart Claude Desktop.

### Continue.dev (VS Code)

Add to `.continue/config.json` in your repo or `~/.continue/config.json`
globally:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@contextmover/mcp-server"]
        }
      }
    ]
  }
}
```

Reload VS Code.

---

## Available MCP tools

Once configured, the IDE AI can call these on your behalf:

| Tool                  | Purpose                                                      |
|-----------------------|--------------------------------------------------------------|
| `list_sessions`       | List recent captured sessions (filter by platform).          |
| `get_session`         | Fetch one session — full, summary, or smart (goal + tail + code). |
| `search_sessions`     | Keyword-search across titles + bodies.                       |
| `migrate_context`     | Build an IDE-formatted migration prompt (Cursor MD / Claude XML). |
| `get_quality_report`  | Aggregate stats: total sessions, platform breakdown, quality. |

## MCP resources (auto-injected)

- `contextmover://recent` — most recently captured session.
- `contextmover://summary` — overview of the last 10 sessions.

---

## Example prompts

```
"Show me my recent sessions"
→ list_sessions
```
```
"Find my Claude conversation about JWT auth and continue it here"
→ search_sessions → migrate_context
```
```
"Pick up where I left off in the bug-hunt session"
→ list_sessions → get_session (tier='smart')
```

---

## Troubleshooting

- **`MCP bridge offline` badge in the extension sidebar**
  → The MCP server isn't running. Open your IDE — it will spawn it.
  Or run `npx -y @contextmover/mcp-server` manually for diagnostics.

- **Port 49001 in use**
  → Another MCP instance is already running. That's fine — sessions
  from the extension reach whichever instance is bound. Only one MCP
  server need be running at a time.

- **Sessions don't appear in IDE**
  → Verify capture works in the sidebar first. Then check the SQLite
  file: `ls -la ~/.contextmover/sessions.db`. The file is created on
  first MCP server start.

- **Self-test**
  ```bash
  npx -y @contextmover/mcp-server --self-test
  ```
  Roundtrips an insert/read against the SQLite file and exits.

---

## Privacy

All data stays local. Sessions never leave your machine via the MCP
server. The SQLite file lives at `~/.contextmover/sessions.db` —
delete it at any time to reset.
