/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/content/deepseek.ts
import { extractMessageContent, injectWithRetry, runCapturePipeline, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "@/lib/types";
import { getPlatformSelectors, type PlatformSelectors } from "@/lib/remote-config";

console.log("[ContextMover] DeepSeek content script loaded");

// Pre-warm remote selector config at load time.
let _remoteSelectors: PlatformSelectors | null = null;
getPlatformSelectors("deepseek").then((s) => { _remoteSelectors = s; }).catch(() => {});

// Returns true when the element's text content ends with sentence-final punctuation,
// which reliably signals that generation is complete even when the streaming class
// hasn't been removed from its ancestor yet (DOM-commitment lag).
function hasTerminalPunctuation(el: HTMLElement): boolean {
  const text = (el.textContent ?? '').replace(/\s+$/, '')
  if (!text) return false
  const last = text.slice(-1)
  // ASCII + common Unicode terminal punctuation; backtick closes a code fence.
  return '.!?…`。！？'.includes(last)
}

function isStreaming(el: HTMLElement): boolean {
  const hasStreamingMarker = (
    el.classList.contains("result-streaming") ||
    el.querySelector(".result-streaming") !== null ||
    el.closest("[data-is-streaming]") !== null ||
    el.closest("[class*='streaming']") !== null ||
    el.closest("[class*='loading']") !== null
  )
  if (!hasStreamingMarker) return false
  // Escape hatch: if content already ends with terminal punctuation the response
  // is complete — include the message even if the loading/streaming class on its
  // ancestor hasn't been cleared yet (observed on DeepSeek's last assistant turn).
  return !hasTerminalPunctuation(el)
}

function scrapeMessages(): Message[] {
  type Entry = { el: HTMLElement; role: "user" | "assistant" };
  const collected: Entry[] = [];
  const hasUser = () => collected.some((e) => e.role === "user");
  const hasAsst = () => collected.some((e) => e.role === "assistant");
  let matchedStrategy = 'none';

  // ── Strategy A: data-message-author-role (remote messageSelector overrides) ──
  {
    const msgSel = _remoteSelectors?.messageSelector ?? "[data-message-author-role]";
    const els = [...document.querySelectorAll<HTMLElement>(msgSel)]
      .filter((el) => !el.parentElement?.closest(msgSel) && !isStreaming(el));
    for (const el of els) {
      const role = el.dataset.messageAuthorRole;
      if (role === "user" || role === "assistant") collected.push({ el, role });
    }
    console.log(`[ContextMover:deepseek] A data-author-role: ${collected.length}`);
    if (collected.length > 0) matchedStrategy = 'A';
  }

  // ── Strategy B: DeepSeek class patterns ─────────────────────────────────────
  if (!hasAsst()) {
    // DeepSeek 2026 uses ds-message / ds-markdown / ds-assistant-message-main-content.
    const userSel = _remoteSelectors?.userSelector ?? '[class*="ds-message"]:not([class*="ds-assistant"]), [data-testid*="user"], [data-testid*="human"], [aria-label*="your message" i], [class*="userMessage"], [class*="user-message"], [class*="human-message"], [class*="UserMessage"], [class*="human_turn"], [class*="user_turn"], [data-type="user"], [data-role="user"]';
    const asstSel = _remoteSelectors?.assistantSelector ?? '[class*="ds-assistant-message-main-content"], [class*="ds-markdown"], [data-testid*="assistant"], [data-testid*="answer"], [aria-label*="DeepSeek" i], [class*="markdown-content"], [class*="assistantMessage"], [class*="assistant-message"], [class*="AssistantMessage"], [class*="model-response"]';

    const userEls = [...document.querySelectorAll<HTMLElement>(userSel)]
      .filter((el) => !el.parentElement?.closest(userSel) && !isStreaming(el));
    const asstEls = [...document.querySelectorAll<HTMLElement>(asstSel)]
      .filter((el) => !el.parentElement?.closest(asstSel) && !isStreaming(el));

    // Filter: ds-message elements that contain assistant markers are NOT user messages
    const userFiltered = userEls.filter(el => !el.querySelector('[class*="ds-markdown"], [class*="ds-assistant-message-main-content"]'));
    for (const el of userFiltered) collected.push({ el, role: "user" });
    for (const el of asstEls) collected.push({ el, role: "assistant" });
    console.log(`[ContextMover:deepseek] B class-substr: user=${userFiltered.length} asst=${asstEls.length}`);
    if (userFiltered.length + asstEls.length > 0) matchedStrategy = 'B';
  }

  // ── Strategy C: data-role / role attributes ──────────────────────────────────
  // Run if user messages still missing — even when assistant was found in Strategy B.
  if (!hasUser()) {
    const prevC = collected.length;
    const els = [...document.querySelectorAll<HTMLElement>("[data-role], [role='listitem']")]
      .filter((el) => !el.parentElement?.closest("[data-role]") && !isStreaming(el));
    for (const el of els) {
      const role = (el.dataset.role ?? "").toLowerCase();
      if (role === "user" || role === "human") collected.push({ el, role: "user" });
      else if (role === "assistant" || role === "ai" || role === "bot") collected.push({ el, role: "assistant" });
    }
    console.log(`[ContextMover:deepseek] C data-role: ${collected.length}`);
    if (collected.length > prevC && matchedStrategy === 'none') matchedStrategy = 'C';
  }

  // ── Strategy D: Structural — chat message containers ────────────────────────
  // DeepSeek uses a classic chat layout with alternating bubbles.
  // Walk through [class*="message"] leaf containers; identify user vs assistant
  // by checking whether the child contains textarea/input (user) vs a markdown block.
  if (!hasUser()) {
    const msgEls = [...document.querySelectorAll<HTMLElement>(
      '[class*="message"], [class*="chat-item"], [class*="turn"], [class*="bubble"], [role="listitem"], [data-testid*="message"]'
    )].filter((el) => !el.parentElement?.closest('[class*="message"], [class*="chat-item"], [class*="turn"], [class*="bubble"], [role="listitem"]') && !isStreaming(el));

    for (const el of msgEls) {
      const text = (el.textContent ?? "").trim();
      if (text.length < 10) continue;
      const hasMarkdown = !!el.querySelector('[class*="markdown"], pre, code, .hljs');
      const cls = el.className.toLowerCase();
      if (/user|human|query/.test(cls)) {
        collected.push({ el, role: "user" });
      } else if (!hasAsst() && (hasMarkdown || /assistant|ai|bot|model|response/.test(cls))) {
        // Only add assistant from structural scan if Strategy B didn't already find them.
        collected.push({ el, role: "assistant" });
      }
    }
    console.log(`[ContextMover:deepseek] D structural: ${collected.length}`);
    if (matchedStrategy === 'none' && collected.length > 0) matchedStrategy = 'D';
  }

  // ── Diagnostic ─────────────────────────────────────────────────────
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
    console.warn("[ContextMover:deepseek] NO messages found. Top candidate classes:", top);
    return [];
  }

  // ── DOM inspection when user=0 but asst>0 ──────────────────────────
  if (!hasUser() && hasAsst()) {
    const classHits = new Map<string, number>();
    const attrHits: string[] = [];
    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      if (!el.offsetParent && el.tagName !== "BODY") return;
      el.classList.forEach((c) => {
        if (/user|human|query|question|prompt/i.test(c))
          classHits.set(c, (classHits.get(c) ?? 0) + 1);
      });
      const dr = el.dataset?.role ?? "";
      if (dr && !attrHits.includes('data-role='+dr)) attrHits.push('data-role='+dr);
      const dt = el.dataset?.type ?? "";
      if (dt && /user|human/i.test(dt) && !attrHits.includes('data-type='+dt)) attrHits.push('data-type='+dt);
      const ma = el.getAttribute("data-message-author-role") ?? "";
      if (ma && !attrHits.includes('author-role='+ma)) attrHits.push('author-role='+ma);
    });
    console.warn(
      '[CM:diag:deepseek] user=0 — tried: A=[data-message-author-role], B=[class*=userMessage/human_turn/fz-user], C=[data-role], D=[class*=message structural]'
    );
    console.warn("[CM:diag:deepseek] Candidate user classes:", [...classHits.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10));
    console.warn("[CM:diag:deepseek] Candidate role/type attrs seen:", attrHits.slice(0, 15));
  }

  collected.sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  // Content-hash dedup: guards against the same logical message appearing twice
  // when DeepSeek re-renders an element (new DOM reference, identical text) or
  // when multiple strategies independently match the same turn.
  const seenContent = new Set<string>()
  const messages: Message[] = [];
  for (const { el, role } of collected) {
    const content = extractMessageContent(el);
    if (!content) { console.warn(`[ContextMover:deepseek] empty content for role=${role}`); continue; }
    const key = `${role}:${content.slice(0, 80)}`
    if (seenContent.has(key)) {
      console.log(`[CM:diag:deepseek] content-dedup dropped duplicate ${role} turn`)
      continue
    }
    seenContent.add(key)
    messages.push({ role, content, timestamp: Date.now() });
  }

  const u = messages.filter((m) => m.role === "user").length;
  const a = messages.filter((m) => m.role === "assistant").length;
  console.log(`[CM:diag:deepseek] strategy=${matchedStrategy} user=${u} asst=${a}`);
  console.log('[CM:capture]', 'deepseek', {
    total: messages.length,
    user: u,
    assistant: a,
    preview: messages.map(m => ({ role: m.role, len: m.content.length }))
  });
  if (u === 0 && a > 0) console.warn("[CM:diag:deepseek] scraped: user=0 — user questions missing from capture");
  if (a === 0 && u > 0) console.error("[ContextMover:deepseek] ASSISTANT MESSAGES MISSING");

  return messages;
}

startSessionCapture({
  platform: "deepseek",
  selectorOrElement: "main",
  scrapeMessages: () => runCapturePipeline("deepseek", scrapeMessages),
  requiresScrollBack: true,
  getScrollContainerSelector: () => _remoteSelectors?.scrollContainer,
  extraCaptureDelays: [1500, 3000],
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "deepseek") {
    injectIntoDeepSeekInput(msg.prompt)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // CRITICAL — keeps channel open for async response
  }
  if (msg.type === "INJECT_FILE_AS_UPLOAD") {
    void (async () => {
      try {
        const file = new File([msg.fileContent as string], msg.fileName as string, { type: "text/xml" });
        const dt = new DataTransfer();
        dt.items.add(file);
        let input = document.querySelector<HTMLInputElement>("input[type='file']");
        if (!input) {
          const attachBtn = document.querySelector<HTMLElement>(
            '[aria-label*="Attach"], [aria-label*="attach"], ' +
            '[aria-label*="Upload"], [aria-label*="upload"], ' +
            'button[data-testid*="upload"], [class*="upload"], [class*="attach"]'
          );
          if (attachBtn) {
            attachBtn.click();
            for (let i = 0; i < 20; i++) {
              await new Promise((r) => setTimeout(r, 100));
              input = document.querySelector<HTMLInputElement>("input[type='file']");
              if (input) break;
            }
          }
        }
        if (!input) { sendResponse({ ok: false, error: "File input not found on DeepSeek page" }); return; }
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
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

  console.log(`[ContextMover:deepseek] injecting via: ${matchedSelector}`);
  if (!await injectWithRetry(input, text, "deepseek")) return { ok: false, error: "DeepSeek input did not accept the text after 3 attempts. Context copied to clipboard — paste with Ctrl+V." };

  return { ok: true };
}
