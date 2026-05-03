// packages/browser-extension/src/content/claude.ts
import { extractMessageContent, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "@/lib/types";

console.log("[ContextForge] Claude content script loaded");

function scrapeMessages(): Message[] {
  if (window.location.pathname === "/new") return [];

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

  // ── Strategy 5: sr-only h2 accessibility anchors ──────────────────────────
  // Claude renders <h2 class="sr-only">You said: ...</h2> for user turns and
  // a sibling <h2 class="sr-only">Claude said: ...</h2> (or "Claude replied:")
  // for assistant turns. These are stable since they're a11y-driven.
  if (!hasAsst()) {
    document.querySelectorAll<HTMLHeadingElement>('h2.sr-only, h3.sr-only').forEach((h) => {
      const text = (h.textContent ?? "").trim().toLowerCase();
      const isAssistantHeading =
        text.startsWith("claude said") ||
        text.startsWith("claude replied") ||
        text.startsWith("assistant said") ||
        /^claude[: ]/.test(text);
      if (!isAssistantHeading) return;
      // The parent div is the assistant turn wrapper.
      const turn = (h.parentElement as HTMLElement | null) ?? h;
      if (isStreaming(turn)) return;
      if (collected.some((entry) => entry.el === turn)) return;
      collected.push({ el: turn, role: "assistant" });
    });
    console.log(`[ContextForge:claude] S5 sr-only: asst=${collected.filter(e=>e.role==="assistant").length}`);
  }

  // ── Strategy 6: render-root sibling walk ──────────────────────────────────
  // Use [data-test-render-count] as a stable conversation root anchor.
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
      console.log(`[ContextForge:claude] S6 render-root: asst=${collected.filter(e=>e.role==="assistant").length}`);
    } else {
      console.log(`[ContextForge:claude] S6 render-root: no [data-test-render-count] found`);
    }
  }

  // ── Strategy 7: action-bar-retry / action-bar-copy as assistant anchors ────
  // Claude removed ai-turn/assistant-message testids but action-bar-retry and
  // action-bar-copy are ONLY rendered inside assistant turns. Walk UP from each
  // action bar until we find a container whose sibling is a user turn — that
  // container IS the assistant turn, regardless of its own classes/testids.
  if (!hasAsst()) {
    const dedup = new Set(collected.map((e) => e.el));

    // Prefer action-bar-retry (retry is unique to assistant); fallback to copy
    let actionBars = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="action-bar-retry"]'),
    ];
    if (actionBars.length === 0) {
      actionBars = [
        ...document.querySelectorAll<HTMLElement>('[data-testid="action-bar-copy"]'),
      ].filter((el) => !el.closest('[data-testid="user-message"]'));
    }

    for (const bar of actionBars) {
      // Guard: never enter user-message territory
      if (bar.closest('[data-testid="user-message"]')) continue;

      let cur: HTMLElement | null = bar.parentElement;
      while (cur && cur !== document.body) {
        if (cur.matches('[data-testid="user-message"]')) break;

        const parent = cur.parentElement;
        if (!parent) break;

        // Check if any sibling (not cur itself) contains a user-message — that
        // means `cur` is a peer turn in the conversation container.
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
          break; // found the right level — stop walking up for this bar
        }

        cur = cur.parentElement;
      }
    }
    console.log(`[ContextForge:claude] S7 action-bar: asst=${collected.filter(e=>e.role==="assistant").length}`);
  }

  // ── Strategy 4: STRUCTURAL — no testid dependency ─────────────────────────
  // Fixed: only stop at a container that actually has non-user children.
  // Previously it stopped at the user-messages wrapper (children == userCount,
  // all user), skipping the real conversation root one level higher.
  if (!hasAsst() && collected.length > 0) {
    const firstUser = collected[0].el;
    let container: HTMLElement | null = null;
    let cur: HTMLElement | null = firstUser;
    const userCount = collected.filter((e) => e.role === "user").length;

    for (let depth = 0; depth < 15 && cur?.parentElement; depth++) {
      cur = cur.parentElement;
      if (cur.children.length >= userCount) {
        const children = [...cur.children] as HTMLElement[];
        // Only use this level if at least one child is NOT a user turn
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
      console.log(`[ContextForge:claude] S4 structural: container has ${turns.length} children, userAnchors=${userCount}`);

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
      console.log(`[ContextForge:claude] S4 structural: asst=${collected.filter(e=>e.role==="assistant").length}`);
    } else {
      console.warn(`[ContextForge:claude] S4 structural: could not find conversation container`);
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
