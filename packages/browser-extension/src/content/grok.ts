// packages/browser-extension/src/content/grok.ts
import { extractMessageContent, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "@/lib/types";

console.log("[ContextForge] Grok content script loaded");

function scrapeMessages(): Message[] {
  type Entry = { el: HTMLElement; role: "user" | "assistant" };
  const collected: Entry[] = [];
  const hasAsst = () => collected.some(e => e.role === "assistant");
  const hasUser = () => collected.some(e => e.role === "user");

  // ── Strategy A: legacy UserMessage / AssistantMessage class suffixes ──────
  {
    const sel = '[class*="UserMessage"], [class*="AssistantMessage"]';
    const els = [...document.querySelectorAll<HTMLElement>(sel)]
      .filter(el => !el.parentElement?.closest(sel));
    for (const el of els) {
      const role = el.className.includes("User") ? "user" : "assistant";
      collected.push({ el, role });
    }
    console.log(`[ContextForge:grok] A legacy-class: ${els.length}`);
  }

  // ── Strategy B: data-message-author-role (ChatGPT-style) ──────────────────
  if (!hasAsst()) {
    const els = [...document.querySelectorAll<HTMLElement>("[data-message-author-role]")]
      .filter(el => !el.parentElement?.closest("[data-message-author-role]"));
    for (const el of els) {
      const role = el.dataset.messageAuthorRole;
      if (role === "user" || role === "assistant") collected.push({ el, role });
    }
    console.log(`[ContextForge:grok] B data-author: ${els.length}`);
  }

  // ── Strategy C: class substrings ("user-message", "bot-message", etc.) ────
  if (!hasAsst()) {
    const userSel = '[class*="user-message"], [class*="user-query"], [class*="user-bubble"], [class*="query-bubble"]';
    const asstSel = '[class*="bot-message"], [class*="assistant-message"], [class*="response-bubble"], [class*="model-response"], [class*="message-bubble"][class*="assistant"]';

    const userEls = [...document.querySelectorAll<HTMLElement>(userSel)]
      .filter(el => !el.parentElement?.closest(userSel));
    const asstEls = [...document.querySelectorAll<HTMLElement>(asstSel)]
      .filter(el => !el.parentElement?.closest(asstSel));

    for (const el of userEls) collected.push({ el, role: "user" });
    for (const el of asstEls) collected.push({ el, role: "assistant" });
    console.log(`[ContextForge:grok] C class-substr: user=${userEls.length} asst=${asstEls.length}`);
  }

  // ── Strategy D: generic bubble scan — pairs of siblings with classes that  ─
  //  look like "message" / "bubble" / "turn"                                   ─
  if (!hasAsst() && !hasUser()) {
    const candidates = [...document.querySelectorAll<HTMLElement>(
      '[class*="message"], [class*="bubble"], [class*="turn"], [class*="chat-item"]'
    )].filter(el => {
      // Must be a leaf-ish message container, not its inner wrappers
      return !el.parentElement?.closest('[class*="message"], [class*="bubble"], [class*="turn"], [class*="chat-item"]');
    });
    // Heuristic: alternate user/assistant by document order
    candidates.forEach((el, i) => {
      collected.push({ el, role: i % 2 === 0 ? "user" : "assistant" });
    });
    console.log(`[ContextForge:grok] D generic-bubble: ${candidates.length} (alternating roles)`);
  }

  // ── DOM diagnostic if nothing worked ──────────────────────────────────────
  if (collected.length === 0) {
    const main = document.querySelector("main") ?? document.body;
    const classHits = new Map<string, number>();
    const testidHits = new Set<string>();
    main.querySelectorAll<HTMLElement>("*").forEach(el => {
      if (el.dataset.testid) testidHits.add(el.dataset.testid);
      el.classList.forEach(c => {
        if (/message|bubble|turn|chat|query|response|prompt|author|user|bot|assistant/i.test(c)) {
          classHits.set(c, (classHits.get(c) ?? 0) + 1);
        }
      });
    });
    const topClasses = [...classHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    console.warn(`[ContextForge:grok] NO messages found. DOM diagnostic:`);
    console.warn(`[ContextForge:grok]   candidate classes (name × count):`, topClasses);
    console.warn(`[ContextForge:grok]   testids on page:`, [...testidHits].sort().join(", "));
    return [];
  }

  // Sort by DOM position
  collected.sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  const messages: Message[] = [];
  for (const { el, role } of collected) {
    const content = extractMessageContent(el);
    if (content) messages.push({ role, content, timestamp: Date.now() });
    else console.warn(`[ContextForge:grok] empty content for role=${role}`);
  }

  const userCount = messages.filter(m => m.role === "user").length;
  const asstCount = messages.filter(m => m.role === "assistant").length;
  console.log(`[ContextForge:grok] FINAL: ${messages.length} msgs (user=${userCount} asst=${asstCount})`);
  console.log(`[ContextForge:grok] preview:`, messages.map(m => ({ role: m.role, preview: m.content.slice(0, 60) })));
  if (asstCount === 0 && userCount > 0) {
    console.error(`[ContextForge:grok] ASSISTANT MESSAGES MISSING`);
  }

  return messages;
}

startSessionCapture({
  platform: "grok",
  selectorOrElement: "main",
  scrapeMessages,
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "grok") {
    void injectIntoGrokInput(msg.prompt).then(sendResponse);
    return true;
  }
});

async function injectIntoGrokInput(text: string) {
  const input = await waitForAnyElement<HTMLElement>([
    'textarea[placeholder*="Ask"]',              // Grok "Ask anything" placeholder
    'textarea[placeholder*="message"]',
    '[data-testid="composer-text-input"]',
    '[contenteditable="true"][role="textbox"]',
    '[class*="composer"] textarea',
    '[class*="input"] textarea',
    'form textarea',
    'textarea:not([readonly])',                  // broad textarea fallback
    '[contenteditable="true"]',                  // last-resort contenteditable
  ]);

  if (!input) return { ok: false, error: "Grok input box not found. Make sure a chat is open." };

  if (!setPromptInputValue(input, text)) {
    return { ok: false, error: "Grok input did not accept the text. Try reloading the tab." };
  }

  return { ok: true };
}
