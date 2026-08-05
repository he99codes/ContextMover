/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

export type Platform = "claude" | "chatgpt" | "gemini" | "grok" | "perplexity" | "deepseek";

export interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface Session {
  id: string;
  user_id: string;
  platform: Platform;
  title: string | null;
  messages: Message[];
  created_at: string;
  updated_at: string;
}

export interface Migration {
  id: string;
  user_id: string;
  session_id: string;
  source_platform: Platform;
  target_platform: Platform;
  migrated_at: string;
}

export interface CustomAgent {
  id: string;
  user_id: string;
  name: string;
  url: string;
  input_selector: string;
  message_selector: string;
  role_detection: string;
  output_format: "xml" | "markdown" | "plain";
  created_at: string;
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  claude:     "Claude",
  chatgpt:    "ChatGPT",
  gemini:     "Gemini",
  grok:       "Grok",
  perplexity: "Perplexity",
  deepseek:   "DeepSeek",
};

export const PLATFORM_COLORS: Record<Platform, string> = {
  // [CM-SOLAR] Warm metallic platform palette.
  claude:     "#00FF88",
  chatgpt:    "#00C853",
  gemini:     "#E5E5E5",
  grok:       "#E5E5E5",
  perplexity: "#00D26A",
  deepseek:   "#E5E5E5",
};

export const PLATFORM_BG: Record<Platform, string> = {
  // [CM-SOLAR] Platform badge backgrounds — warm grayscale.
  claude:     "bg-[#00FF88]/10 text-[#00FF88] border-[#00FF88]/30",
  chatgpt:    "bg-[#00C853]/10 text-[#00C853] border-[#00C853]/30",
  gemini:     "bg-[#E5E5E5]/10 text-[#E5E5E5] border-[#E5E5E5]/30",
  grok:       "bg-[#E5E5E5]/10 text-[#E5E5E5] border-[#E5E5E5]/30",
  perplexity: "bg-[#00D26A]/10 text-[#00D26A] border-[#00D26A]/30",
  deepseek:   "bg-[#E5E5E5]/10 text-[#E5E5E5] border-[#E5E5E5]/30",
};
