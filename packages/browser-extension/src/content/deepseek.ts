// packages/browser-extension/src/content/deepseek.ts
import { extractMessageContent, setPromptInputValue, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "@/lib/types";

console.log("[ContextForge] DeepSeek content script loaded");

function scrapeMessages(): Message[] {
  type Entry = { el: HTMLElement; role: "user" | "assistant" };
  const collected: Entry[] = [];
  const hasAsst = () => collected.some((e) => e.role === "assistant");

  // ── Strategy A: data-message-author-role (ChatGPT-compatible) ───────────────
  {
    const els = [...document.querySelectorAll<HTMLElement>("[data-message-author-role]")]
      .filter((el) => !el.parentElement?.closest("[data-message-author-role]"));
    for (const el of els) {
      const role = el.dataset.messageAuthorRole;
      if (role === "user" || role === "assistant") collected.push({ el, role });
    }
    console.log(`[ContextForge:deepseek] A data-author-role: ${collected.length}`);
  }

  // ── Strategy B: DeepSeek class patterns ─────────────────────────────────────
  if (!hasAsst()) {
    const userSel = '[class*="userMessage"], [class*="user-message"], [class*="human-message"], [class*="UserMessage"]';
    const asstSel = '[class*="ds-markdown"], [class*="markdown-content"], [class*="assistantMessage"], [class*="assistant-message"], [class*="AssistantMessage"], [class*="model-response"]';

    const userEls = [...document.querySelectorAll<HTMLElement>(userSel)]
      .filter((el) => !el.parentElement?.closest(userSel));
    const asstEls = [...document.querySelectorAll<HTMLElement>(asstSel)]
      .filter((el) => !el.parentElement?.closest(asstSel));

    for (const el of userEls) collected.push({ el, role: "user" });
    for (const el of asstEls) collected.push({ el, role: "assistant" });
    console.log(`[ContextForge:deepseek] B class-substr: user=${userEls.length} asst=${asstEls.length}`);
  }

  // ── Strategy C: data-role / role attributes ──────────────────────────────────
  if (!hasAsst()) {
    const els = [...document.querySelectorAll<HTMLElement>("[data-role], [role='listitem']")]
      .filter((el) => !el.parentElement?.closest("[data-role]"));
    for (const el of els) {
      const role = (el.dataset.role ?? "").toLowerCase();
      if (role === "user" || role === "human") collected.push({ el, role: "user" });
      else if (role === "assistant" || role === "ai" || role === "bot") collected.push({ el, role: "assistant" });
    }
    console.log(`[ContextForge:deepseek] C data-role: ${collected.length}`);
  }

  // ── Strategy D: Structural — chat message containers ────────────────────────
  // DeepSeek uses a classic chat layout with alternating bubbles.
  // Walk through [class*="message"] leaf containers; identify user vs assistant
  // by checking whether the child contains textarea/input (user) vs a markdown block.
  if (!hasAsst()) {
    const msgEls = [...document.querySelectorAll<HTMLElement>(
      '[class*="message"], [class*="chat-item"], [class*="turn"], [class*="bubble"]'
    )].filter((el) => !el.parentElement?.closest('[class*="message"], [class*="chat-item"], [class*="turn"], [class*="bubble"]'));

    for (const el of msgEls) {
      const text = (el.textContent ?? "").trim();
      if (text.length < 10) continue;
      const hasMarkdown = !!el.querySelector('[class*="markdown"], pre, code, .hljs');
      const cls = el.className.toLowerCase();
      if (/user|human|query/.test(cls)) {
        collected.push({ el, role: "user" });
      } else if (hasMarkdown || /assistant|ai|bot|model|response/.test(cls)) {
        collected.push({ el, role: "assistant" });
      }
    }
    console.log(`[ContextForge:deepseek] D structural: ${collected.length}`);
  }

  // ── Diagnostic ───────────────────────────────────────────────────────────────
  if (collected.length === 0) {
    const classHits = new Map<string, number>();
    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      el.classList.forEach((c) => {
        if (/message|chat|turn|bubble|user|assistant|human|ai|bot|markdown|deepseek/i.test(c)) {
          classHits.set(c, (classHits.get(c) ?? 0) + 1);
        }
      });
    });
    const top = [...classHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    console.warn("[ContextForge:deepseek] NO messages found. Top candidate classes:", top);
    return [];
  }

  collected.sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  const messages: Message[] = [];
  for (const { el, role } of collected) {
    const content = extractMessageContent(el);
    if (content) messages.push({ role, content, timestamp: Date.now() });
    else console.warn(`[ContextForge:deepseek] empty content for role=${role}`);
  }

  const u = messages.filter((m) => m.role === "user").length;
  const a = messages.filter((m) => m.role === "assistant").length;
  console.log(`[ContextForge:deepseek] FINAL: ${messages.length} msgs (user=${u} asst=${a})`);
  if (a === 0 && u > 0) console.error("[ContextForge:deepseek] ASSISTANT MESSAGES MISSING");

  return messages;
}

startSessionCapture({
  platform: "deepseek",
  selectorOrElement: "main",
  scrapeMessages,
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "deepseek") {
    void injectIntoDeepSeekInput(msg.prompt).then(sendResponse);
    return true;
  }
});

const DEEPSEEK_INJECT_SELECTORS = [
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="message"]',
  'textarea[placeholder*="Ask"]',
  '#chat-input',
  '[id*="chat-input"]',
  '[class*="chatInput"] textarea',
  '[class*="chat-input"] textarea',
  '[contenteditable="true"][role="textbox"]',
  ".ProseMirror[contenteditable='true']",
  "textarea:not([readonly])",
  '[contenteditable="true"]',
];

async function injectIntoDeepSeekInput(text: string) {
  let input: HTMLElement | null = null;
  let matchedSelector = "";

  for (const sel of DEEPSEEK_INJECT_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) { input = el; matchedSelector = sel; break; }
  }

  if (!input) {
    input = await waitForAnyElement<HTMLElement>(DEEPSEEK_INJECT_SELECTORS);
    matchedSelector = input
      ? DEEPSEEK_INJECT_SELECTORS.find((s) => document.querySelector(s) === input) ?? "(late)"
      : "";
  }

  if (!input) return { ok: false, error: "DeepSeek input not found. Make sure a chat is open." };

  console.log(`[ContextForge:deepseek] injecting via: ${matchedSelector}`);
  if (!setPromptInputValue(input, text)) return { ok: false, error: "DeepSeek input did not accept the text." };

  return { ok: true };
}
