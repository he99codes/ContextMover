// packages/browser-extension/src/content/claude.ts
import { extractMessageContent, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "@/lib/types";

console.log("[ContextForge] Claude content script loaded");

function scrapeMessages(): Message[] {
  // ── Diagnostics: dump testids so we know what Claude exposes ──────────────
  const allTestIds = new Set(
    [...document.querySelectorAll("[data-testid]")]
      .map((el) => (el as HTMLElement).dataset.testid ?? "")
      .filter(Boolean)
  );
  console.log(`[ContextForge:claude] testids on page:`, [...allTestIds].sort().join(", "));

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
  console.log(`[ContextForge:claude] S1 testid: user=${collected.filter(e=>e.role==="user").length} asst=${collected.filter(e=>e.role==="assistant").length}`);

  // ── Strategy 2: legacy testids (human-turn / ai-turn together) ────────────
  if (!hasAsst()) {
    document.querySelectorAll<HTMLElement>('[data-testid="human-turn"], [data-testid="ai-turn"]').forEach((el) => {
      if (isStreaming(el)) return;
      if (el.parentElement?.closest('[data-testid="human-turn"], [data-testid="ai-turn"]')) return;
      const role = el.dataset.testid === "human-turn" ? "user" : "assistant";
      if (role === "assistant") collected.push({ el, role });
    });
    console.log(`[ContextForge:claude] S2 legacy: asst=${collected.filter(e=>e.role==="assistant").length}`);
  }

  // ── Strategy 3: class-name fallback (.font-claude-message) ────────────────
  if (!hasAsst()) {
    document.querySelectorAll<HTMLElement>('[class*="font-claude-message"]').forEach((el) => {
      if (isStreaming(el)) return;
      if (!el.parentElement?.closest('[class*="font-claude-message"]'))
        collected.push({ el, role: "assistant" });
    });
    console.log(`[ContextForge:claude] S3 class: asst=${collected.filter(e=>e.role==="assistant").length}`);
  }

  // ── Strategy 4: STRUCTURAL — no testid dependency ─────────────────────────
  // Uses the KNOWN-WORKING [data-testid="user-message"] as anchor.
  // Walks UP from the first user element to find the conversation container
  // (= an ancestor whose children include at least N turns), then tags
  // every child that does NOT contain a user-message as an assistant turn.
  if (!hasAsst() && collected.length > 0) {
    const firstUser = collected[0].el;
    let container: HTMLElement | null = null;
    let cur: HTMLElement | null = firstUser;
    const userCount = collected.filter(e => e.role === "user").length;

    // Walk up. The conversation container has at least userCount children.
    for (let depth = 0; depth < 15 && cur?.parentElement; depth++) {
      cur = cur.parentElement;
      if (cur.children.length >= userCount) {
        container = cur;
        break;
      }
    }

    if (container) {
      const dedup = new Set(collected.map(e => e.el));
      const turns = [...container.children] as HTMLElement[];
      console.log(`[ContextForge:claude] S4 structural: container has ${turns.length} children, userAnchors=${userCount}`);

      for (const turn of turns) {
        if (isStreaming(turn)) continue;
        if (turn.querySelector('[data-testid="user-message"]')) continue; // user turn
        if (dedup.has(turn)) continue;
        // Must have substantial text to be a real message
        const text = (turn.textContent ?? "").trim();
        if (text.length > 20) {
          collected.push({ el: turn, role: "assistant" });
          dedup.add(turn);
        }
      }
      console.log(`[ContextForge:claude] S4 structural: asst=${collected.filter(e=>e.role==="assistant").length}`);
    } else {
      console.warn(`[ContextForge:claude] S4 structural: could not find conversation container`);
    }
  }

  if (collected.length === 0) {
    console.warn(`[ContextForge:claude] NO messages found at all`);
    return [];
  }

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
      console.warn(`[ContextForge:claude] empty content for role=${role} testid=${el.dataset.testid ?? "none"}`);
    }
  }

  // ── Diagnostic: preview every message ──────────────────────────────────────
  const userC = messages.filter(m => m.role === "user").length;
  const asstC = messages.filter(m => m.role === "assistant").length;
  console.log(`[ContextForge:claude] FINAL: ${messages.length} msgs (user=${userC} asst=${asstC})`);
  console.log(
    `[ContextForge:claude] preview:`,
    messages.map(m => ({ role: m.role, preview: m.content.slice(0, 60) }))
  );
  if (asstC === 0 && userC > 0) {
    console.error(`[ContextForge:claude] ASSISTANT MESSAGES STILL MISSING after all 4 strategies`);
  }

  return messages;
}

function isStreaming(el: HTMLElement): boolean {
  return (
    el.hasAttribute("data-is-streaming") ||
    el.closest("[data-is-streaming]") !== null
  );
}

startSessionCapture({
  platform: "claude",
  selectorOrElement: "main",
  scrapeMessages,
});

// Listen for injection requests from the service worker
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "claude") {
    void injectIntoClaudeInput(msg.prompt).then(sendResponse);
    return true;
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

  if (!setPromptInputValue(input, text)) {
    return { ok: false, error: "Claude input did not accept the text. Try reloading the tab." };
  }

  return { ok: true };
}
