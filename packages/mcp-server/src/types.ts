// packages/mcp-server/src/types.ts
// Shared types for the MCP server.

export interface Message {
  role:    "user" | "assistant";
  content: string;
}

export interface StoredSession {
  id:            string;
  platform:      string;
  title:         string;
  messages:      Message[];
  createdAt:     number;
  updatedAt:     number;
  messageCount:  number;
  hasCode:       boolean;
  qualityScore?: number;
}

export interface SessionStats {
  totalSessions: number;
  platforms:     Record<string, number>;
  lastUpdated:   number | null;
}

// MCP-spec content shape — what tool handlers return.
export interface McpTextContent {
  type: "text";
  text: string;
}

// Index signature mirrors the MCP SDK's CallToolResult shape so our handlers
// are structurally assignable when passed to server.tool(...).
export interface McpToolResult {
  [key: string]: unknown;
  content: McpTextContent[];
  isError?: boolean;
}
