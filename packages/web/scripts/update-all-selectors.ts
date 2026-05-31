import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from the correct .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Supabase environment variables are not set.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// This object contains the corrected selectors for all platforms.
const correctedConfigs = [
  {
    platform_id: 'chatgpt',
    selectors: {
      messageContainer: 'div[data-message-id]',
      messageRole: '[data-message-author-role]',
      messageContent: '.markdown',
      input: '#prompt-textarea',
      fileAttachButton: 'button[data-testid*="file-upload"]',
      fileInput: 'input[type="file"]',
    },
  },
  {
    platform_id: 'gemini',
    selectors: {
      messageContainer: '.message',
      messageRole: '.role',
      messageContent: '.content',
      input: '.input-area [contenteditable="true"]',
      fileAttachButton: '[aria-label*="Attach"]',
      fileInput: 'input[type="file"]',
    },
  },
  {
    platform_id: 'claude',
    selectors: {
      messageContainer: '[data-testid="conversation-turn"]',
      messageRole: '[data-testid*="message"]',
      messageContent: '[data-testid*="message"] .prose',
      input: '[contenteditable="true"][role="textbox"]',
      fileAttachButton: '[aria-label*="file"]',
      fileInput: 'input[type="file"]',
    },
  },
  {
    platform_id: 'perplexity',
    selectors: {
      messageContainer: '.thread-item',
      messageRole: '.query, .answer',
      messageContent: '.prose',
      input: '[contenteditable="true"][role="textbox"]',
      fileAttachButton: '[aria-label*="file"]',
      fileInput: 'input[type="file"]',
    },
  },
  {
    platform_id: 'grok',
    selectors: {
      messageContainer: '[data-testid*="turn"]',
      messageRole: '[data-testid*="human-turn"], [data-testid*="model-turn"]',
      messageContent: '[class*="-turn"] .whitespace-pre-wrap',
      input: '[contenteditable="true"][role="textbox"]',
      fileAttachButton: '[aria-label*="Attach"]',
      fileInput: 'input[type="file"]',
    },
  },
  {
    platform_id: 'deepseek',
    selectors: {
      messageContainer: '[class*="-message__content"]',
      messageRole: '[class*="message-role-user"], [class*="message-role-assistant"]',
      messageContent: '.prose',
      input: 'textarea:not([readonly])',
      fileAttachButton: 'button[class*="upload"]',
      fileInput: 'input[type="file"]',
    },
  },
];

async function updateConfigs() {
  console.log('Attempting to update all platform configurations...');

  for (const config of correctedConfigs) {
    const { data, error } = await supabase
      .from('platform_configs')
      .update({ 
        selectors: config.selectors,
        last_updated_at: new Date(),
        updated_by: 'system-script:update-all'
      })
      .eq('platform_id', config.platform_id);

    if (error) {
      console.error(`Error updating ${config.platform_id}:`, error.message);
    } else {
      console.log(`✅ Successfully updated selectors for ${config.platform_id}.`);
    }
  }

  console.log('\nConfiguration update complete.');
}

void updateConfigs();
