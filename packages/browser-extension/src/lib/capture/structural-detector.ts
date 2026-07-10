/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// src/lib/capture/structural-detector.ts
// Last-resort structural detection when ALL named selectors fail.
// Never relies on class names or testids — only DOM structure, position,
// and content characteristics. Logs clearly when used.

import type { Message } from "@/lib/types";

export function detectByStructure(platform: string): Message[] {
  console.warn(`[CM:structural] ${platform}: attempting structural detection`);

  // [ISSUE-20] Debounce structural detection logs — only log once per 5s per platform
  const _lastStructuralLogTs: Record<string, number> = {};
  const _shouldLogStructural = (platform: string): boolean => {
    const now = Date.now();
    if (!_lastStructuralLogTs[platform] || now - _lastStructuralLogTs[platform] > 5000) {
      _lastStructuralLogTs[platform] = now;
      return true;
    }
    return false;
  };

  // ── Pre-flight quality guards ──────────────────────────────────────────────────
  // Abort if the page is still loading.
  if (document.querySelector('[aria-busy="true"], .loading, [data-loading]')) {
    console.warn(`[CM:structural] ${platform}: page is in a loading state, skipping`);
    return [];
  }

  // Require at least 4 direct/nested children with text content > 50 chars
  // so we don’t trigger on nav bars or empty shells.
  const chatRoot = findChatContainer();
  if (chatRoot) {
    // Cheap pre-check: if the root has < 4 direct children, querySelectorAll("*")
    // would scan thousands of Angular wrapper nodes for nothing. findChatContainer
    // already requires >2, so this catches 0-3 child shells that are nav/toolbar wrappers.
    if (chatRoot.children.length < 4) {
      if (_shouldLogStructural(platform)) console.debug(`[CM:structural] ${platform}: chat root has only ${chatRoot.children.length} direct children, skipping`);
      return [];
    }
    const substantialEls = Array.from(
      chatRoot.querySelectorAll<Element>("*")
    ).filter((el) => (el.textContent ?? "").trim().length > 50);
    if (substantialEls.length < 4) {
      if (_shouldLogStructural(platform)) console.debug(`[CM:structural] ${platform}: too few substantial elements (${substantialEls.length}), skipping`);
      return [];
    }
    // At least 2 must be longer than 150 chars (else it’s UI chrome, not messages).
    const longEls = substantialEls.filter((el) => (el.textContent ?? "").trim().length > 150);
    if (longEls.length < 2) {
      if (_shouldLogStructural(platform)) console.debug(`[CM:structural] ${platform}: too few long elements (${longEls.length}), skipping`);
      return [];
    }
  }

  // Strategy 1: Find alternating sibling containers inside the chat root.
  const candidates = findAlternatingContainers();
  if (candidates.length >= 2) {
    const result = assignRolesByPosition(candidates);
    if (result.length > 0) {
      console.log(`[CM:structural] ${platform}: strategy 1 (alternating) found ${result.length} messages`);
      return result;
    }
  }

  // Strategy 2: Visual alignment heuristic.
  // User messages tend to be right-biased; assistant fills full width.
  const byAlignment = detectByAlignment();
  if (byAlignment.length > 0) {
    console.log(`[CM:structural] ${platform}: strategy 2 (alignment) found ${byAlignment.length} messages`);
    return byAlignment;
  }

  // Strategy 3: Content characteristics.
  // Assistant: longer, contains markdown/code. User: shorter, question-like.
  const byContent = detectByContentCharacteristics();
  console.log(`[CM:structural] ${platform}: strategy 3 (content) found ${byContent.length} messages`);
  return byContent;
}

function findAlternatingContainers(): Element[] {
  const chatContainer = findChatContainer();
  if (!chatContainer) return [];
  return Array.from(chatContainer.children).filter(
    (el) => (el.textContent ?? "").trim().length > 10
  );
}

function findChatContainer(): Element | null {
  const containerSelectors = [
    "main",
    '[role="main"]',
    ".conversation",
    ".chat-container",
    ".messages",
    '[class*="conversation"]',
    '[class*="messages"]',
    '[class*="chat"]',
  ];
  for (const sel of containerSelectors) {
    try {
      const el = document.querySelector(sel);
      if (el && el.children.length > 2) return el;
    } catch {
      continue;
    }
  }
  return findDeepestRepeatingContainer();
}

function findDeepestRepeatingContainer(): Element | null {
  let best: Element | null = null;
  let bestCount = 0;
  document.querySelectorAll("div, main, section, article").forEach((el) => {
    if (el.children.length > bestCount && el.children.length < 500) {
      best = el;
      bestCount = el.children.length;
    }
  });
  return best;
}

function assignRolesByPosition(els: Element[]): Message[] {
  // In all chat UIs: index 0 = user, then alternates user/assistant.
  return els
    .map((el, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: extractCleanText(el),
      timestamp: Date.now() + i,
    }))
    .filter((m) => m.content.length > 5);
}

function detectByAlignment(): Message[] {
  const container = findChatContainer();
  if (!container) return [];
  const els = Array.from(container.children).filter(
    (el) => (el.textContent ?? "").trim().length > 10
  );
  const viewportCenter = window.innerWidth / 2;
  return els
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const elementCenter = rect.left + rect.width / 2;
      const role: "user" | "assistant" =
        elementCenter > viewportCenter * 1.1 ? "user" : "assistant";
      return { role, content: extractCleanText(el), timestamp: Date.now() };
    })
    .filter((m) => m.content.length > 5);
}

function detectByContentCharacteristics(): Message[] {
  const container = findChatContainer();
  if (!container) return [];
  const results: Message[] = [];
  Array.from(container.children).forEach((el) => {
    const text = extractCleanText(el);
    if (text.length < 10) return;
    const hasCode = el.querySelector("pre, code") !== null;
    const hasMarkdown = /^#{1,3}\s|\*\*[^*]|\n- /.test(text);
    const isLong = text.length > 200;
    const role: "user" | "assistant" =
      hasCode || hasMarkdown || isLong ? "assistant" : "user";
    results.push({ role, content: text, timestamp: Date.now() });
  });
  return results;
}

function extractCleanText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone
    .querySelectorAll(
      'button, [role="button"], svg, .copy-button, .feedback-buttons, ' +
      '.action-bar, [aria-label*="copy"], [aria-label*="like"], ' +
      '[aria-label*="dislike"], .tooltip, [role="tooltip"]'
    )
    .forEach((n) => n.remove());
  clone.querySelectorAll("pre code").forEach((code) => {
    const lang = code.className.match(/language-(\w+)/)?.[1] ?? "";
    const text = code.textContent ?? "";
    code.textContent = `\`\`\`${lang}\n${text}\n\`\`\``;
  });
  return (clone.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
