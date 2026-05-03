// packages/browser-extension/src/lib/types.ts

export type Platform = "claude" | "chatgpt" | "gemini" | "grok" | "perplexity" | "deepseek";

export interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ContextSession {
  id: string;
  platform: Platform;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
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
}
