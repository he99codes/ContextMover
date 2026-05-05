// packages/browser-extension/src/content/perplexity.ts
import { extractMessageContent, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "@/lib/types";

console.log("[ContextForge] Perplexity content script loaded");

function isStreaming(el: HTMLElement): boolean {
  return (
    el.classList.contains("result-streaming") ||
    el.querySelector(".result-streaming") !== null ||
    el.closest("[data-is-streaming]") !== null ||
    el.closest("[class*='streaming']") !== null ||
    el.closest("[class*='loading']") !== null
  );
}

function scrapeMessages(): Message[] {
  type Entry = { el: HTMLElement; role: "user" | "assistant" };
  const collected: Entry[] = [];
  const hasAsst = () => collected.some((e) => e.role === "assistant");

  // ── Strategy A: data-message-role attribute ─────────────────────────────────
  {
    const els = [...document.querySelectorAll<HTMLElement>("[data-message-role]")]
      .filter((el) => !el.parentElement?.closest("[data-message-role]") && !isStreaming(el));
    for (const el of els) {
      const role = el.dataset.messageRole;
      if (role === "user" || role === "assistant") collected.push({ el, role });
    }
    console.log(`[ContextForge:perplexity] A data-message-role: ${collected.length}`);
  }

  // ── Strategy B: class substrings — UserMessage / AnswerText / answer-block ─
  if (!hasAsst()) {
    const userSel = '[class*="UserMessage"], [class*="user-query"], [class*="query-bubble"], [class*="user-message"]';
    const asstSel = '[class*="AnswerText"], [class*="answer-text"], [class*="model-answer"], [class*="assistant-message"], [class*="prose"][class*="answer"], .answer-block, [class*="answer-block"]';

    const userEls = [...document.querySelectorAll<HTMLElement>(userSel)]
      .filter((el) => !el.parentElement?.closest(userSel) && !isStreaming(el));
    const asstEls = [...document.querySelectorAll<HTMLElement>(asstSel)]
      .filter((el) => !el.parentElement?.closest(asstSel) && !isStreaming(el));

    for (const el of userEls) collected.push({ el, role: "user" });
    for (const el of asstEls) collected.push({ el, role: "assistant" });
    console.log(`[ContextForge:perplexity] B class-substr: user=${userEls.length} asst=${asstEls.length}`);
  }

  // ── Strategy C: Perplexity thread structure ──────────────────────────────────
  // Perplexity wraps conversations in [class*="thread"] — each child is one
  // user query + answer pair. We tag the first child as "user" and the rest as "assistant".
  if (!hasAsst()) {
    const threadSel = '[class*="thread-item"], [class*="ThreadItem"], [class*="conversation-turn"], [class*="ConversationTurn"]';
    const turns = [...document.querySelectorAll<HTMLElement>(threadSel)]
      .filter((el) => !el.parentElement?.closest(threadSel) && !isStreaming(el));
    for (const turn of turns) {
      const queryEl = turn.querySelector<HTMLElement>('[class*="query"], [class*="Query"], [class*="user"]');
      const answerEl = turn.querySelector<HTMLElement>('[class*="answer"], [class*="Answer"], [class*="markdown"], .prose, .answer-block, [class*="answer-block"]');
      if (queryEl && !isStreaming(queryEl)) collected.push({ el: queryEl, role: "user" });
      if (answerEl && !isStreaming(answerEl)) collected.push({ el: answerEl, role: "assistant" });
    }
    console.log(`[ContextForge:perplexity] C thread-items: ${turns.length} turns`);
  }

  // ── Strategy D: prose / markdown blocks with sibling heuristic ──────────────
  if (!hasAsst()) {
    const proseEls = [...document.querySelectorAll<HTMLElement>('.prose, [class*="markdown"], [class*="Markdown"], .answer-block, [class*="answer-block"]')]
      .filter((el) => !el.parentElement?.closest('.prose, [class*="markdown"], .answer-block, [class*="answer-block"]') && !isStreaming(el));
    for (const el of proseEls) {
      const text = (el.textContent ?? "").trim();
      if (text.length > 30) collected.push({ el, role: "assistant" });
    }
    console.log(`[ContextForge:perplexity] D prose/markdown: ${proseEls.length}`);
  }

  // ── Diagnostic if nothing found ─────────────────────────────────────────────
  if (collected.length === 0) {
    const classHits = new Map<string, number>();
    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      el.classList.forEach((c) => {
        if (/query|answer|message|thread|turn|user|assistant|perplexity|prose/i.test(c)) {
          classHits.set(c, (classHits.get(c) ?? 0) + 1);
        }
      });
    });
    const top = [...classHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    console.warn("[ContextForge:perplexity] NO messages found. Top candidate classes:", top);
    return [];
  }

  collected.sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  // [SECURITY] Strip Perplexity follow-up suggestions, related questions, and ads
  // before extracting text content, to prevent them being captured as message content.
  const PERPLEXITY_NOISE_SEL = [
    '[class*="related"]', '[class*="RelatedQuestions"]', '[class*="suggestion"]',
    '[class*="follow-up"]', '[class*="FollowUp"]', '[class*="followup"]',
    '[data-testid*="related"]', '[data-testid*="suggestion"]',
    '[class*="sponsored"]', '[class*="ad-"]', '[class*="promo"]',
  ].join(", ");

  const messages: Message[] = [];
  for (const { el, role } of collected) {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll<Element>(PERPLEXITY_NOISE_SEL).forEach((n) => n.remove());
    const content = extractMessageContent(clone);
    if (content) messages.push({ role, content, timestamp: Date.now() });
    else console.warn(`[ContextForge:perplexity] empty content for role=${role}`);
  }

  const u = messages.filter((m) => m.role === "user").length;
  const a = messages.filter((m) => m.role === "assistant").length;
  console.log('[CF:capture]', 'perplexity', {
    total: messages.length,
    user: u,
    assistant: a,
    preview: messages.map(m => ({ role: m.role, len: m.content.length }))
  });
  if (a === 0 && u > 0) console.error("[ContextForge:perplexity] ASSISTANT MESSAGES MISSING");

  return messages;
}

startSessionCapture({
  platform: "perplexity",
  selectorOrElement: "main",
  scrapeMessages,
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "perplexity") {
    void injectIntoPerplexityInput(msg.prompt).then(sendResponse);
    return true;
  }
});

async function injectIntoPerplexityInput(text: string) {
  const input = await waitForAnyElement<HTMLElement>([
    "textarea#ask",
    "textarea[placeholder*='Ask']",
    "textarea[placeholder*='ask']",
    "textarea[placeholder*='Search']",
    "textarea[placeholder*='search']",
    '[contenteditable="true"][role="textbox"]',
    ".ProseMirror[contenteditable='true']",
    "textarea:not([readonly])",
    '[contenteditable="true"]',
  ]);

  if (!input) return { ok: false, error: "Perplexity input not found. Make sure a conversation is open." };
  if (!setPromptInputValue(input, text)) return { ok: false, error: "Perplexity input did not accept the text." };
  return { ok: true };
}
