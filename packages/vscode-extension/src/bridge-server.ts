// packages/vscode-extension/src/bridge-server.ts
import * as http from "http";
import { EventEmitter } from "events";
import type { ContextCollector, IDESnapshot } from "./context-collector";

export class BridgeServer extends EventEmitter {
  private server: http.Server | null = null;
  private _isRunning = false;
  private cachedSnapshot: IDESnapshot | null = null;
  private lastBrowserContext: unknown = null;

  constructor(
    private readonly port: number,
    private readonly collector: ContextCollector
  ) {
    super();
  }

  get isRunning() {
    return this._isRunning;
  }

  start() {
    if (this._isRunning) return;

    this.server = http.createServer((req, res) => {
      // CORS — only allow requests from chrome-extension:// origins.
      // Any regular website can make fetch() calls to 127.0.0.1:49152 in the
      // user's browser; the Origin header is the only browser-enforced gate.
      const origin = req.headers["origin"] ?? "";
      const allowed = origin.startsWith("chrome-extension://") || origin === "";

      if (!allowed) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden: untrusted origin" }));
        return;
      }

      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Vary", "Origin");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && req.url === "/context") {
        this.handleGetContext(res);
      } else if (req.method === "POST" && req.url === "/context") {
        this.handlePostContext(req, res);
      } else if (req.method === "GET" && req.url === "/health") {
        void this.handleHealth(res);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    this.server.listen(this.port, "127.0.0.1", () => {
      this._isRunning = true;
      console.log(
        `[ContextForge] Bridge listening on http://127.0.0.1:${this.port}`
      );
      this.emit("connection");
    });

    this.server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.warn(
          `[ContextForge] Port ${this.port} in use — bridge not started.`
        );
      } else {
        console.error("[ContextForge] Bridge error:", err);
      }
      this._isRunning = false;
    });
  }

  stop() {
    this.server?.close();
    this._isRunning = false;
    this.emit("disconnection");
  }

  private async handleGetContext(res: http.ServerResponse) {
    const snapshot = await this.collector.capture();
    this.cachedSnapshot = snapshot;
    const ideContext = this.collector.formatAsText(snapshot);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ideContext,
        snapshot,
        browserContext: this.lastBrowserContext,
      })
    );
  }

  private async handleHealth(res: http.ServerResponse) {
    const snapshot = this.cachedSnapshot ?? (await this.collector.capture());
    this.cachedSnapshot = snapshot;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        port: this.port,
        vscodeConnected: true,
        workspaceName: snapshot.workspaceName,
        workspaceRoot: snapshot.workspaceRoot,
        openFilesCount: snapshot.openFiles.length,
        workspaceFilesCount: snapshot.workspaceFiles.length,
        diagnosticsCount: snapshot.diagnostics.length,
        capturedAt: snapshot.capturedAt,
      })
    );
  }

  private handlePostContext(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const MAX_BODY_BYTES = 1_048_576; // 1 MB
    let body = "";
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on("end", () => {
      if (res.headersSent) return;
      try {
        this.lastBrowserContext = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        this.emit("browserContext", this.lastBrowserContext);
      } catch {
        res.writeHead(400);
        res.end("Bad JSON");
      }
    });
  }
}
