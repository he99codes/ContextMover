import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from the correct .env file
dotenv.config({ path: path.resolve(__dirname, '../packages/web/.env') });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Supabase environment variables are not set.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const newGeminiSelectors = {
  messageContainer: '[data-test-id="message-container"]',
  messageRole: '[data-test-id="message-role"]',
  messageContent: '[data-test-id="message-content"] .prose',
  input: 'rich-textarea [contenteditable="true"]',
  fileAttachButton: 'button[aria-label*="Upload" i]',
  fileInput: 'input[type="file"]',
};

async function updateGeminiConfig() {
  console.log('Attempting to update Gemini platform configuration...');

  const { data, error } = await supabase
    .from('platform_configs')
    .update({ 
      selectors: newGeminiSelectors,
      last_updated_at: new Date(),
      updated_by: 'system-script:fix-gemini'
    })
    .eq('platform_id', 'gemini');

  if (error) {
    console.error('Error updating Gemini config:', error.message);
  } else {
    console.log('✅ Successfully updated selectors for Gemini.');
  }
}

void updateGeminiConfig();
