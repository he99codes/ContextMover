// packages/browser-extension/src/lib/file-system/project-reader.ts
//
// Reads the user's local project folder via the Chrome File System Access API.
// No VS Code required — user grants permission once via the native file picker.
// Read-only; never writes to the file system.

export interface ProjectFile {
  path: string;
  name: string;
  language: string;
  size: number;
  content: string;
  lastModified: number;
}

export interface FileTreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  language?: string;
  size?: number;
  children?: FileTreeNode[];
  selected: boolean;
  modified?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────

export class ProjectReader {
  private rootHandle: FileSystemDirectoryHandle | null = null;
  private fileTree: FileTreeNode[] = [];
  private selectedPaths = new Set<string>();

  private readonly IGNORE = new Set([
    "node_modules", ".git", "dist", "build",
    ".next", "out", "coverage", ".turbo",
    "__pycache__", ".venv", "venv",
    "target", ".cargo", "vendor",
  ]);

  private readonly IGNORE_EXT = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".svg",
    ".ico", ".woff", ".woff2", ".ttf", ".eot",
    ".mp4", ".mp3", ".zip", ".tar", ".gz",
    ".pdf", ".lock", ".map",
    ".webp", ".avif", ".tiff", ".bmp",
    ".exe", ".dll", ".so", ".dylib",
    ".class", ".pyc",
  ]);

  // ── Public API ──────────────────────────────────────────────────────────────

  get rootName(): string {
    return this.rootHandle?.name ?? "";
  }

  get isConnected(): boolean {
    return this.rootHandle !== null;
  }

  get tree(): FileTreeNode[] {
    return this.fileTree;
  }

  async openFolder(): Promise<FileTreeNode[]> {
    const handle = await (window as unknown as {
      showDirectoryPicker(opts: { mode: string }): Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker({ mode: "read" });
    this.rootHandle = handle;
    this.selectedPaths.clear();
    this.fileTree = await this.buildTree(handle, "", 0);
    return this.fileTree;
  }

  async buildTree(
    handle: FileSystemDirectoryHandle,
    path: string,
    depth: number,
  ): Promise<FileTreeNode[]> {
    if (depth > 6) return [];
    const dirs: FileTreeNode[] = [];
    const files: FileTreeNode[] = [];

    for await (const [name, entry] of handle as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (entry.kind === "directory") {
        if (this.IGNORE.has(name) || name.startsWith(".")) continue;
        const childPath = path ? `${path}/${name}` : name;
        const children = await this.buildTree(
          entry as FileSystemDirectoryHandle,
          childPath,
          depth + 1,
        );
        dirs.push({
          name,
          path: childPath,
          kind: "directory",
          children,
          selected: false,
        });
      } else {
        const ext = name.includes(".") ? `.${name.split(".").pop()!.toLowerCase()}` : "";
        if (this.IGNORE_EXT.has(ext)) continue;
        const filePath = path ? `${path}/${name}` : name;
        let size = 0;
        try {
          const file = await (entry as FileSystemFileHandle).getFile();
          size = file.size;
        } catch { /* size unavailable */ }
        files.push({
          name,
          path: filePath,
          kind: "file",
          language: this.detectLanguage(name),
          size,
          selected: false,
        });
      }
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  async readFile(filePath: string): Promise<ProjectFile> {
    if (!this.rootHandle) throw new Error("No folder connected.");
    const parts = filePath.split("/");
    let dirHandle: FileSystemDirectoryHandle = this.rootHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      dirHandle = await dirHandle.getDirectoryHandle(parts[i]);
    }
    const fileHandle = await dirHandle.getFileHandle(parts[parts.length - 1]);
    const file = await fileHandle.getFile();
    const content = await file.text();
    return {
      path: filePath,
      name: parts[parts.length - 1],
      language: this.detectLanguage(file.name),
      size: file.size,
      content,
      lastModified: file.lastModified,
    };
  }

  async readSelectedFiles(): Promise<ProjectFile[]> {
    const sorted = Array.from(this.selectedPaths).sort();
    const results: ProjectFile[] = [];
    for (const p of sorted) {
      try {
        results.push(await this.readFile(p));
      } catch (err) {
        console.warn(`[ContextForge:files] Could not read ${p}:`, err);
      }
    }
    return results;
  }

  toggleSelect(path: string): void {
    const node = this.findNode(path, this.fileTree);
    if (!node) return;
    if (node.kind === "directory") {
      const filePaths = this.collectFilePaths(node);
      const allSelected = filePaths.every((p) => this.selectedPaths.has(p));
      if (allSelected) {
        filePaths.forEach((p) => this.selectedPaths.delete(p));
      } else {
        filePaths.forEach((p) => this.selectedPaths.add(p));
      }
      this.updateSelectedFlags(this.fileTree);
    } else {
      if (this.selectedPaths.has(path)) {
        this.selectedPaths.delete(path);
        node.selected = false;
      } else {
        this.selectedPaths.add(path);
        node.selected = true;
      }
    }
  }

  selectAll(): void {
    this.collectFilePaths({ kind: "directory", path: "", name: "", selected: false, children: this.fileTree })
      .forEach((p) => this.selectedPaths.add(p));
    this.updateSelectedFlags(this.fileTree);
  }

  clearAll(): void {
    this.selectedPaths.clear();
    this.updateSelectedFlags(this.fileTree);
  }

  getTotalSelectedSize(): number {
    let total = 0;
    for (const path of this.selectedPaths) {
      const node = this.findNode(path, this.fileTree);
      if (node?.size) total += node.size;
    }
    return total;
  }

  getSelectedCount(): number {
    return this.selectedPaths.size;
  }

  isSelected(path: string): boolean {
    return this.selectedPaths.has(path);
  }

  getSelectedPaths(): Set<string> {
    return new Set(this.selectedPaths);
  }

  detectLanguage(filename: string): string {
    const ext = filename.includes(".")
      ? filename.split(".").pop()!.toLowerCase()
      : "";
    const map: Record<string, string> = {
      ts: "typescript", tsx: "typescript",
      js: "javascript", jsx: "javascript",
      mjs: "javascript", cjs: "javascript",
      py: "python",
      rs: "rust",
      go: "go",
      java: "java",
      cs: "csharp",
      cpp: "cpp", cc: "cpp", cxx: "cpp", c: "c", h: "cpp",
      md: "markdown", mdx: "markdown",
      json: "json",
      yaml: "yaml", yml: "yaml",
      sql: "sql",
      css: "css", scss: "css", sass: "css", less: "css",
      html: "html", htm: "html",
      xml: "xml",
      sh: "bash", bash: "bash",
      rb: "ruby",
      php: "php",
      swift: "swift",
      kt: "kotlin",
      tf: "terraform", hcl: "terraform",
      env: "plaintext",
    };
    return map[ext] ?? "plaintext";
  }

  buildFileTreeText(filter?: string): string {
    const lines: string[] = [];
    const walk = (nodes: FileTreeNode[], indent: number) => {
      for (const node of nodes) {
        if (filter && !this.nodeMatchesFilter(node, filter)) continue;
        const prefix = "  ".repeat(indent);
        if (node.kind === "directory") {
          lines.push(`${prefix}${node.name}/`);
          if (node.children) walk(node.children, indent + 1);
        } else {
          const sel = this.selectedPaths.has(node.path) ? " ← selected" : "";
          lines.push(`${prefix}${node.name}${sel}`);
        }
      }
    };
    walk(this.fileTree, 0);
    return lines.join("\n");
  }

  async refresh(): Promise<FileTreeNode[]> {
    if (!this.rootHandle) return [];
    const prevSelected = new Set(this.selectedPaths);
    this.fileTree = await this.buildTree(this.rootHandle, "", 0);
    // Restore selections that still exist
    this.selectedPaths.clear();
    for (const p of prevSelected) {
      if (this.findNode(p, this.fileTree)) this.selectedPaths.add(p);
    }
    this.updateSelectedFlags(this.fileTree);
    return this.fileTree;
  }

  setSelection(paths: string[]): void {
    this.selectedPaths.clear();
    const all = this.collectFilePaths({
      kind: "directory", path: "", name: "", selected: false, children: this.fileTree,
    });
    for (const p of paths) {
      if (all.includes(p)) this.selectedPaths.add(p);
    }
    this.updateSelectedFlags(this.fileTree);
  }

  async readAllFiles(maxSizeBytes = 200_000): Promise<ProjectFile[]> {
    const allPaths = this.collectFilePaths({
      kind: "directory", path: "", name: "", selected: false, children: this.fileTree,
    });
    const results: ProjectFile[] = [];
    for (const p of allPaths) {
      const node = this.findNode(p, this.fileTree);
      if (node?.size && node.size > maxSizeBytes) continue;
      try { results.push(await this.readFile(p)); } catch { /* skip unreadable */ }
    }
    return results;
  }

  disconnect(): void {
    this.rootHandle = null;
    this.fileTree = [];
    this.selectedPaths.clear();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private findNode(path: string, nodes: FileTreeNode[]): FileTreeNode | null {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.kind === "directory" && node.children) {
        const found = this.findNode(path, node.children);
        if (found) return found;
      }
    }
    return null;
  }

  private collectFilePaths(node: FileTreeNode): string[] {
    if (node.kind === "file") return [node.path];
    const paths: string[] = [];
    if (node.children) {
      for (const child of node.children) {
        paths.push(...this.collectFilePaths(child));
      }
    }
    return paths;
  }

  private updateSelectedFlags(nodes: FileTreeNode[]): void {
    for (const node of nodes) {
      if (node.kind === "file") {
        node.selected = this.selectedPaths.has(node.path);
      } else if (node.children) {
        this.updateSelectedFlags(node.children);
        const childFiles = this.collectFilePaths(node);
        node.selected = childFiles.length > 0 && childFiles.every((p) => this.selectedPaths.has(p));
      }
    }
  }

  private nodeMatchesFilter(node: FileTreeNode, query: string): boolean {
    const q = query.toLowerCase();
    if (node.name.toLowerCase().includes(q)) return true;
    if (node.kind === "directory" && node.children) {
      return node.children.some((c) => this.nodeMatchesFilter(c, query));
    }
    return false;
  }
}

export const projectReader = new ProjectReader();
