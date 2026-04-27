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
}
