// packages/browser-extension/src/content/claude.ts
import { extractMessageContent, injectWithRetry, runCapturePipeline, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "@/lib/types";

console.log("[ContextMover] Claude content script loaded");

// Selector cascade — try each selector in order, return first that yields results
function findElements(selectors: string[]): Element[] {
  for (const selector of selectors) {
    try {
      const els = document.querySelectorAll(selector);
      if (els.length > 0) {
        console.log(`[CM:claude] matched: ${selector} (${els.length})`);
        return Array.from(els);
      }
    } catch { /* invalid selector, continue */ }
  }
  return [];
}

const CLAUDE_SELECTORS = {
  user: [
    '[data-testid="user-message"]',
    '[data-testid="human-turn"]',
    '.human-turn',
    '[data-role="user"]',
    '[data-message-author-role="user"]',
  ],
  assistant: [
    '[data-testid="ai-turn"]',
    '[data-testid="assistant-message"]',
    '.font-claude-message',
    '[data-role="assistant"]',
    '[data-message-author-role="assistant"]',
    '.claude-message',
    '[data-is-streaming="false"] .prose',
  ],
  streaming: [
    '[data-is-streaming="true"]',
    '.streaming-indicator',
    '[data-loading="true"]',
  ],
};

function isStreaming(el: HTMLElement): boolean {
  return (
    el.hasAttribute("data-is-streaming") ||
    el.closest("[data-is-streaming]") !== null ||
    el.classList.contains("result-streaming") ||
    el.querySelector(".result-streaming") !== null
  );
}

function scrapeMessages(): Message[] {
  if (window.location.pathname === "/new") return [];

  // ── Diagnostics: dump testids so we know what Claude exposes ──────────────
  const allTestIds = new Set(
    [...document.querySelectorAll("[data-testid]")]
      .map((el) => (el as HTMLElement).dataset.testid ?? "")
      .filter(Boolean)
  );
  console.log(`[ContextMover:claude] testids on page:`, [...allTestIds].sort().join(", "));

  type Entry = { el: HTMLElement; role: "user" | "assistant" };
  const collected: Entry[] = [];
  const hasAsst = () => collected.some(e => e.role === "assistant");

  // ── Strategy 1: testid selectors (user-message / ai-turn) ─────────────────
  document.querySelectorAll<HTMLElement>('[data-testid="user-message"]').forEach((el) => {
    if (isStreaming(el)) return;
    if (!el.parentElement?.closest('[data-testid="user-message"]'))
      collected.push({ el, role: "user" });
  });
  document.querySelectorAll<HTMLElement>(
    '[data-testid="ai-turn"], [data-testid="assistant-message"]'
  ).forEach((el) => {
    if (isStreaming(el)) return;
    if (el.closest('[data-testid="user-message"]')) return;
    if (el.parentElement?.closest('[data-testid="ai-turn"], [data-testid="assistant-message"]')) return;
    collected.push({ el, role: "assistant" });
  });
  console.log(`[ContextMover:claude] S1 testid: user=${collected.filter(e=>e.role==="user").length} asst=${collected.filter(e=>e.role==="assistant").length}`);

  // ── Strategy 2: legacy testids (human-turn / ai-turn together) ────────────
  if (!hasAsst()) {
    document.querySelectorAll<HTMLElement>('[data-testid="human-turn"], [data-testid="ai-turn"]').forEach((el) => {
      if (isStreaming(el)) return;
      if (el.parentElement?.closest('[data-testid="human-turn"], [data-testid="ai-turn"]')) return;
      const role = el.dataset.testid === "human-turn" ? "user" : "assistant";
      if (role === "assistant") collected.push({ el, role });
    });
    console.log(`[ContextMover:claude] S2 legacy: asst=${collected.filter(e=>e.role==="assistant").length}`);
  }

  // ── Strategy 3: class-name fallback (.font-claude-message) ────────────────
  if (!hasAsst()) {
    document.querySelectorAll<HTMLElement>('[class*="font-claude-message"]').forEach((el) => {
      if (isStreaming(el)) return;
      if (!el.parentElement?.closest('[class*="font-claude-message"]'))
        collected.push({ el, role: "assistant" });
    });
    console.log(`[ContextMover:claude] S3 class: asst=${collected.filter(e=>e.role==="assistant").length}`);
  }

  // ── Strategy 5: sr-only h2 accessibility anchors ──────────────────────────
  if (!hasAsst()) {
    document.querySelectorAll<HTMLHeadingElement>('h2.sr-only, h3.sr-only').forEach((h) => {
      const text = (h.textContent ?? "").trim().toLowerCase();
      const isAssistantHeading =
        text.startsWith("claude said") ||
        text.startsWith("claude replied") ||
        text.startsWith("assistant said") ||
        /^claude[: ]/.test(text);
      if (!isAssistantHeading) return;
      const turn = (h.parentElement as HTMLElement | null) ?? h;
      if (isStreaming(turn)) return;
      if (collected.some((entry) => entry.el === turn)) return;
      collected.push({ el: turn, role: "assistant" });
    });
    console.log(`[ContextMover:claude] S5 sr-only: asst=${collected.filter(e=>e.role==="assistant").length}`);
  }

  // ── Strategy 6: render-root sibling walk ──────────────────────────────────
  if (!hasAsst()) {
    const renderRoot = document.querySelector<HTMLElement>("[data-test-render-count]");
    const turnsContainer =
      renderRoot?.querySelector<HTMLElement>(":scope > .contents") ?? renderRoot;
    if (turnsContainer) {
      const dedup = new Set(collected.map((e) => e.el));
      const turns = [...turnsContainer.children] as HTMLElement[];
      for (const turn of turns) {
        if (isStreaming(turn)) continue;
        if (dedup.has(turn)) continue;
        const isUserTurn =
          turn.querySelector('[data-user-message-bubble="true"]') ||
          turn.querySelector('[data-testid="user-message"]') ||
          turn.matches('[data-user-message-bubble="true"]') ||
          turn.matches('[data-testid="user-message"]');
        if (isUserTurn) continue;
        const text = (turn.textContent ?? "").trim();
        if (text.length < 20) continue;
        collected.push({ el: turn, role: "assistant" });
        dedup.add(turn);
      }
      console.log(`[ContextMover:claude] S6 render-root: asst=${collected.filter(e=>e.role==="assistant").length}`);
    }
  }

  // ── Strategy 7: action-bar-retry / action-bar-copy as assistant anchors ────
  if (!hasAsst()) {
    const dedup = new Set(collected.map((e) => e.el));
    let actionBars = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="action-bar-retry"]'),
    ];
    if (actionBars.length === 0) {
      actionBars = [
        ...document.querySelectorAll<HTMLElement>('[data-testid="action-bar-copy"]'),
      ].filter((el) => !el.closest('[data-testid="user-message"]'));
    }
    for (const bar of actionBars) {
      if (bar.closest('[data-testid="user-message"]')) continue;
      let cur: HTMLElement | null = bar.parentElement;
      while (cur && cur !== document.body) {
        if (cur.matches('[data-testid="user-message"]')) break;
        const parent = cur.parentElement;
        if (!parent) break;
        const hasSiblingUser = ([...parent.children] as HTMLElement[]).some(
          (s) =>
            s !== cur &&
            (s.matches('[data-testid="user-message"]') ||
              !!s.querySelector('[data-testid="user-message"]'))
        );
        if (hasSiblingUser) {
          if (!dedup.has(cur) && !isStreaming(cur)) {
            const text = (cur.textContent ?? "").trim();
            if (text.length > 20) {
              collected.push({ el: cur, role: "assistant" });
              dedup.add(cur);
            }
          }
          break;
        }
        cur = cur.parentElement;
      }
    }
    console.log(`[ContextMover:claude] S7 action-bar: asst=${collected.filter(e=>e.role==="assistant").length}`);
  }

  // ── Strategy 4: STRUCTURAL — no testid dependency ─────────────────────────
  if (!hasAsst() && collected.length > 0) {
    const firstUser = collected[0].el;
    let container: HTMLElement | null = null;
    let cur: HTMLElement | null = firstUser;
    const userCount = collected.filter((e) => e.role === "user").length;

    for (let depth = 0; depth < 15 && cur?.parentElement; depth++) {
      cur = cur.parentElement;
      if (cur.children.length >= userCount) {
        const children = [...cur.children] as HTMLElement[];
        const hasNonUser = children.some(
          (child) =>
            !child.matches('[data-testid="user-message"]') &&
            !child.querySelector('[data-testid="user-message"]') &&
            (child.textContent ?? "").trim().length > 20
        );
        if (hasNonUser) {
          container = cur;
          break;
        }
      }
    }

    if (container) {
      const dedup = new Set(collected.map((e) => e.el));
      const turns = [...container.children] as HTMLElement[];
      console.log(`[ContextMover:claude] S4 structural: container has ${turns.length} children, userAnchors=${userCount}`);
      for (const turn of turns) {
        if (isStreaming(turn)) continue;
        if (turn.querySelector('[data-testid="user-message"]')) continue;
        if (turn.matches('[data-testid="user-message"]')) continue;
        if (dedup.has(turn)) continue;
        const text = (turn.textContent ?? "").trim();
        if (text.length > 20) {
          collected.push({ el: turn, role: "assistant" });
          dedup.add(turn);
        }
      }
      console.log(`[ContextMover:claude] S4 structural: asst=${collected.filter(e=>e.role==="assistant").length}`);
    } else {
      console.warn(`[ContextMover:claude] S4 structural: could not find conversation container`);
    }
  }

  // ── Strategy 8: EXTREME FALLBACK — alternate by DOM position ──────────────
  // When ALL selectors fail but we have user messages, try alternating
  // user/assistant by position within the deepest common container.
  if (!hasAsst() && collected.filter(e => e.role === "user").length > 0) {
    console.warn(`[ContextMover:claude] ALL selectors failed — trying position-based structural detection`);
    const structural = detectByStructure();
    if (structural.length > 0 && structural.some(m => m.role === "assistant")) {
      console.log(`[ContextMover:claude] S8 position-based: recovered ${structural.length} messages (${structural.filter(m=>m.role==="assistant").length} assistant)`);
      return structural;
    }
  }

  if (collected.length === 0) return [];

  // Sort by DOM position
  collected.sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  // Extract content
  const messages: Message[] = [];
  for (const { el, role } of collected) {
    const content = extractMessageContent(el);
    if (content) {
      messages.push({ role, content, timestamp: Date.now() });
    } else {
      console.warn(`[ContextMover:claude] empty content for role=${role} testid=${el.dataset.testid ?? "none"}`);
    }
  }

  // ── Diagnostic: preview every message ──────────────────────────────────────
  const userC = messages.filter(m => m.role === "user").length;
  const asstC = messages.filter(m => m.role === "assistant").length;
  console.log('[CM:capture]', 'claude', {
    total: messages.length,
    user: userC,
    assistant: asstC,
    preview: messages.map(m => ({ role: m.role, len: m.content.length }))
  });
  if (asstC === 0 && userC > 0) {
    console.error(`[ContextMover:claude] ASSISTANT MESSAGES STILL MISSING after all strategies`);
  }

  return messages;
}

// ── Structural detection fallback ───────────────────────────────────────────
// When all selectors fail, find the chat container and alternate roles by DOM
// position: first substantial child = user, next = assistant, and so on.
function detectByStructure(): Message[] {
  const container = findChatContainer();
  if (!container) return [];

  const children = Array.from(container.children).filter(
    (el) => (el.textContent?.trim().length ?? 0) > 10
  );

  const messages: Message[] = [];
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as HTMLElement;
    if (isStreaming(el)) continue;
    const content = extractMessageContent(el);
    if (!content) continue;
    // Even indices = user, odd = assistant (typical chat layout)
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content,
      timestamp: Date.now(),
    });
  }

  return messages;
}

function findChatContainer(): Element | null {
  const selectors = [
    'main',
    '[role="main"]',
    '.conversation',
    '[class*="conversation"]',
    '[class*="messages"]',
    '[class*="chat"]',
    '[data-test-render-count]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.children.length > 2) return el;
  }
  return null;
}

startSessionCapture({
  platform: "claude",
  selectorOrElement: "main",
  scrapeMessages: () => runCapturePipeline("claude", scrapeMessages),
});

// Listen for injection requests from the service worker
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "claude") {
    injectIntoClaudeInput(msg.prompt)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // CRITICAL — keeps channel open for async response
  }
});

async function injectIntoClaudeInput(text: string) {
  const input = await waitForAnyElement<HTMLElement>([
    '.ProseMirror[contenteditable="true"]',       // Claude ProseMirror editor
    '[contenteditable="true"][data-placeholder]', // placeholder-based selector
    '[contenteditable="true"][role="textbox"]',
    'fieldset [contenteditable="true"]',          // Claude wraps input in fieldset
    'form [contenteditable="true"]',
    '[contenteditable="true"]',                   // last-resort
  ]);

  if (!input) return { ok: false, error: "Claude input box not found. Make sure a chat is open." };

  if (!await injectWithRetry(input, text, "claude")) {
    return { ok: false, error: "Claude input did not accept the text after 3 attempts. Context copied to clipboard — paste with Ctrl+V." };
  }

  return { ok: true };
}
