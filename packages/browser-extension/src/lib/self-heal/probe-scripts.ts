/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Proprietary and confidential.
 */

// src/lib/self-heal/probe-scripts.ts
// Generates platform-specific console probe scripts that users paste into DevTools.
// The script walks the DOM and returns a ranked JSON of selector candidates
// that can be pasted back into the Self-Heal Wizard (Step 1 output).

export type Platform =
  | "gemini"
  | "chatgpt"
  | "claude"
  | "grok"
  | "deepseek"
  | "perplexity";

export interface ProbeCandidate {
  selector: string;
  role: "user" | "assistant" | "root" | "input" | "unknown";
  count: number;
  sample: string;
  confidence: number; // 0-1
}

export interface ProbeResult {
  platform: string;
  url: string;
  timestamp: number;
  candidates: ProbeCandidate[];
  rawDump: string;
}

// ── Platform-specific hints for the probe script ────────────────────────────
const PLATFORM_HINTS: Record<
  Platform,
  { userHints: string[]; assistantHints: string[]; rootHints: string[]; inputHints: string[] }
> = {
  gemini: {
    userHints: ["user-query", "user-query-content", ".query-content", "[data-test-id*='user']"],
    assistantHints: ["model-response", "response-container", ".response-content", "[data-test-id*='response']"],
    rootHints: ["chat-window-content", "chat-window", "infinite-scroller", "[data-test-id*='chat-history']", "conversation-container"],
    inputHints: ["rich-textarea", ".ql-editor", "[contenteditable='true']", "textarea"],
  },
  chatgpt: {
    userHints: ["[data-message-author-role='user']", ".message--user", "[class*='user-message']"],
    assistantHints: ["[data-message-author-role='assistant']", ".message--assistant", "[class*='assistant-message']"],
    rootHints: ["[class*='conversation']", "[class*='chat-messages']", "main"],
    inputHints: ["#prompt-textarea", "textarea[placeholder*='Message']", "[contenteditable]"],
  },
  claude: {
    userHints: ["[data-testid='user-message']", "[data-testid='human-turn']", ".human-turn", "[class*='human']"],
    assistantHints: [".font-claude-response", "[data-testid='ai-turn']", ".ai-turn", "[class*='assistant']"],
    rootHints: ["[class*='conversation']", "[class*='chat-content']", "main"],
    inputHints: ["[contenteditable='true'][class*='ProseMirror']", "div[contenteditable]", "textarea"],
  },
  grok: {
    userHints: ["[data-testid='user-message']", "[class*='user-message']", "[data-role='user']"],
    assistantHints: ["[data-testid='assistant-message']", "[class*='message-bubble']", "[data-role='assistant']"],
    rootHints: ["main", "[class*='conversation']", "[class*='messages']"],
    inputHints: ["textarea", "[contenteditable]"],
  },
  deepseek: {
    userHints: ["[class*='ds-message']:not([class*='ds-assistant'])", "[class*='userMessage']", "[class*='user-message']", "[class*='human-message']", "[data-role='user']"],
    assistantHints: ["[class*='ds-assistant-message-main-content']", "[class*='ds-markdown']", "[class*='assistantMessage']", "[class*='assistant-message']", "[data-role='assistant']"],
    rootHints: ["[class*='chat-main']", "[class*='message-list']", "main"],
    inputHints: ["textarea", "[contenteditable]"],
  },
  perplexity: {
    userHints: ["[class*='group/query']", "[class*='query']", "[data-testid*='user']", "[data-testid*='user-query']", "[class*='UserMessage']"],
    assistantHints: ["[class*='prose']", "[class*='answer-text']", "[data-testid*='answer']", "[class*='answer-block']", "[class*='model-answer']"],
    rootHints: ["[class*='thread']", "[class*='conversation']", "main"],
    inputHints: ["textarea", "[contenteditable]"],
  },
};

/**
 * Returns a self-contained JS string that the user pastes into DevTools console.
 * The script scans the DOM and outputs a JSON ProbeResult — the user copies
 * that JSON and pastes it back into the wizard (Step 1 → Step 2).
 */
export function generateProbeScript(platform: Platform): string {
  const hints = PLATFORM_HINTS[platform];
  // Serialise hints arrays into JS literal arrays for embedding in script string
  const u = JSON.stringify(hints.userHints);
  const a = JSON.stringify(hints.assistantHints);
  const r = JSON.stringify(hints.rootHints);
  const inp = JSON.stringify(hints.inputHints);

  return `
// ContextMover Self-Heal Probe — ${platform}
// Paste this entire block into DevTools console, then copy the output JSON.
(function cmProbe() {
  const platform = ${JSON.stringify(platform)};
  const userHints = ${u};
  const assistantHints = ${a};
  const rootHints = ${r};
  const inputHints = ${inp};

  function sample(el) {
    try {
      return (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    } catch { return ''; }
  }

  function trySelectors(sels, role, minCount) {
    const results = [];
    for (const sel of sels) {
      try {
        const nodes = document.querySelectorAll(sel);
        if (nodes.length === 0) continue;
        const conf = nodes.length >= (minCount || 1) ? 0.9 : 0.5;
        results.push({
          selector: sel,
          role,
          count: nodes.length,
          sample: sample(nodes[0]),
          confidence: conf,
        });
      } catch (e) { /* invalid selector, skip */ }
    }
    return results;
  }

  // Also do a structural sweep — look for repeating siblings with text content
  function structuralSweep() {
    const results = [];
    const allEls = document.querySelectorAll('*');
    const tagCounts = {};
    for (const el of allEls) {
      const tag = el.tagName.toLowerCase();
      if (tag.includes('-')) { // custom elements
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
    for (const [tag, count] of Object.entries(tagCounts)) {
      if (count >= 2) {
        const els = document.querySelectorAll(tag);
        const hasMeaningfulText = Array.from(els).some(e => (e.textContent || '').trim().length > 30);
        if (hasMeaningfulText) {
          results.push({
            selector: tag,
            role: 'unknown',
            count,
            sample: sample(els[0]),
            confidence: 0.4,
          });
        }
      }
    }
    return results;
  }

  const candidates = [
    ...trySelectors(userHints, 'user', 1),
    ...trySelectors(assistantHints, 'assistant', 1),
    ...trySelectors(rootHints, 'root', 1),
    ...trySelectors(inputHints, 'input', 1),
    ...structuralSweep(),
  ];

  // Deduplicate by selector
  const seen = new Set();
  const unique = candidates.filter(c => {
    if (seen.has(c.selector)) return false;
    seen.add(c.selector);
    return true;
  });

  // Sort by confidence desc, then count desc
  unique.sort((a, b) => b.confidence - a.confidence || b.count - a.count);

  const result = {
    platform,
    url: location.href,
    timestamp: Date.now(),
    candidates: unique,
    rawDump: '',
  };

  const json = JSON.stringify(result, null, 2);
  console.log('%c✅ ContextMover Probe Result — copy everything below this line', 'color: #00FF88; font-weight: bold; font-size: 13px');
  console.log(json);
  console.log('%c⬆ Copy the JSON above and paste it into the ContextMover Self-Heal Wizard', 'color: #00FF88');
  return result;
})();
`.trim();
}
