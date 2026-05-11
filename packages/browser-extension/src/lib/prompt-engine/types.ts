// packages/browser-extension/src/lib/prompt-engine/types.ts

export type PromptTemplateId = string;

export interface PromptTemplate {
  id: PromptTemplateId;
  userId: string;               // 'system' = built-in
  name: string;
  description: string;
  content: string;
  icon: string;
  tags: string[];
  targetPlatforms: ("claude" | "chatgpt" | "gemini" | "grok" | "all")[];
  isDefault: boolean;           // auto-apply to all migrations
  isSystem: boolean;            // built-in, cannot delete
  usageCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PromptAssignment {
  id: string;
  userId: string;
  templateId: PromptTemplateId;
  sessionId?: string;           // assign to specific session
  platform?: string;            // assign to all of this platform
  createdAt: number;
}

export interface PromptMergeResult {
  finalContext: string;         // context + prompt merged
  templateUsed: PromptTemplate;
  templateName: string;
  mergeStrategy: "prepend" | "append" | "wrap";
  stats: {
    templateLength: number;
    contextLength: number;
    totalLength: number;
    estimatedTokens: number;
  };
}
