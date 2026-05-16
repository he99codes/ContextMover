// packages/browser-extension/src/lib/types.ts

export type Platform = "claude" | "chatgpt" | "gemini" | "grok" | "perplexity" | "deepseek";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  result?: string;
}

export interface Artifact {
  type: "code" | "document" | "image" | "file";
  title?: string;
  language?: string;
  content?: string;
  url?: string;
}

export interface RequestMetadata {
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  tools?: Array<{ name: string; description?: string }>;
  conversationId?: string;
  messageId?: string;
  // True once a network/fetch-intercept capture has saved this session.
  // Tells the sidebar that the capture is complete even when message count
  // is small (a real short conversation, not a virtual-scroll snapshot).
  authoritative?: boolean;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  artifacts?: Artifact[];
}

export interface ContextSession {
  id: string;
  platform: Platform;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  metadata?: RequestMetadata;
}

export interface MetaPrompt {
  sessionId: string;
  platform: Platform;
  tier: 1 | 2 | 3;
  prompt: string;
  compressionRatio: number;
  builtAt: number;
  messageCount: number;
}

export interface CodeBlock {
  language: string;
  path?: string;
  content: string;
  context?: string;
}

export interface ExtractedContext {
  primaryGoal: string;
  currentFocus: string;
  completed: string[];
  pending: string[];
  decisions: string;
  facts: string;
  codeBlocks: CodeBlock[];
  conversationTail: Message[];
  messageCount: number;
}

export interface MigrationPayload {
  summary: string;
  extracted?: ExtractedContext;
  ideContext?: string;
  targetPlatform: Platform;
  sourceSession: ContextSession;
  caveman?: boolean;
  task?: string;
  // Prompt Engine — null or omitted = skip template injection.
  promptTemplateId?: string | null;
  // Tier 1 | 2 | 3 summarizer branch used for this migration.
  tier?: 1 | 2 | 3;
  // Compression ratio reported by the summarizer (0–100).
  compressionRatio?: number;
  // Structured output from summarizeIntelligent() — present only for tier 2.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intelligentSummary?: any;
  // Populated by summarizeWithAttention(). Typed as unknown here to avoid a
  // circular import (attention-engine.ts already imports from this file).
  // Translator casts to AttentionMap via import type from attention-engine.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attentionMap?: any;
  // Pre-built project-file context block (XML/MD/plain, platform-formatted).
  // Built in the sidebar by FileContextBuilder and injected before conversation_tail.
  projectContext?: string | null;
  // Live session metadata captured from API requests
  metadata?: RequestMetadata;
}
