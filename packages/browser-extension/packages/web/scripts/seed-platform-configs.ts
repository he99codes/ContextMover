// packages/web/scripts/seed-platform-configs.ts
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Explicitly load the .env file from the packages/web directory
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const hardcodedSelectors = {
  chatgpt: {
    messageSelector: '[data-message-author-role]',
    contentSelector: '.markdown, .whitespace-pre-wrap',
    inputSelector: '#prompt-textarea',
  },
  gemini: {
    messageSelector: '.message',
    userSelector: '.user-message',
    assistantSelector: '.model-response-text',
    contentSelector: '.output-content',
    inputSelector: '.input-area',
  },
  claude: {
    messageSelector: '[data-testid^="conversation-turn-"]',
    contentSelector: '[data-is-response="true"]',
    inputSelector: '[contenteditable="true"][role="textbox"]',
  },
  grok: {
    messageSelector: '[data-testid="conversation-turn"]',
    contentSelector: 'div[dir="auto"]',
    inputSelector: '[data-testid="compose-text-input"]',
  },
  perplexity: {
    messageSelector: '[class*="conversation-turn"]',
    contentSelector: '[class*="prose"]',
    inputSelector: 'textarea[placeholder*="Ask anything"]',
  },
  deepseek: {
    messageSelector: '.chat-message-container',
    contentSelector: '.chat-message-content',
    inputSelector: 'textarea[placeholder*="DeepSeek"]',
  },
};

async function seed() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase environment variables are not set.');
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const dataToInsert = Object.entries(hardcodedSelectors).map(([platform_id, selectors]) => ({
    platform_id,
    selectors,
    is_enabled: true,
    updated_by: 'system-seed',
  }));

  const { error } = await supabase.from('platform_configs').upsert(dataToInsert, { onConflict: 'platform_id' });

  if (error) {
    console.error('Error seeding platform_configs:', error);
  } else {
    console.log('Successfully seeded platform_configs.');
  }
}

void seed();
