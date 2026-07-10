-- Seed platform_configs with initial selector data from @/data/selectors.ts
INSERT INTO platform_configs (platform_id, is_enabled, selectors, last_updated_at, updated_by) VALUES
  ('claude', true, '{"userSelector":"[data-testid=\"human-turn\"]","assistantSelector":"[data-testid=\"ai-turn\"]","inputSelector":".ProseMirror[contenteditable=\"true\"]","messageScope":"main"}', NOW(), 'system'),
  ('chatgpt', true, '{"messageSelector":"[data-message-author-role]","contentSelector":".markdown, .whitespace-pre-wrap","inputSelector":"#prompt-textarea"}', NOW(), 'system'),
  ('gemini', true, '{"userSelector":"user-query, user-chunk, [class*=''user-query-container'']","assistantSelector":"model-response, ms-chat-turn[type=''model''], [class*=''model-response-text''], response-element","inputSelector":"rich-textarea .ql-editor, rich-textarea [contenteditable]","observerTarget":"chat-window, main, [class*=''chat-container'']","captureMethod":"fetch_intercept"}', NOW(), 'system'),
  ('grok', true, '{"userSelector":"[class*=\"usermessage\"]","assistantSelector":"[class*=\"response-content-markdown\"]","inputSelector":"[data-testid=\"chat-input\"] [contenteditable=\"true\"]"}', NOW(), 'system'),
  ('perplexity', true, '{"messageSelector":"[data-message-role]","userSelector":"[class*=\"UserMessage\"]","assistantSelector":"[class*=\"AnswerText\"]","inputSelector":"textarea#ask"}', NOW(), 'system'),
  ('deepseek', true, '{"messageSelector":"[data-message-author-role]","userSelector":"[class*=\"userMessage\"]","assistantSelector":"[class*=\"ds-markdown\"]","inputSelector":"textarea[placeholder*=\"Message\"]"}', NOW(), 'system')
ON CONFLICT (platform_id) DO UPDATE SET
  is_enabled = EXCLUDED.is_enabled,
  selectors = EXCLUDED.selectors,
  last_updated_at = EXCLUDED.last_updated_at,
  updated_by = EXCLUDED.updated_by;
