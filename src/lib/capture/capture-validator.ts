/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// src/lib/capture/capture-validator.ts
// Validates every capture before it reaches the service worker.
// validateCapture() runs on EVERY attempt — no exceptions.

import type { Message } from "@/lib/types";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    total: number;
    user: number;
    assistant: number;
    avgLength: number;
    hasCode: boolean;
    detectionMethod: "registry" | "structural" | "failed";
  };
}

export function validateCapture(
  messages: Message[],
  platform: string,
  detectionMethod: "registry" | "structural" | "failed" = "registry"
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Chunk 33: filter out empty/whitespace-only messages before validation.
  const filtered = messages.filter((m) => m.content.trim().length > 0);
  const filteredCount = messages.length - filtered.length;
  if (filteredCount > 0) {
    console.debug(`[CM:validate] ${platform}: filtered ${filteredCount} empty/whitespace-only messages`);
  }
  const msgs = filtered;

  if (msgs.length === 0) {
    if (messages.length === 0) {
      errors.push("No messages captured");
    } else {
      errors.push("No meaningful content captured — all messages were empty or whitespace-only");
    }
  }

  const assistantCount = msgs.filter((m) => m.role === "assistant").length;
  const userCount = msgs.filter((m) => m.role === "user").length;

  if (assistantCount === 0 && msgs.length > 0) {
    errors.push(`CRITICAL: 0 assistant messages — role detection broken on ${platform}`);
  }

  if (userCount === 0 && msgs.length > 0) {
    errors.push("CRITICAL: 0 user messages captured");
  }

  if (assistantCount < userCount * 0.7 && userCount > 1) {
    warnings.push(
      `Role imbalance: ${userCount} user, ${assistantCount} assistant — possible missed messages`
    );
  }

  const emptyMessages = msgs.filter((m) => m.content.trim().length < 5);
  if (emptyMessages.length > 0) {
    warnings.push(
      `${emptyMessages.length} messages have near-empty content — possible scraping issue`
    );
  }

  let consecutiveSameRole = 0;
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].role === msgs[i - 1].role) consecutiveSameRole++;
  }
  if (consecutiveSameRole > 3) {
    warnings.push(
      `${consecutiveSameRole} consecutive same-role messages — role detection may be off`
    );
  }

  const avgLength =
    msgs.length > 0
      ? msgs.reduce((sum, m) => sum + m.content.length, 0) / msgs.length
      : 0;

  const hasCode = msgs.some((m) => m.content.includes("```"));

  console.debug(`[CM:validate] ${platform}:`, {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: { total: msgs.length, user: userCount, assistant: assistantCount },
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      total: msgs.length,
      user: userCount,
      assistant: assistantCount,
      avgLength,
      hasCode,
      detectionMethod,
    },
  };
}
