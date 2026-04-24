export type Platform = "claude" | "chatgpt" | "gemini" | "grok";

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
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok",
};

export const PLATFORM_COLORS: Record<Platform, string> = {
  claude: "#D97706",
  chatgpt: "#10B981",
  gemini: "#6366F1",
  grok: "#1A1A1A",
};

export const PLATFORM_BG: Record<Platform, string> = {
  claude: "bg-amber-50 text-amber-700 border-amber-200",
  chatgpt: "bg-emerald-50 text-emerald-700 border-emerald-200",
  gemini: "bg-indigo-50 text-indigo-700 border-indigo-200",
  grok: "bg-gray-100 text-gray-700 border-gray-200",
};
