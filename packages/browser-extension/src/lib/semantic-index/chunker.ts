// packages/browser-extension/src/lib/semantic-index/chunker.ts
//
// Split messages into clean ~200-token chunks for embedding.
// Code blocks are atomic — never split, never cleaned (preserves syntax).
// Prose is stripped of markdown noise + filler before chunking.

import type { Message } from "../types";

const TARGET_CHUNK_TOKENS = 200;   // ~800 chars
// (CHUNK_OVERLAP_TOKENS reserved for future continuity-overlap logic)

const STRIP_PATTERNS: RegExp[] = [
  // Pure acknowledgements at line start
  /^(sure|great|of course|absolutely|certainly|ok|okay)[!.,]?\s*/im,
  // Filler openers
  /^(i understand|i see|i'll help|let me|i can help)[^.!?]*[.!?]\s*/im,
  // Markdown UI noise
  /^#{1,6}\s+/gm,              // headers
  /\*{1,2}([^*]+)\*{1,2}/g,    // bold/italic markers
  /_{1,2}([^_]+)_{1,2}/g,      // underscore bold/italic
  /^\s*[-*+]\s+/gm,            // bullet prefix
  /^\s*\d+\.\s+/gm,            // numbered list prefix
  // Repeated whitespace
  /\n{3,}/g,
  /[ \t]{2,}/g,
];

export interface Chunk {
  text: string;
  role: "user" | "assistant";
  messageIndex: number;
  hasCode: boolean;
  language?: string;
  tokenCount: number;
  isCodeChunk: boolean;
}

export function chunkMessages(messages: Message[]): Chunk[] {
  const chunks: Chunk[] = [];

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (!msg || !msg.content) continue;

    const parts = splitByCodeBlocks(msg.content);

    for (const part of parts) {
      if (part.isCode) {
        // Code block = one atomic chunk. Never clean. Never split.
        if (!part.text.trim()) continue;
        chunks.push({
          text: part.text,
          role: msg.role,
          messageIndex: msgIdx,
          hasCode: true,
          language: part.language,
          tokenCount: estimateTokens(part.text),
          isCodeChunk: true,
        });
        continue;
      }

      const cleaned = cleanText(part.text);
      if (!cleaned || cleaned.length < 20) continue;

      const proseChunks = splitProse(cleaned, TARGET_CHUNK_TOKENS);
      for (const prose of proseChunks) {
        if (prose.trim().length < 20) continue;
        chunks.push({
          text: prose,
          role: msg.role,
          messageIndex: msgIdx,
          hasCode: false,
          tokenCount: estimateTokens(prose),
          isCodeChunk: false,
        });
      }
    }
  }

  return chunks;
}

function cleanText(text: string): string {
  let cleaned = text;
  for (const pattern of STRIP_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }
  return cleaned.trim();
}

function splitByCodeBlocks(content: string): Array<{
  text: string;
  isCode: boolean;
  language?: string;
}> {
  const parts: Array<{ text: string; isCode: boolean; language?: string }> = [];
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        text: content.slice(lastIndex, match.index),
        isCode: false,
      });
    }
    parts.push({
      text: match[2],
      isCode: true,
      language: match[1] || undefined,
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({ text: content.slice(lastIndex), isCode: false });
  }
  return parts;
}

function splitProse(text: string, targetTokens: number): string[] {
  const targetChars = targetTokens * 4;
  if (text.length <= targetChars) return [text];

  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = "";

  for (const sentence of sentences) {
    if ((current + sentence).length > targetChars && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += (current ? " " : "") + sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
