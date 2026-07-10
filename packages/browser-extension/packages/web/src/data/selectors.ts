/**
 * Single source of truth for remote selector + injection strategy config.
 * Edit this file to push hotfixes; the API route serves it with proper
 * cache-busting headers so extensions pick up changes within an hour.
 */

export const selectorsConfig = {
  version: "1.1.0",
  updatedAt: "2026-05-30",
  platforms: {
    claude: {
      userSelector: '[data-testid="human-turn"]',
      assistantSelector: '[data-testid="ai-turn"]',
      inputSelector: '.ProseMirror[contenteditable="true"]',
      messageScope: "main",
    },
    chatgpt: {
      messageSelector: '[data-message-author-role]',
      contentSelector: ".markdown, .whitespace-pre-wrap",
      inputSelector: "#prompt-textarea",
    },
    gemini: {
      userSelector: "user-query, user-chunk, [class*='user-query-container']",
      assistantSelector: "model-response, ms-chat-turn[type='model'], [class*='model-response-text'], response-element",
      inputSelector: "rich-textarea .ql-editor, rich-textarea [contenteditable]",
      observerTarget: "chat-window, main, [class*='chat-container']",
      captureMethod: "fetch_intercept",
    },
    grok: {
      userSelector: '[class*="usermessage"]',
      assistantSelector: '[class*="response-content-markdown"]',
      inputSelector: '[data-testid="chat-input"] [contenteditable="true"]',
    },
    perplexity: {
      messageSelector: "[data-message-role]",
      userSelector: '[class*="UserMessage"]',
      assistantSelector: '[class*="AnswerText"]',
      inputSelector: "textarea#ask",
    },
    deepseek: {
      messageSelector: "[data-message-author-role]",
      userSelector: '[class*="userMessage"]',
      assistantSelector: '[class*="ds-markdown"]',
      inputSelector: 'textarea[placeholder*="Message"]',
    },
  },
  injectionStrategies: {
    claude: { method: "contentScript" as const, inputSelector: '.ProseMirror[contenteditable="true"]' },
    chatgpt: { method: "contentScript" as const, inputSelector: "#prompt-textarea" },
    gemini: { method: "executeScript" as const, inputSelector: "rich-textarea .ql-editor" },
    grok: { method: "contentScript" as const, inputSelector: '[data-testid="chat-input"] [contenteditable="true"]' },
    perplexity: { method: "contentScript" as const, inputSelector: "textarea#ask" },
    deepseek: { method: "contentScript" as const, inputSelector: 'textarea[placeholder*="Message"]' },
  },
  forceUpdate: false,
  updateMessage: "",
  minVersion: "1.0.0",
};
