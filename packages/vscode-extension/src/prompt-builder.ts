import type { IDESnapshot } from "./context-collector";

export type LlmProvider = "chatgpt" | "claude" | "gemini" | "grok" | "custom";

export interface LlmPromptBuildResult {
  provider: LlmProvider;
  prompt: string;
  launchUrl: string | null;
}

const PROVIDER_URLS: Record<Exclude<LlmProvider, "custom">, string> = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
  gemini: "https://gemini.google.com/app",
  grok: "https://grok.com/",
};

export function buildIdeMigrationPrompt(
  snapshot: IDESnapshot,
  ideContext: string,
  provider: LlmProvider,
  customLaunchUrl?: string | null
): LlmPromptBuildResult {
  const prompt = buildProviderPrompt(snapshot, ideContext, provider);
  const launchUrl =
    provider === "custom"
      ? normalizeCustomUrl(customLaunchUrl)
      : PROVIDER_URLS[provider];

  return { provider, prompt, launchUrl };
}

function buildProviderPrompt(
  snapshot: IDESnapshot,
  ideContext: string,
  provider: LlmProvider
): string {
  switch (provider) {
    case "claude":
      return buildClaudePrompt(snapshot, ideContext);
    case "gemini":
      return buildGeminiPrompt(snapshot, ideContext);
    case "grok":
      return buildGrokPrompt(snapshot, ideContext);
    case "chatgpt":
    case "custom":
    default:
      return buildMarkdownPrompt(snapshot, ideContext, provider);
  }
}

function buildClaudePrompt(snapshot: IDESnapshot, ideContext: string): string {
  return `<context_migration>
  <source>Visual Studio Code via ContextForge</source>
  <captured_at>${new Date(snapshot.capturedAt).toISOString()}</captured_at>
  <task>
    Continue helping with the current coding task using the IDE context below.
    If details are missing, say what you need next rather than guessing.
  </task>
  <current_codebase_state>
${indentBlock(ideContext, 4)}
  </current_codebase_state>
</context_migration>`;
}

function buildMarkdownPrompt(
  snapshot: IDESnapshot,
  ideContext: string,
  provider: LlmProvider
): string {
  const providerLabel =
    provider === "custom"
      ? "Custom LLM"
      : provider.charAt(0).toUpperCase() + provider.slice(1);

  return [
    "## ContextForge IDE Migration",
    "",
    `> Source: Visual Studio Code`,
    `> Target: ${providerLabel}`,
    `> Captured at: ${new Date(snapshot.capturedAt).toISOString()}`,
    "",
    "Use the IDE context below as the working state for this coding conversation.",
    "Continue from the current editor state, be explicit about assumptions, and ask for missing files only if needed.",
    "",
    "---",
    "",
    "## IDE Context",
    "",
    ideContext,
  ].join("\n");
}

function buildGrokPrompt(snapshot: IDESnapshot, ideContext: string): string {
  return buildMarkdownPrompt(snapshot, ideContext, "grok").replace(
    "## ContextForge IDE Migration",
    "## ContextForge IDE Import"
  );
}

function buildGeminiPrompt(snapshot: IDESnapshot, ideContext: string): string {
  return [
    "[CONTEXTFORGE IDE MIGRATION]",
    "Source: Visual Studio Code",
    `Captured at: ${new Date(snapshot.capturedAt).toISOString()}`,
    "",
    "[INSTRUCTIONS]",
    "Continue helping with the current coding task using the IDE state below.",
    "Call out assumptions when needed and prefer concrete next steps.",
    "",
    "[IDE CONTEXT]",
    ideContext,
  ].join("\n");
}

function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

function normalizeCustomUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}
