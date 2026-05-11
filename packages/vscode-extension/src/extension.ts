// packages/vscode-extension/src/extension.ts
import * as vscode from "vscode";
import { ContextCollector } from "./context-collector";
import { BridgeServer } from "./bridge-server";
import { buildIdeMigrationPrompt, type LlmProvider } from "./prompt-builder";

let bridge: BridgeServer | undefined;
let collector: ContextCollector | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log("[ContextForge] VS Code extension activating.");

  collector = new ContextCollector();
  const getConfig = () => vscode.workspace.getConfiguration("contextforge");
  const port: number = getConfig().get("bridgePort") ?? 49152;

  bridge = new BridgeServer(port, collector);
  bridge.start();

  // ── Status bar item ────────────────────────────────────────────────────────
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusItem.text = "$(plug) ContextForge";
  statusItem.tooltip = `ContextForge bridge on :${port}`;
  statusItem.command = "contextforge.captureContext";
  statusItem.show();
  context.subscriptions.push(statusItem);

  bridge.on("connection", () => {
    statusItem.text = "$(plug) ContextForge $(check)";
    statusItem.tooltip = `ContextForge — browser connected on :${port}`;
  });
  bridge.on("disconnection", () => {
    statusItem.text = "$(plug) ContextForge";
    statusItem.tooltip = `ContextForge bridge on :${port}`;
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "contextforge.captureContext",
      async () => {
        const snapshot = await collector!.capture();
        vscode.window.showInformationMessage(
          `[ContextForge] Captured: ${snapshot.openFiles.length} file(s)` +
            (snapshot.gitBranch ? `, branch: ${snapshot.gitBranch}` : "") +
            (snapshot.diagnostics.length
              ? `, ${snapshot.diagnostics.length} diagnostic(s)`
              : "")
        );
      }
    ),

    vscode.commands.registerCommand(
      "contextforge.copyContextForLLM",
      async () => {
        await migrateContextToProvider({ openTarget: false });
      }
    ),

    vscode.commands.registerCommand("contextforge.openInLLM", async () => {
      await migrateContextToProvider({ openTarget: true });
    }),

    vscode.commands.registerCommand("contextforge.startBridge", () => {
      if (!bridge?.isRunning) {
        bridge?.start();
        vscode.window.showInformationMessage(
          `[ContextForge] Bridge started on port ${port}.`
        );
      } else {
        vscode.window.showInformationMessage(
          `[ContextForge] Bridge already running on port ${port}.`
        );
      }
    })
  );

  async function migrateContextToProvider(options: { openTarget: boolean }) {
    const snapshot = await collector!.capture();
    const ideContext = collector!.formatAsText(snapshot);
    const config = getConfig();
    const provider = await resolveProvider(config);

    if (!provider) {
      return;
    }

    const customLaunchUrl =
      provider === "custom" ? config.get<string>("customProviderUrl") : null;
    const result = buildIdeMigrationPrompt(
      snapshot,
      ideContext,
      provider,
      customLaunchUrl
    );

    await vscode.env.clipboard.writeText(result.prompt);

    if (options.openTarget && result.launchUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(result.launchUrl));
    }

    const destination =
      provider === "custom"
        ? result.launchUrl
          ? `your custom LLM at ${result.launchUrl}`
          : "your custom LLM"
        : provider;

    const actionLabel = options.openTarget
      ? `Prompt copied and ${destination} opened.`
      : `Prompt copied for ${destination}.`;

    const openLabel =
      !options.openTarget && result.launchUrl ? "Open Target" : undefined;
    const selection = await vscode.window.showInformationMessage(
      `[ContextForge] ${actionLabel} Paste it into the chat input to continue.`,
      ...(openLabel ? [openLabel] : [])
    );

    if (selection === "Open Target" && result.launchUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(result.launchUrl));
    }
  }
}

export function deactivate() {
  bridge?.stop();
}

async function resolveProvider(
  config: vscode.WorkspaceConfiguration
): Promise<LlmProvider | undefined> {
  const configured =
    (config.get<string>("preferredProvider") as LlmProvider | "ask" | undefined) ??
    "ask";

  if (configured !== "ask") {
    return configured;
  }

  const pick = await vscode.window.showQuickPick(
    [
      { label: "ChatGPT", value: "chatgpt" as const },
      { label: "Claude", value: "claude" as const },
      { label: "Gemini", value: "gemini" as const },
      { label: "Grok", value: "grok" as const },
      { label: "Custom URL", value: "custom" as const },
    ],
    {
      title: "Choose the LLM target for this migration",
      placeHolder: "Select where to send the current VS Code context",
    }
  );

  return pick?.value;
}
