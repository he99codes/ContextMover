/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/content/perplexity.ts
import { extractMessageContent, injectWithRetry, runCapturePipeline, startSessionCapture, waitForAnyElement } from "./shared";
import type { Message } from "@/lib/types";
import { getPlatformSelectors, type PlatformSelectors } from "@/lib/remote-config";
import { getOverridesForPlatform } from "@/lib/self-heal/selector-overrides";

console.log("[ContextMover] Perplexity content script loaded");

// Pre-warm remote selector config at load time.
let _remoteSelectors: PlatformSelectors | null = null;
getPlatformSelectors("perplexity").then((s) => { _remoteSelectors = s; }).catch(() => {});

// Pre-warm local self-heal overrides (user-confirmed via wizard).
let _localOverrides: Awaited<ReturnType<typeof getOverridesForPlatform>> = null;
getOverridesForPlatform("perplexity").then((o) => { _localOverrides = o; }).catch(() => {});

function hasTerminalPunctuation(el: HTMLElement): boolean {
  const text = (el.textContent ?? '').replace(/\s+$/, '')
  if (!text) return false
  return '.!?…`。！？'.includes(text.slice(-1))
}

function isStreaming(el: HTMLElement): boolean {
  const hasMarker = (
    el.classList.contains("result-streaming") ||
    el.querySelector(".result-streaming") !== null ||
    el.hasAttribute("data-is-streaming") ||
    el.classList.contains("streaming") ||
    el.classList.contains("loading")
  )
  if (!hasMarker) return false
  return !hasTerminalPunctuation(el)
}

function scrapeMessages(): Message[] {
  type Entry = { el: HTMLElement; role: "user" | "assistant" };
  const collected: Entry[] = [];
  const hasUser = () => collected.some((e) => e.role === "user");
  const hasAsst = () => collected.some((e) => e.role === "assistant");

  // ── Strategy A: data-message-role attribute (remote messageSelector overrides) ──
  {
    const msgSel = _remoteSelectors?.messageSelector ?? "[data-message-role]";
    const els = [...document.querySelectorAll<HTMLElement>(msgSel)]
      .filter((el) => !el.parentElement?.closest(msgSel) && !isStreaming(el));
    for (const el of els) {
      const role = el.dataset.messageRole;
      if (role === "user" || role === "assistant") collected.push({ el, role });
    }
    console.log(`[ContextMover:perplexity] A data-message-role: ${collected.length}`);
  }

  // ── Strategy B: class substrings — PRIMARY: prose for assistant, group/query for user ─
  if (!hasAsst()) {
    // Perplexity 2026: [class*="prose"] is the primary assistant selector (23+ hits on typical page)
    // [class*="group/query"] is the primary user selector (2+ hits on typical page)
    const userSel = _remoteSelectors?.userSelector
      ?? _localOverrides?.userSelector
      ?? '[class*="group/query"], [class*="query"], [data-testid="user-message"], [data-testid*="user-query"], [aria-label*="question" i], [class*="UserMessage"], [class*="user-message"]';
    const asstSel = _remoteSelectors?.assistantSelector
      ?? _localOverrides?.assistantSelector
      ?? '[class*="prose"]:not([class*="sidebar"]):not(nav):not(footer):not(aside), [class*="answer-text"], [data-testid*="answer"], [aria-label*="answer" i], [class*="AnswerText"], [class*="model-answer"], [class*="assistant-message"], .answer-block, [class*="answer-block"]';

    const userEls = [...document.querySelectorAll<HTMLElement>(userSel)]
      .filter((el) => !el.parentElement?.closest(userSel) && !isStreaming(el));
    const asstEls = [...document.querySelectorAll<HTMLElement>(asstSel)]
      .filter((el) => !el.parentElement?.closest(asstSel) && !isStreaming(el) && (el.textContent ?? "").trim().length > 15)
      // Exclude structural noise containers only (content filters kill legitimate answers)
      .filter((el) => !el.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [class*="sidebar"], [class*="nav"], [class*="sources"], [class*="citation"]'));

    for (const el of userEls) collected.push({ el, role: "user" });
    // Dedup: if multiple asstEls share the same parent element, keep only the first one
    // (prevents each paragraph inside an answer from being counted as a separate message)
    const seenParents = new Set<HTMLElement | null>();
    const dedupedAsst = asstEls.filter((el) => {
      const parent = el.parentElement;
      if (seenParents.has(parent)) return false;
      seenParents.add(parent);
      return true;
    });
    for (const el of dedupedAsst) collected.push({ el, role: "assistant" });
    console.log(`[ContextMover:perplexity] B class-substr: user=${userEls.length} asst=${dedupedAsst.length} (pre-dedup: ${asstEls.length})`);
  }

  // ── Strategy C: Perplexity thread structure ──────────────────────────────────
  // Perplexity wraps Q+A pairs in [class*="thread"] containers (2+ on typical page)
  // Run if user messages are still missing (even if assistant already found via Strategy B).
  if (!hasUser()) {
    const threadSel = '[class*="thread"], [class*="ThreadItem"], [class*="conversation-turn"], [class*="ConversationTurn"]';
    const turns = [...document.querySelectorAll<HTMLElement>(threadSel)]
      .filter((el) => !el.parentElement?.closest(threadSel) && !isStreaming(el));
    for (const turn of turns) {
      const queryEl = turn.querySelector<HTMLElement>('[class*="group/query"], [class*="query"], [class*="Query"], [class*="user"]');
      const answerEl = turn.querySelector<HTMLElement>('[class*="prose"], [class*="answer"], [class*="Answer"], [class*="markdown"], .answer-block, [class*="answer-block"]');
      if (queryEl && !isStreaming(queryEl)) collected.push({ el: queryEl, role: "user" });
      // Only add assistant from thread turns if Strategy B didn't already find assistant messages.
      if (!hasAsst() && answerEl && !isStreaming(answerEl)) collected.push({ el: answerEl, role: "assistant" });
    }
    console.log(`[ContextMover:perplexity] C thread-items: ${turns.length} turns`);
  }

  // ── Strategy D: prose / markdown blocks with sibling heuristic ──────────────
  if (!hasUser() && !hasAsst()) {
    const proseEls = [...document.querySelectorAll<HTMLElement>('.prose, [class*="markdown"], [class*="Markdown"], .answer-block, [class*="answer-block"]')]
      .filter((el) => !el.parentElement?.closest('.prose, [class*="markdown"], .answer-block, [class*="answer-block"]') && !isStreaming(el));
    for (const el of proseEls) {
      const text = (el.textContent ?? "").trim();
      if (text.length > 15) collected.push({ el, role: "assistant" });
    }
    console.log(`[ContextMover:perplexity] D prose/markdown: ${proseEls.length}`);
  }

  // ── Strategy E: ARIA labels + role attributes ────────────────────────
  // Perplexity may annotate messages with aria-label or role attributes that
  // survive class-name obfuscation and build-hash changes.
  if (!hasUser()) {
    const ariaUserEls = [...document.querySelectorAll<HTMLElement>(
      '[aria-label*="query" i]:not(nav):not(button), [aria-label*="question" i]:not(nav):not(button), [data-role="user"], [role="listitem"][data-type="user"]'
    )].filter((el) => !isStreaming(el));
    const ariaAsstEls = [...document.querySelectorAll<HTMLElement>(
      '[aria-label*="answer" i]:not(button):not(nav):not(header), [data-role="assistant"]'
    )].filter((el) => !isStreaming(el) && (el.textContent ?? "").trim().length > 15);
    for (const el of ariaUserEls) collected.push({ el, role: "user" });
    if (!hasAsst()) for (const el of ariaAsstEls) collected.push({ el, role: "assistant" });
    console.log(`[ContextMover:perplexity] E aria+role: user=${ariaUserEls.length} asst=${ariaAsstEls.length}`);
  }

  // ── Diagnostic if nothing found ──────────────────────────────────
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
    console.debug("[ContextMover:perplexity] NO messages found. Top candidate classes:", top);
    return [];
  }

  // ── DOM inspection when user=0 but asst>0 ──────────────────────────
  if (!hasUser() && hasAsst()) {
    const classHits = new Map<string, number>();
    const testidHits: string[] = [];
    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      if (!el.offsetParent && el.tagName !== "BODY") return;
      el.classList.forEach((c) => {
        if (/user|query|question|human|prompt/i.test(c))
          classHits.set(c, (classHits.get(c) ?? 0) + 1);
      });
      const dt = el.dataset?.testid ?? "";
      if (dt && /user|query|human/i.test(dt) && !testidHits.includes(dt)) testidHits.push(dt);
    });
    console.debug(
      '[CM:diag:perplexity] user=0 — tried: A=[data-message-role], B=[data-testid="user-message"], C=[thread-item>.query]'
    );
    console.debug("[CM:diag:perplexity] Candidate user classes:", [...classHits.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10));
    console.debug("[CM:diag:perplexity] Candidate user testids:", testidHits.slice(0, 10));
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
    let content = extractMessageContent(clone);
    // Fallback: if extractMessageContent returns empty, use innerText directly
    if (!content) content = (clone.innerText ?? clone.textContent ?? "").trim();
    if (content) messages.push({ role, content, timestamp: Date.now() });
    else console.debug(`[ContextMover:perplexity] empty content for role=${role}`);
  }

  const u = messages.filter((m) => m.role === "user").length;
  const a = messages.filter((m) => m.role === "assistant").length;
  console.log('[CM:capture]', 'perplexity', {
    total: messages.length,
    user: u,
    assistant: a,
    preview: messages.map(m => ({ role: m.role, len: m.content.length }))
  });
  if (u === 0 && a > 0) console.debug("[CM:diag:perplexity] scraped: user=0 — user questions missing from capture");
  if (a === 0 && u > 0) console.error("[ContextMover:perplexity] ASSISTANT MESSAGES MISSING");

  return messages;
}

startSessionCapture({
  platform: "perplexity",
  selectorOrElement: () => _remoteSelectors?.observerTarget ?? 'main, #root, [role="main"], div.isolate.flex, .conversation, .chat-container, .messages, [class*="conversation"], [class*="messages"], [class*="chat"]',
  scrapeMessages: () => runCapturePipeline("perplexity", scrapeMessages),
  requiresScrollBack: true,
  // [ISSUE-5-perplexity] Add scroll container selector for scrollback
  getScrollContainerSelector: () => _remoteSelectors?.scrollContainer ?? 'main, [class*="scroll"], [class*="conversation"], [class*="chat"]',
  // Extra late re-scrape (6s) catches assistant answers that were still
  // streaming (and thus filtered by isStreaming) during the earlier passes.
  extraCaptureDelays: [1500, 3000, 6000],
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "INJECT_CONTEXT" && msg.platform === "perplexity") {
    injectIntoPerplexityInput(msg.prompt)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // CRITICAL — keeps channel open for async response
  }
  if (msg.type === "INJECT_FILE_AS_UPLOAD") {
    void (async () => {
      try {
        const txtName = (msg.fileName as string).replace(/\.xml$/, '.txt');
        const file = new File([msg.fileContent as string], txtName, { type: "text/plain" });
        const dt = new DataTransfer();
        dt.items.add(file);
        let input = document.querySelector<HTMLInputElement>("input[type='file']");
        if (!input) {
          const attachBtn = document.querySelector<HTMLElement>(
            '[aria-label*="Attach"], [aria-label*="attach"], ' +
            '[aria-label*="Upload"], [aria-label*="upload"], ' +
            'button[data-testid*="file"], [class*="attach"], [class*="upload"]'
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
        if (!input) { sendResponse({ ok: false, error: "File input not found on Perplexity page" }); return; }
        const nativeFilesSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype, 'files'
        )?.set;
        if (nativeFilesSetter) {
          nativeFilesSetter.call(input, dt.files);
        } else {
          input.files = dt.files;
        }
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
  if (!await injectWithRetry(input, text, "perplexity")) return { ok: false, error: "Perplexity input did not accept the text after 3 attempts. Context copied to clipboard — paste with Ctrl+V." };
  return { ok: true };
}
