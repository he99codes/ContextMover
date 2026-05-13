// packages/browser-extension/src/lib/mcp/client.ts
//
// MCP (Model Context Protocol) client for connecting to local MCP servers.
// Uses SSE transport for real-time IDE context retrieval and conversation
// creation via MCP tools.
//
// Architecture:
//   - Connects to LOCAL MCP servers (Claude Desktop, Continue.dev, custom)
//   - Uses SSE (Server-Sent Events) transport
//   - Exposes: listTools, callTool, getIdeContext
//   - NOT cloud endpoints — MCP is a local protocol
//
// Supported tools:
//   - get_active_file, get_open_files, get_git_branch
//   - list_conversations, get_conversation
//   - create_conversation (optional, server-specific)

export interface McpServerConfig {
  name: string;
  url: string; // e.g. "http://localhost:3000/sse"
  enabled: boolean;
}

export interface IdeContext {
  activeFile?: string;
  activeFileContent?: string;
  openFiles?: string[];
  gitBranch?: string;
  gitRepo?: string;
  workspaceRoot?: string;
  language?: string;
  cursorPosition?: { line: number; column: number };
}

export interface McpToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type McpMessage =
  | { jsonrpc: "2.0"; id: number | string; method: string; params?: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: { code: number; message: string } }
  | { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> };

const TAG = "[ContextMover:MCP]";

class McpClient {
  private eventSource: EventSource | null = null;
  private messageEndpoint = "";
  private connected = false;
  private pending = new Map<string | number, (res: unknown) => void>();
  private msgId = 0;
  private tools: Array<{ name: string; description?: string }> = [];
  private _onError: ((err: Error) => void) | null = null;

  get isConnected() {
    return this.connected;
  }

  get availableTools() {
    return [...this.tools];
  }

  onError(cb: (err: Error) => void) {
    this._onError = cb;
  }

  async connect(url: string): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      const es = new EventSource(url);
      this.eventSource = es;

      const timeout = setTimeout(() => {
        es.close();
        reject(new Error("MCP SSE connection timeout (10s)"));
      }, 10_000);

      es.onopen = () => {
        clearTimeout(timeout);
      };

      es.onmessage = (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as Record<string, unknown>;

          // SSE endpoint message: tells us where to POST
          if (typeof data.endpoint === "string") {
            const parsed = new URL(data.endpoint, url);
            this.messageEndpoint = parsed.toString();
            this.connected = true;
            console.log(`${TAG} connected to ${url}, messages → ${this.messageEndpoint}`);
            resolve();
            return;
          }

          // Handle JSON-RPC responses
          const msg = data as unknown as McpMessage;
          if ("id" in msg && msg.id !== undefined) {
            const resolver = this.pending.get(msg.id);
            if (resolver) {
              this.pending.delete(msg.id);
              resolver("result" in msg ? msg.result : msg);
            }
          }

          // Handle server notifications (e.g., tool list updates)
          if ("method" in msg && msg.method === "notifications/tools/list_changed") {
            void this.refreshTools();
          }
        } catch (err) {
          console.warn(`${TAG} SSE parse error:`, err);
        }
      };

      es.onerror = (err) => {
        clearTimeout(timeout);
        console.warn(`${TAG} SSE error:`, err);
        if (this._onError) this._onError(new Error(`SSE connection failed to ${url}`));
        reject(new Error(`SSE connection failed to ${url}`));
      };
    });
  }

  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.connected = false;
    this.messageEndpoint = "";
    this.tools = [];
    this.pending.clear();
  }

  private async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.messageEndpoint) {
      throw new Error("MCP client not connected");
    }

    const id = ++this.msgId;
    const body: McpMessage = { jsonrpc: "2.0", id, method, params };

    const promise = new Promise<unknown>((resolve) => {
      this.pending.set(id, resolve);
    });

    const res = await fetch(this.messageEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      this.pending.delete(id);
      throw new Error(`MCP POST failed: ${res.status} ${res.statusText}`);
    }

    // Timeout guard
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP call timeout: ${method}`));
      }, 15_000);
    });

    return Promise.race([promise, timeout]);
  }

  async initialize(): Promise<void> {
    const result = (await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "contextmover", version: "1.0.0" },
    })) as Record<string, unknown>;

    if (result.protocolVersion) {
      console.log(`${TAG} server protocol: ${result.protocolVersion}`);
    }

    // Notify server we're initialized
    await this.send("notifications/initialized");

    // Refresh tool list
    await this.refreshTools();
  }

  async refreshTools(): Promise<void> {
    try {
      const result = (await this.send("tools/list")) as { tools?: Array<{ name: string; description?: string }> };
      this.tools = result?.tools ?? [];
      console.log(`${TAG} discovered ${this.tools.length} tool(s)`);
    } catch (err) {
      console.warn(`${TAG} tools/list failed:`, err);
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = (await this.send("tools/call", { name, arguments: args })) as McpToolCallResult;
    return result;
  }

  async getIdeContext(): Promise<IdeContext> {
    const ctx: IdeContext = {};

    // Try each IDE context tool independently — fail-open
    try {
      const active = await this.callTool("get_active_file", {});
      const text = active.content?.[0]?.text ?? "";
      if (text) ctx.activeFile = text;
    } catch { /* tool not available */ }

    try {
      const open = await this.callTool("get_open_files", {});
      const text = open.content?.[0]?.text ?? "";
      if (text) {
        ctx.openFiles = text.split("\n").map((s) => s.trim()).filter(Boolean);
      }
    } catch { /* tool not available */ }

    try {
      const git = await this.callTool("get_git_branch", {});
      const text = git.content?.[0]?.text ?? "";
      if (text) {
        const lines = text.split("\n");
        ctx.gitBranch = lines[0]?.trim();
        if (lines[1]) ctx.gitRepo = lines[1].trim();
      }
    } catch { /* tool not available */ }

    try {
      const root = await this.callTool("get_workspace_root", {});
      const text = root.content?.[0]?.text ?? "";
      if (text) ctx.workspaceRoot = text.trim();
    } catch { /* tool not available */ }

    return ctx;
  }

  // Optional: create conversation via MCP if server supports it
  async createConversation(title: string, messages: Array<{ role: string; content: string }>): Promise<{ conversationId?: string }> {
    try {
      const result = await this.callTool("create_conversation", { title, messages });
      const text = result.content?.[0]?.text ?? "";
      try {
        const parsed = JSON.parse(text) as { conversationId?: string };
        return parsed;
      } catch {
        return { conversationId: text.trim() || undefined };
      }
    } catch {
      return {};
    }
  }
}

// Singleton client instance
let _client: McpClient | null = null;

export function getMcpClient(): McpClient {
  if (!_client) _client = new McpClient();
  return _client;
}

// Default server configs (user-configurable via storage)
const DEFAULT_MCP_SERVERS: McpServerConfig[] = [
  { name: "Claude Desktop", url: "http://localhost:6277/sse", enabled: false },
  { name: "Continue.dev", url: "http://localhost:3000/sse", enabled: false },
  { name: "ContextMover Local", url: "http://127.0.0.1:49001/sse", enabled: true },
];

export async function loadMcpServers(): Promise<McpServerConfig[]> {
  try {
    const stored = await chrome.storage.local.get("mcp_servers");
    const servers = stored.mcp_servers as McpServerConfig[] | undefined;
    return servers && Array.isArray(servers) && servers.length > 0 ? servers : DEFAULT_MCP_SERVERS;
  } catch {
    return DEFAULT_MCP_SERVERS;
  }
}

export async function saveMcpServers(servers: McpServerConfig[]): Promise<void> {
  await chrome.storage.local.set({ mcp_servers: servers });
}

export async function connectToFirstAvailableMcp(): Promise<McpClient | null> {
  const servers = await loadMcpServers();
  const client = getMcpClient();

  for (const srv of servers) {
    if (!srv.enabled) continue;
    try {
      await client.connect(srv.url);
      await client.initialize();
      console.log(`${TAG} connected to ${srv.name} at ${srv.url}`);
      return client;
    } catch {
      console.warn(`${TAG} failed to connect to ${srv.name} at ${srv.url}`);
    }
  }

  return null;
}
