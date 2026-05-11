// src/lib/capture/selector-registry.ts
// Versioned cascade of selectors per platform.
// findElements() tries each in order — first non-empty match wins.

export const SELECTOR_REGISTRY = {
  claude: {
    version: "2026-05",
    user: [
      '[data-testid="user-message"]',
      '[data-testid="human-turn"]',
      '.human-turn',
      '[data-role="user"]',
      '[data-message-role="human"]',
      '.user-message-content',
    ],
    assistant: [
      '[data-testid="ai-turn"]',
      '[data-testid="assistant-message"]',
      '[class*="font-claude-message"]',
      '[data-role="assistant"]',
      '[data-message-role="ai"]',
      '.assistant-message-content',
    ],
    streaming: [
      '[data-is-streaming="true"]',
      '[data-is-streaming]',
      '.streaming-indicator',
      '.loading-message',
    ],
    codeBlock: [
      'pre code',
      '.code-block code',
      '[class*="language-"]',
    ],
  },
  chatgpt: {
    version: "2026-05",
    user: [
      '[data-message-author-role="user"]',
      '[data-role="user"]',
      '.user-message',
      '[class*="userMessage"]',
    ],
    assistant: [
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      '.assistant-message',
      '[class*="assistantMessage"]',
    ],
    streaming: [
      '.result-streaming',
      '[data-is-streaming]',
      '.loading-indicator',
    ],
    codeBlock: [
      'pre code',
      '.markdown pre code',
      '[class*="language-"]',
    ],
  },
  gemini: {
    version: "2026-05",
    user: [
      'user-query',
      '.user-query',
      '[data-role="user"]',
      '.query-content',
      '[class*="userQuery"]',
    ],
    assistant: [
      'model-response',
      '.model-response',
      '[data-role="model"]',
      '.response-content',
      '[class*="modelResponse"]',
    ],
    streaming: [
      '.loading-indicator',
      '[aria-busy="true"]',
      '.generating',
    ],
    codeBlock: [
      'pre code',
      '.code-container code',
      '[class*="language-"]',
    ],
  },
  grok: {
    version: "2026-05",
    user: [
      '[class*="UserMessage"]',
      '[data-role="user"]',
      '.user-message',
      '[class*="userMessage"]',
      '[class*="HumanMessage"]',
    ],
    assistant: [
      '[class*="AssistantMessage"]',
      '[data-role="assistant"]',
      '.assistant-message',
      '[class*="aiMessage"]',
      '[class*="BotMessage"]',
    ],
    streaming: [
      '[class*="streaming"]',
      '[class*="Generating"]',
      '[aria-busy="true"]',
    ],
    codeBlock: [
      'pre code',
      '[class*="codeBlock"] code',
      '[class*="language-"]',
    ],
  },
  // DeepSeek selectors v2 — updated for current DOM structure
  // Fallback to structural-detector if all selectors return 0 results
  deepseek: {
    version: "2026-05-v2",
    user: [
      '[class*="human-message"]',
      '[class*="user-message"]',
      '[data-role="user"]',
      '.fbb737a4',
      '[class*="question"]',
    ],
    assistant: [
      '[class*="assistant-message"]',
      '[class*="ds-markdown"]',
      '[data-role="assistant"]',
      '.f9bf7997',
      '[class*="markdown"]:not([class*="user"])',
    ],
    streaming: [
      '[class*="loading"]',
      '[class*="generating"]',
      '[aria-busy="true"]',
    ],
    codeBlock: [
      'pre code',
      '.ds-code-block pre',
      '[class*="code-block"] pre',
    ],
  },
  perplexity: {
    version: "2026-05",
    user: [
      '.my-question',
      '[data-role="user"]',
      '[class*="userQuery"]',
      '.query-text',
      'textarea#ask',
    ],
    assistant: [
      '.answer-block',
      '[data-role="assistant"]',
      '[class*="answerBlock"]',
      '.prose-answer',
      '[class*="Answer"]',
    ],
    streaming: [
      '[class*="loading"]',
      '[class*="generating"]',
      '[aria-busy="true"]',
    ],
    codeBlock: [
      'pre code',
      '.code-block code',
      '[class*="language-"]',
    ],
  },
} as const;

export type RegistryPlatform = keyof typeof SELECTOR_REGISTRY;
export type SelectorRole = "user" | "assistant" | "streaming" | "codeBlock";

export function findElements(
  platform: RegistryPlatform,
  role: SelectorRole
): NodeListOf<Element> | null {
  const selectors = SELECTOR_REGISTRY[platform][role] as readonly string[];
  for (const selector of selectors) {
    try {
      const els = document.querySelectorAll(selector);
      if (els.length > 0) {
        console.log(`[CF:registry] ${platform} ${role} matched: ${selector} (${els.length} elements)`);
        return els;
      }
    } catch {
      continue;
    }
  }
  console.warn(`[CF:registry] ${platform} ${role} — all selectors failed, falling back to structural`);
  return null;
}
