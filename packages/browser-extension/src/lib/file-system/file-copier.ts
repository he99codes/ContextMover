// packages/browser-extension/src/lib/file-system/file-copier.ts
//
// Standalone file copy/export utility.
// Handles clipboard copy, blob download, platform formatting, and zip creation.
// 100% client-side — no server involved.

import JSZip from "jszip";
import type { ProjectFile } from "./project-reader";

// ─────────────────────────────────────────────────────────────────────────────

export class FileCopier {

  // ── Clipboard ───────────────────────────────────────────────────────────────

  async copyRaw(files: ProjectFile[]): Promise<void> {
    const text = this.buildRawFormat(files);
    await navigator.clipboard.writeText(text);
    console.log(`[ContextMover:files] copied ${files.length} file(s) raw`);
  }

  async copyForPlatform(
    files: ProjectFile[],
    platform: "claude" | "chatgpt" | "gemini" | "grok",
  ): Promise<void> {
    let text: string;
    switch (platform) {
      case "claude":   text = this.buildClaudeFormat(files); break;
      case "chatgpt":  text = this.buildChatGPTFormat(files); break;
      case "gemini":   text = this.buildGeminiFormat(files); break;
      case "grok":     text = this.buildGrokFormat(files); break;
    }
    await navigator.clipboard.writeText(text);
    console.log(`[ContextMover:files] copied ${files.length} file(s) for ${platform}`);
  }

  async copyPath(file: ProjectFile): Promise<void> {
    await navigator.clipboard.writeText(file.path);
  }

  // ── Downloads ───────────────────────────────────────────────────────────────

  async downloadFile(file: ProjectFile): Promise<void> {
    const blob = new Blob([file.content], { type: this.getMimeType(file.name) });
    this.triggerDownload(blob, file.name);
  }

  async downloadAsZip(files: ProjectFile[]): Promise<void> {
    const zip = new JSZip();
    for (const f of files) {
      zip.file(f.path, f.content);
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    this.triggerDownload(blob, `contextmover-files-${Date.now()}.zip`);
  }

  // ── Format builders ─────────────────────────────────────────────────────────

  buildClaudeFormat(files: ProjectFile[]): string {
    const tags = files.map((f) =>
      `  <file path="${f.path}" language="${f.language}">\n${f.content}\n  </file>`
    ).join("\n");
    return `<project_files>\n${tags}\n</project_files>\nContinue working on these files.`;
  }

  buildChatGPTFormat(files: ProjectFile[]): string {
    const sections = files.map((f) =>
      `### ${f.path}\n\`\`\`${f.language}\n${f.content}\n\`\`\``
    ).join("\n\n");
    return `## Project Files\n\n${sections}`;
  }

  buildGeminiFormat(files: ProjectFile[]): string {
    const sections = files.map((f) =>
      `FILE: ${f.path}\nLANGUAGE: ${f.language}\n---\n${f.content}\n---`
    ).join("\n\n");
    return `[PROJECT FILES]\n\n${sections}`;
  }

  buildGrokFormat(files: ProjectFile[]): string {
    const sections = files.map((f) =>
      `### ${f.path}\n\`\`\`${f.language}\n${f.content}\n\`\`\``
    ).join("\n\n");
    return `## Files\n\n${sections}`;
  }

  buildRawFormat(files: ProjectFile[]): string {
    if (files.length === 1) return files[0].content;
    return files.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n\n");
  }

  // ── Token estimation ────────────────────────────────────────────────────────

  estimateTokens(files: ProjectFile[]): number {
    const CODE_EXTENSIONS = [
      '.ts', '.tsx', '.js', '.jsx', '.py', '.go',
      '.rs', '.cpp', '.c', '.java', '.cs', '.php', '.rb', '.swift', '.kt',
    ];
    return files.reduce((sum, f) => {
      const ext = f.path.substring(f.path.lastIndexOf('.')).toLowerCase();
      const divisor = CODE_EXTENSIONS.includes(ext) ? 3 : 4;
      return sum + Math.ceil(f.content.length / divisor);
    }, 0);
  }

  getTokenWarningLevel(tokens: number): "safe" | "warning" | "danger" {
    if (tokens > 100_000) return "danger";
    if (tokens > 50_000) return "warning";
    return "safe";
  }

  // ── MIME type ───────────────────────────────────────────────────────────────

  getMimeType(filename: string): string {
    const ext = filename.includes(".")
      ? filename.split(".").pop()!.toLowerCase()
      : "";
    const map: Record<string, string> = {
      ts: "text/typescript", tsx: "text/typescript",
      js: "text/javascript", jsx: "text/javascript",
      mjs: "text/javascript",
      py: "text/x-python",
      json: "application/json",
      md: "text/markdown", mdx: "text/markdown",
      html: "text/html", htm: "text/html",
      css: "text/css", scss: "text/css",
      yaml: "text/yaml", yml: "text/yaml",
      xml: "text/xml",
      sh: "text/x-sh", bash: "text/x-sh",
      sql: "text/x-sql",
      rs: "text/x-rust",
      go: "text/x-go",
    };
    return map[ext] ?? "text/plain";
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export const fileCopier = new FileCopier();
