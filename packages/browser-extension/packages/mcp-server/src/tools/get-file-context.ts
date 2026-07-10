// packages/mcp-server/src/tools/get-file-context.ts

import { z } from "zod";

import { storageBridge }       from "../bridge/storage-bridge.js";
import type { McpToolResult }   from "../types.js";
import type { SelectedFileRow } from "../bridge/storage-bridge.js";

export const getFileContextTool = {
  name: "get_file_context",
  description:
    "Get project files the user explicitly selected in the ContextMover " +
    "extension's File System panel. Returns actual file contents so the " +
    "IDE AI sees real code, not just chat history. Use this alongside " +
    "session context for the full picture — call list_sessions first to " +
    "understand what was discussed, then get_file_context to see the code.",
  inputSchema: z.object({
    format: z.enum(["raw", "xml", "markdown"]).default("markdown").describe(
      "raw: plain code blocks; xml: Claude-optimized tags; markdown: headers + fenced code blocks"
    ),
  }),
};

type Input = z.infer<typeof getFileContextTool.inputSchema>;

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderXml(files: SelectedFileRow[]): string {
  const body = files
    .map(f =>
`  <file path="${escapeXmlAttr(f.path)}" language="${escapeXmlAttr(f.language ?? "text")}" size="${f.size}">
${f.content}
  </file>`
    )
    .join("\n");
  return `<project_files>\n${body}\n</project_files>`;
}

function renderMarkdown(files: SelectedFileRow[]): string {
  const sections = [`## Project Files (${files.length} selected)`, ""];
  for (const f of files) {
    sections.push(`### ${f.path}`, `\`\`\`${f.language ?? ""}`, f.content, "```", "");
  }
  return sections.join("\n");
}

function renderRaw(files: SelectedFileRow[]): string {
  return files.map(f => `=== ${f.path} ===\n${f.content}\n`).join("\n");
}

export async function getFileContextHandler(input: Input): Promise<McpToolResult> {
  const files = storageBridge.getSelectedFiles();

  if (files.length === 0) {
    return {
      content: [{
        type: "text",
        text:
`No files selected in ContextMover extension.

To share files with your IDE:
1. Open the ContextMover sidebar in your browser
2. Click "Connect Folder" in the Project panel
3. Select files using the checkboxes
4. Files appear here automatically`,
      }],
    };
  }

  let body: string;
  switch (input.format) {
    case "xml":      body = renderXml(files);      break;
    case "markdown": body = renderMarkdown(files); break;
    case "raw":      body = renderRaw(files);      break;
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const header =
`Files: ${files.length}
Total size: ${(totalSize / 1024).toFixed(1)}KB
Est. tokens: ~${Math.ceil(totalSize / 4).toLocaleString()}

`;

  return { content: [{ type: "text", text: header + body }] };
}
