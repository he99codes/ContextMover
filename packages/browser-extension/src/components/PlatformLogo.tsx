/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import type { SVGProps } from "react";

type LogoSize = number | string;
interface LogoProps extends SVGProps<SVGSVGElement> { size?: LogoSize; }

export function ClaudeLogo({ size = 14, ...p }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M14 3.5H10L4 20.5H7.8L9.2 16.5H14.8L16.2 20.5H20L14 3.5ZM10.2 13.5L12 8.2L13.8 13.5H10.2Z" fill="currentColor"/>
    </svg>
  );
}

export function ChatGPTLogo({ size = 14, ...p }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      <path d="M9 9h3.5a2.5 2.5 0 0 1 0 5H9V9Zm0 5h5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

export function GeminiLogo({ size = 14, ...p }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M12 2C11 6 8 9 4 10c4 1 7 4 8 8 1-4 4-7 8-8-4-1-7-4-8-8Z" fill="currentColor"/>
    </svg>
  );
}

export function GrokLogo({ size = 14, ...p }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M4 4L11.3 12L4 20H7L12.7 13.7L18 20H21L13.4 11.7L20.5 4H17.5L12 10L7 4H4Z" fill="currentColor"/>
    </svg>
  );
}

export function PerplexityLogo({ size = 14, ...p }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="3" y="3" width="18" height="18" rx="9" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      <path d="M9 8h4a2.5 2.5 0 0 1 0 5H9V8Zm0 5h5M9 8v8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function DeepSeekLogo({ size = 14, ...p }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M6 4h5.5a8 8 0 0 1 0 16H6V4Z" stroke="currentColor" strokeWidth="1.5" fill="none"/>
      <path d="M6 12h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

const LOGOS: Record<string, React.ComponentType<LogoProps>> = {
  claude: ClaudeLogo, chatgpt: ChatGPTLogo, gemini: GeminiLogo,
  grok: GrokLogo, perplexity: PerplexityLogo, deepseek: DeepSeekLogo,
};

export const PLATFORM_FULL_NAMES: Record<string, string> = {
  claude: "Claude", chatgpt: "ChatGPT", gemini: "Google Gemini",
  grok: "xAI Grok", perplexity: "Perplexity", deepseek: "DeepSeek",
};

export const PLATFORM_COLORS: Record<string, string> = {
  // [CM-SOLAR] Warm metallic platform palette.
  claude:     "#00FF88",
  chatgpt:    "#00C853",
  gemini:     "#E5E5E5",
  grok:       "#E5E5E5",
  perplexity: "#00D26A",
  deepseek:   "#E5E5E5",
};

export function PlatformLogo({ platform, size = 14, ...p }: { platform: string } & LogoProps) {
  const Logo = LOGOS[platform.toLowerCase()];
  if (!Logo) return null;
  const color = PLATFORM_COLORS[platform.toLowerCase()] ?? "#6B6B6B";
  // [CM-SOLAR] Logo inherits its platform color.
  return (
    <span style={{ color, display: "inline-flex" }}>
      <Logo size={size} {...p} />
    </span>
  );
}

export function PlatformBadge({ platform, logoSize = 10 }: { platform: string; logoSize?: number }) {
  const key   = platform.toLowerCase();
  const color = PLATFORM_COLORS[key] ?? "#6B6B6B";
  const name  = PLATFORM_FULL_NAMES[key] ?? platform;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[999px] border px-1.5 py-0.5 text-[10px] font-medium"
      style={{ color, borderColor: `${color}30`, background: `${color}12` }}
    >
      <PlatformLogo platform={key} size={logoSize} />
      {name}
    </span>
  );
}
