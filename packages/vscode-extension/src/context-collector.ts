// packages/vscode-extension/src/context-collector.ts
import * as vscode from "vscode";
import * as path from "path";
import { execSync } from "child_process";

export interface IDESnapshot {
  activeFile: ActiveFile | null;
  openFiles: OpenFile[];
  workspaceFiles: WorkspaceFile[];
  workspaceName: string | null;
  workspaceRoot: string | null;
  gitBranch: string | null;
  gitDiff: string | null;
  diagnostics: DiagnosticItem[];
  capturedAt: number;
}

export interface ActiveFile {
  path: string;
  relativePath: string;
  language: string;
  content: string;
  selection: string | null;
  cursorLine: number;
}

export interface OpenFile {
  path: string;
  relativePath: string;
  language: string;
  isDirty: boolean;
}

export interface WorkspaceFile {
  path: string;
  relativePath: string;
  language: string;
  excerpt: string;
}

export interface DiagnosticItem {
  file: string;
  severity: "error" | "warning" | "info";
  message: string;
  line: number;
}

export class ContextCollector {
  async capture(): Promise<IDESnapshot> {
    const config = vscode.workspace.getConfiguration("contextmover");
    const maxFiles: number = config.get("maxFilesInContext") ?? 10;
    const maxWorkspaceFiles: number = config.get("maxWorkspaceFilesInContext") ?? 30;
    const maxWorkspaceFileChars: number =
      config.get("maxWorkspaceFileChars") ?? 1200;

    const activeEditor = vscode.window.activeTextEditor;
    const activeFile = activeEditor ? this.extractActiveFile(activeEditor) : null;

    const openFiles = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText)
      .map((t) => (t.input as vscode.TabInputText).uri)
      .slice(0, maxFiles)
      .map((uri) => this.extractOpenFile(uri))
      .filter(Boolean) as OpenFile[];

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceRoot = workspaceFolder?.uri.fsPath ?? null;
    const workspaceName = workspaceFolder?.name ?? null;
    const workspaceFiles = await this.extractWorkspaceFiles(
      maxWorkspaceFiles,
      maxWorkspaceFileChars
    );

    const { gitBranch, gitDiff } = this.tryGetGitInfo(workspaceRoot);
    const diagnostics = this.extractDiagnostics();

    return {
      activeFile,
      openFiles,
      workspaceFiles,
      workspaceName,
      workspaceRoot,
      gitBranch,
      gitDiff,
      diagnostics,
      capturedAt: Date.now(),
    };
  }

  private extractActiveFile(editor: vscode.TextEditor): ActiveFile {
    const doc = editor.document;
    const sel = editor.selection;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);

    return {
      path: doc.uri.fsPath,
      relativePath: workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, doc.uri.fsPath)
        : doc.uri.fsPath,
      language: doc.languageId,
      content: doc.getText(),
      selection: sel.isEmpty ? null : doc.getText(sel),
      cursorLine: sel.active.line + 1,
    };
  }

  private extractOpenFile(uri: vscode.Uri): OpenFile | null {
    try {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === uri.toString()
      );
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      return {
        path: uri.fsPath,
        relativePath: workspaceFolder
          ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath)
          : uri.fsPath,
        language: doc?.languageId ?? "unknown",
        isDirty: doc?.isDirty ?? false,
      };
    } catch {
      return null;
    }
  }

  private async extractWorkspaceFiles(
    maxWorkspaceFiles: number,
    maxWorkspaceFileChars: number
  ): Promise<WorkspaceFile[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder || maxWorkspaceFiles <= 0) {
      return [];
    }

    const files = await vscode.workspace.findFiles(
      "**/*",
      "**/{node_modules,.git,dist,build,coverage,.next,out,.turbo}/**",
      maxWorkspaceFiles
    );

    const workspaceFiles: WorkspaceFile[] = [];

    for (const uri of files) {
      if (uri.scheme !== "file") {
        continue;
      }

      try {
        const document = await vscode.workspace.openTextDocument(uri);
        const content = document.getText().trim();

        if (!content) {
          continue;
        }

        workspaceFiles.push({
          path: uri.fsPath,
          relativePath: path.relative(workspaceFolder.uri.fsPath, uri.fsPath),
          language: document.languageId,
          excerpt:
            content.length > maxWorkspaceFileChars
              ? `${content.slice(0, maxWorkspaceFileChars)}\n... [truncated]`
              : content,
        });
      } catch {
        continue;
      }
    }

    return workspaceFiles;
  }

  private tryGetGitInfo(workspaceRoot: string | null): {
    gitBranch: string | null;
    gitDiff: string | null;
  } {
    if (!workspaceRoot) return { gitBranch: null, gitDiff: null };
    try {
      const gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: workspaceRoot,
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      const gitDiff = execSync("git diff --stat HEAD", {
        cwd: workspaceRoot,
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      return { gitBranch, gitDiff };
    } catch {
      return { gitBranch: null, gitDiff: null };
    }
  }

  private extractDiagnostics(): DiagnosticItem[] {
    const items: DiagnosticItem[] = [];
    vscode.languages.getDiagnostics().forEach(([uri, diags]) => {
      diags
        .filter((d) =>
          [
            vscode.DiagnosticSeverity.Error,
            vscode.DiagnosticSeverity.Warning,
          ].includes(d.severity)
        )
        .slice(0, 20)
        .forEach((d) => {
          items.push({
            file: vscode.workspace.asRelativePath(uri),
            severity:
              d.severity === vscode.DiagnosticSeverity.Error
                ? "error"
                : d.severity === vscode.DiagnosticSeverity.Warning
                ? "warning"
                : "info",
            message: d.message,
            line: d.range.start.line + 1,
          });
        });
    });
    return items;
  }

  /** Formats a snapshot as human-readable text for inclusion in prompts */
  formatAsText(snapshot: IDESnapshot): string {
    const lines: string[] = [];

    if (snapshot.workspaceName) {
      lines.push(`Workspace: ${snapshot.workspaceName}`);
    }
    if (snapshot.gitBranch) {
      lines.push(`Git branch: ${snapshot.gitBranch}`);
    }
    if (snapshot.gitDiff) {
      lines.push(`Git diff summary:\n${snapshot.gitDiff}`);
    }
    if (snapshot.activeFile) {
      const f = snapshot.activeFile;
      lines.push(
        `Active file: ${f.relativePath} (${f.language}, cursor at line ${f.cursorLine})`
      );
      if (f.selection) {
        lines.push(
          `Selected code:\n\`\`\`${f.language}\n${f.selection}\n\`\`\``
        );
      } else {
        const truncated =
          f.content.length > 4000
            ? f.content.slice(0, 4000) + "\n... [truncated]"
            : f.content;
        lines.push(
          `File content:\n\`\`\`${f.language}\n${truncated}\n\`\`\``
        );
      }
    }
    if (snapshot.openFiles.length > 0) {
      lines.push(
        `Open files: ${snapshot.openFiles.map((f) => f.relativePath).join(", ")}`
      );
    }
    if (snapshot.workspaceFiles.length > 0) {
      lines.push(
        `Workspace files indexed: ${snapshot.workspaceFiles.length}`
      );
      lines.push(
        snapshot.workspaceFiles
          .map(
            (file) =>
              `File: ${file.relativePath} (${file.language})\n\`\`\`${file.language}\n${file.excerpt}\n\`\`\``
          )
          .join("\n\n")
      );
    }
    if (snapshot.diagnostics.length > 0) {
      lines.push(
        "Diagnostics:\n" +
          snapshot.diagnostics
            .map(
              (d) =>
                `  [${d.severity.toUpperCase()}] ${d.file}:${d.line} — ${d.message}`
            )
            .join("\n")
      );
    }

    return lines.join("\n\n");
  }
}
