/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/file-system/context-builder.ts
//
// Converts a list of ProjectFile objects into a platform-specific context
// block that is injected into the migration prompt before conversation_tail.

import type { ProjectFile } from "./project-reader";
import type { Platform } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Token limit constants (safe soft limits per platform)
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_TOKEN_LIMITS: Partial<Record<Platform, number>> = {
  claude:     180_000,
  chatgpt:    100_000,
  gemini:     900_000,
  grok:       100_000,
  perplexity:  60_000,
  deepseek:   100_000,
};

const WARNING_THRESHOLD = 0.80;

// ─────────────────────────────────────────────────────────────────────────────

export class FileContextBuilder {

  buildProjectContext(
    files: ProjectFile[],
    rootName: string,
    fileTreeText: string,
    platform: Platform = "claude",
  ): string {
    if (files.length === 0) return "";

    switch (platform) {
      case "claude":
        return this.buildXml(files, rootName, fileTreeText);
      case "chatgpt":
      case "grok":
        return this.buildMarkdown(files, rootName, fileTreeText);
      case "gemini":
      case "perplexity":
      case "deepseek":
        return this.buildPlain(files, rootName, fileTreeText);
      default:
        return this.buildMarkdown(files, rootName, fileTreeText);
    }
  }

  getTokenWarning(files: ProjectFile[], platform: Platform): string | null {
    const totalChars = files.reduce((sum, f) => sum + f.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    const limit = PLATFORM_TOKEN_LIMITS[platform] ?? 80_000;

    if (estimatedTokens >= limit) {
      return `⚠️ Selection exceeds ${platform} limit (~${limit.toLocaleString()} tokens). Reduce selection.`;
    }
    if (estimatedTokens >= limit * WARNING_THRESHOLD) {
      const pct = Math.round((estimatedTokens / limit) * 100);
      return `⚠️ Large selection — ${pct}% of ${platform} token limit (~${limit.toLocaleString()} tokens)`;
    }
    return null;
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  // ── Formats ─────────────────────────────────────────────────────────────────

  private static cdata(s: string): string {
    return `<![CDATA[${s.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
  }

  private static xmlAttr(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private buildXml(files: ProjectFile[], rootName: string, fileTreeText: string): string {
    const fileTags = files.map((f) =>
      `    <file path="${FileContextBuilder.xmlAttr(f.path)}" language="${FileContextBuilder.xmlAttr(f.language)}" size="${this.formatSize(f.size)}">\n${FileContextBuilder.cdata(f.content)}\n    </file>`
    ).join("\n");

    const indentedTree = fileTreeText.split("\n").map((l) => `    ${l}`).join("\n");

    return [
      `<project_context>`,
      `  <folder>${FileContextBuilder.cdata(rootName)}</folder>`,
      `  <selected_files count="${files.length}">`,
      fileTags,
      `  </selected_files>`,
      `  <file_tree>`,
      FileContextBuilder.cdata(indentedTree),
      `  </file_tree>`,
      `</project_context>`,
    ].join("\n");
  }

  private buildMarkdown(files: ProjectFile[], rootName: string, fileTreeText: string): string {
    const sections = files.map((f) =>
      `### ${f.path}\n\`\`\`${f.language}\n${f.content}\n\`\`\``
    ).join("\n\n");

    return [
      `## Project Context`,
      `**Folder:** ${rootName}`,
      `**Selected files:** ${files.length}`,
      ``,
      `### File Tree`,
      `\`\`\``,
      fileTreeText,
      `\`\`\``,
      ``,
      sections,
    ].join("\n");
  }

  private buildPlain(files: ProjectFile[], rootName: string, fileTreeText: string): string {
    const sections = files.map((f) =>
      `[FILE: ${f.path}]\n${f.content}`
    ).join("\n\n");

    return [
      `[PROJECT CONTEXT]`,
      `Folder: ${rootName}`,
      `Files: ${files.length} selected`,
      ``,
      `[FILE TREE]`,
      fileTreeText,
      ``,
      sections,
    ].join("\n");
  }
}

export const fileContextBuilder = new FileContextBuilder();
