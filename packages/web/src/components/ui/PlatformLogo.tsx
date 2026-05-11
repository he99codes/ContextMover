import type { SVGProps } from "react";

type LogoSize = number | string;

interface LogoProps extends SVGProps<SVGSVGElement> {
  size?: LogoSize;
}

export function ClaudeLogo({ size = 16, ...props }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M14.0 3.5H10.0L4 20.5H7.8L9.2 16.5H14.8L16.2 20.5H20L14.0 3.5ZM10.2 13.5L12 8.2L13.8 13.5H10.2Z" fill="#D97706"/>
    </svg>
  );
}

export function ChatGPTLogo({ size = 16, ...props }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path fillRule="evenodd" clipRule="evenodd"
        d="M12 2.4C9.46 2.4 7.2 3.72 5.88 5.74A4.8 4.8 0 0 0 2.4 10.4c0 .86.22 1.68.6 2.4a4.8 4.8 0 0 0 .72 5.46A4.8 4.8 0 0 0 8.4 21.6c.62 0 1.22-.12 1.78-.32A4.8 4.8 0 0 0 14.4 22.4c2.54 0 4.8-1.32 6.12-3.34a4.8 4.8 0 0 0 3.48-4.66 4.8 4.8 0 0 0-.6-2.4 4.8 4.8 0 0 0-.72-5.46A4.8 4.8 0 0 0 18 2.4c-.62 0-1.22.12-1.78.32A4.8 4.8 0 0 0 12 2.4Zm0 1.6a3.2 3.2 0 0 1 2.9 1.86l-5.8 3.34V5.14A3.22 3.22 0 0 1 12 4Zm-4.8 2.86v6.68L4.8 12l2.4-5.14ZM12 20a3.2 3.2 0 0 1-2.9-1.86l5.8-3.34v4.06A3.22 3.22 0 0 1 12 20Zm4.8-2.86v-6.68L19.2 12l-2.4 5.14ZM9.2 7.34l5.6-3.24v3.5l-5.6 3.24V7.34Zm0 9.32 5.6 3.24v-3.5l-5.6-3.24v3.5Zm-1.6-.66-2.2-4.68 2.2-4.68v9.36Zm9.6 0 2.2-4.68-2.2-4.68v9.36Z"
        fill="#10B981"/>
    </svg>
  );
}

export function GeminiLogo({ size = 16, ...props }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <defs>
        <linearGradient id="gemini-grad" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#818CF8"/>
          <stop offset="100%" stopColor="#6366F1"/>
        </linearGradient>
      </defs>
      <path d="M12 2C11.1 5.5 8.5 8.1 5 9 8.5 9.9 11.1 12.5 12 16c.9-3.5 3.5-6.1 7-7-3.5-.9-6.1-3.5-7-7Z" fill="url(#gemini-grad)"/>
      <path d="M12 16c-.9 3.5-3.5 5.5-7 6 3.5.5 6.1 0 7-6Z" fill="#6366F1" opacity="0.6"/>
      <path d="M12 16c.9 3.5 3.5 5.5 7 6-3.5.5-6.1 0-7-6Z" fill="#818CF8" opacity="0.6"/>
    </svg>
  );
}

export function GrokLogo({ size = 16, ...props }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M4 4L11.3 12L4 20H7L12.7 13.7L18 20H21L13.4 11.7L20.5 4H17.5L12 10L7 4H4Z" fill="#E5E5E5"/>
    </svg>
  );
}

export function PerplexityLogo({ size = 16, ...props }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect x="3" y="3" width="18" height="18" rx="9" stroke="#20B2AA" strokeWidth="1.5" fill="none"/>
      <path d="M9 8h4.5a2.5 2.5 0 0 1 0 5H9V8Zm0 5h6M9 8v8" stroke="#20B2AA" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function DeepSeekLogo({ size = 16, ...props }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M6 4h6a8 8 0 0 1 0 16H6V4Z" fill="none" stroke="#4C8BF5" strokeWidth="1.5"/>
      <path d="M6 12h8" stroke="#4C8BF5" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

const LOGOS: Record<string, React.ComponentType<LogoProps>> = {
  claude:     ClaudeLogo,
  chatgpt:    ChatGPTLogo,
  gemini:     GeminiLogo,
  grok:       GrokLogo,
  perplexity: PerplexityLogo,
  deepseek:   DeepSeekLogo,
};

export const PLATFORM_FULL_NAMES: Record<string, string> = {
  claude:     "Claude",
  chatgpt:    "ChatGPT",
  gemini:     "Google Gemini",
  grok:       "xAI Grok",
  perplexity: "Perplexity",
  deepseek:   "DeepSeek",
};

export const PLATFORM_COLORS: Record<string, string> = {
  claude:     "#D97706",
  chatgpt:    "#10B981",
  gemini:     "#6366F1",
  grok:       "#E5E5E5",
  perplexity: "#20B2AA",
  deepseek:   "#4C8BF5",
};

interface PlatformLogoProps extends LogoProps {
  platform: string;
}

export function PlatformLogo({ platform, size = 16, ...props }: PlatformLogoProps) {
  const Logo = LOGOS[platform.toLowerCase()];
  if (!Logo) return null;
  return <Logo size={size} {...props} />;
}

interface PlatformBadgeProps {
  platform: string;
  logoSize?: number;
  className?: string;
}

export function PlatformBadge({ platform, logoSize = 12, className = "" }: PlatformBadgeProps) {
  const key   = platform.toLowerCase();
  const color = PLATFORM_COLORS[key] ?? "#6B6B6B";
  const name  = PLATFORM_FULL_NAMES[key] ?? platform;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[999px] border px-2 py-0.5 text-[11px] font-medium ${className}`}
      style={{
        color,
        borderColor: `${color}30`,
        background:  `${color}12`,
      }}
    >
      <PlatformLogo platform={key} size={logoSize} />
      {name}
    </span>
  );
}
