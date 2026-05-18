/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/content/interceptor-bridge.ts
//
// ISOLATED-world content script.  Listens for the `contextmover:captured`
// CustomEvent dispatched by the MAIN-world fetch interceptor, validates the
// payload, merges with prior captures for the same session, and forwards
// to the service worker as a CAPTURE_SESSION message.
//
// Also exposes a global flag (window.__contextForgeFetchCaptured) that the
// per-platform DOM scrapers read to decide whether to skip the DOM fallback.

import { resolveSessionId, makeLegacyChecker } from "@/lib/session-id";
import type { Message, Platform } from "@/lib/types";

type CapturedMessage = Message & {
  codeBlocks?: { language: string; code: string }[];
  toolCalls?: Array<{ id: string; name: string; arguments: string; result?: string }>;
  artifacts?: Array<{ type: string; title?: string; language?: string; content?: string; url?: string }>;
};

type RequestMetadata = {
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  tools?: Array<{ name: string; description?: string }>;
  conversationId?: string;
  messageId?: string;
};

type CapturedDetail = {
  platform: Platform;
  messages: CapturedMessage[];
  metadata?: RequestMetadata;
  fullHistory?: boolean;
};

const TAG = "[ContextMover:bridge]";
const VALID_PLATFORMS: Platform[] = ["claude", "chatgpt", "gemini", "grok", "perplexity", "deepseek"];
const legacyChecker = makeLegacyChecker();

// Idempotency: do not double-install if the bridge is loaded twice.
const w = window as unknown as {
  __contextForgeBridgeInstalled?: boolean;
  __contextForgeFetchCaptured?: { at: number; count: number };
};
if (w.__contextForgeBridgeInstalled) {
  console.log(`${TAG} already installed, skipping`);
} else {
  w.__contextForgeBridgeInstalled = true;
  install();
}

function install() {
  // In-memory accumulator: API responses often contain ONLY the latest
  // assistant turn (Claude/Grok) or the latest delta (ChatGPT). We merge
  // with prior captures keyed by session id so the service worker
  // always sees the FULL conversation, not just the latest exchange.
  const accumulator = new Map<string, CapturedMessage[]>();
  // Per-session metadata accumulator (model, system prompt, tools, etc.)
  const metadataAccumulator = new Map<string, RequestMetadata>();
  // Per-platform cached session id (cleared on URL change or SESSION_FORGOTTEN).
  const sessionCache = new Map<Platform, { href: string; id: string }>();

  async function ensureSessionId(platform: Platform): Promise<string> {
    const href = window.location.href;
    const cached = sessionCache.get(platform);
    if (cached && cached.href === href) return cached.id;
    const id = await resolveSessionId(platform, href, legacyChecker);
    sessionCache.set(platform, { href, id });
    return id;
  }

  // Listen for forget broadcasts so deleted sessions don't auto-resurrect with
  // the same id. After a forget, the next captured event mints a fresh id and
  // ships the full re-extracted history under it.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "SESSION_FORGOTTEN") return;
    const forgottenId: string | undefined = msg.sessionId;
    if (!forgottenId) return;
    accumulator.delete(forgottenId);
    metadataAccumulator.delete(forgottenId);
    for (const [p, entry] of sessionCache) {
      if (entry.id === forgottenId) sessionCache.delete(p);
    }
    // Reset the DOM-fallback gate so the scraper takes over immediately if the
    // bridge cannot re-issue a capture (e.g. tab idle, no fresh fetch).
    w.__contextForgeFetchCaptured = undefined;
    console.log(`${TAG} cleared cached state for forgotten session ${forgottenId}`);
  });

  window.addEventListener("contextmover:captured", (rawEvent: Event) => {
    // Bug fix: Claude SPA navigates from /new \u2192 /chat/{id} after the first
    // user message. If the fetch fires while location is still /new, we'd
    // resolve a sessionId bound to "claude::claude.ai/new" \u2014 a different id
    // from what the DOM-scrape path resolves moments later at /chat/{id},
    // producing two orphaned half-sessions. Defer the entire pipeline by
    // 1500ms when /new is detected so ensureSessionId() runs at the final
    // URL. Other platforms / non-/new URLs run synchronously as before.
    const detailPlatform = (rawEvent as CustomEvent<CapturedDetail>).detail?.platform;
    const href = location.href;
    const isClaudeNew =
      detailPlatform === "claude" &&
      (href.endsWith("/new") || /\/new(?:[?#]|$)/.test(href));

    const run = () => void (async () => {
      try {
        const event = rawEvent as CustomEvent<CapturedDetail>;
        const detail = event.detail;
        if (!detail || typeof detail !== "object") return;

        const { platform, messages, metadata, fullHistory } = detail;

        // ── Validation ──────────────────────────────────────────────────────
        if (!VALID_PLATFORMS.includes(platform)) {
          console.warn(`${TAG} invalid platform: ${platform}`);
          return;
        }
        if (!Array.isArray(messages) || messages.length === 0) {
          return;
        }

        const cleaned: CapturedMessage[] = [];
        for (const m of messages) {
          if (!m || typeof m !== "object") continue;
          if (m.role !== "user" && m.role !== "assistant") continue;
          if (typeof m.content !== "string" || m.content.trim().length === 0) continue;
          cleaned.push({
            role: m.role,
            content: m.content,
            timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
            ...(Array.isArray(m.codeBlocks) && m.codeBlocks.length > 0
              ? { codeBlocks: m.codeBlocks }
              : {}),
            ...(Array.isArray(m.toolCalls) && m.toolCalls.length > 0
              ? { toolCalls: m.toolCalls }
              : {}),
            ...(Array.isArray(m.artifacts) && m.artifacts.length > 0
              ? { artifacts: m.artifacts }
              : {}),
          });
        }
        if (cleaned.length === 0) return;

        // Merge with prior captures for this session.
        const sessionId = await ensureSessionId(platform);
        const prior = accumulator.get(sessionId) ?? [];

        // ── Defense-in-depth against malicious CustomEvent dispatches ────
        // Any page-level XSS on a supported platform can dispatch a fake
        // `contextmover:captured` event with `fullHistory: true` and a
        // short messages array — which would otherwise replace the
        // accumulator outright and clobber the legitimate session.
        // We can't prove the source, but we CAN reject obvious shrink
        // attacks. An attacker cannot make a session smaller.
        if (fullHistory) {
          console.warn(
            `${TAG} fullHistory event received, count=${cleaned.length} vs existing=${prior.length}`
          );
          if (cleaned.length < 3) {
            console.warn(
              `${TAG} fullHistory rejected: too few messages (${cleaned.length} < 3)`
            );
            return;
          }
          if (prior.length > 0 && cleaned.length < Math.floor(prior.length * 0.8)) {
            console.warn(
              `${TAG} fullHistory rejected: shrinks session by >20% ` +
              `(${cleaned.length} < ${prior.length} * 0.8)`
            );
            return;
          }
        }

        // fullHistory=true means we received the complete conversation from a
        // conversation-load API response — replace the accumulator outright so
        // stale partial DOM captures don't pollute the full set.
        const merged = fullHistory ? [...cleaned] : mergeMessages(prior, cleaned);
        accumulator.set(sessionId, merged);

        // Accumulate metadata per session
        if (metadata) {
          const existingMeta = metadataAccumulator.get(sessionId) ?? {};
          metadataAccumulator.set(sessionId, { ...existingMeta, ...metadata });
        }

        const userCount = merged.filter((m) => m.role === "user").length;
        const assistantCount = merged.filter((m) => m.role === "assistant").length;

        // Need at least one assistant turn before persisting (avoid noisy
        // user-only snapshots while a request is in flight).
        if (assistantCount === 0) {
          console.log(
            `${TAG} ${platform}: ${userCount} user, 0 assistant — waiting for assistant turn`
          );
          return;
        }

        // Mark fetch capture as successful so DOM fallback skips itself.
        w.__contextForgeFetchCaptured = { at: Date.now(), count: merged.length };

        const title = deriveTitle(platform, merged);

        console.log(
          `${TAG} ${platform}: forwarding ${merged.length} msg(s) (user=${userCount} asst=${assistantCount}) → service worker`
        );

        try {
          const sessionMeta = metadataAccumulator.get(sessionId);
          chrome.runtime.sendMessage(
            {
              type: "CAPTURE_SESSION",
              payload: {
                platform,
                sessionId,
                title,
                messages: merged,
                source: "fetch-intercept",
                metadata: sessionMeta ?? undefined,
              },
            },
            () => {
              // Swallow lastError — service worker may be cold-starting.
              void chrome.runtime.lastError;
            }
          );
        } catch (err) {
          console.warn(`${TAG} sendMessage failed`, err);
        }
      } catch (err) {
        console.warn(`${TAG} handler failed`, err);
      }
    })();

    if (isClaudeNew) {
      console.log(`${TAG} claude /new detected \u2014 deferring 1500ms for SPA nav before resolving sessionId`);
      setTimeout(run, 1500);
    } else {
      run();
    }
  });

  console.log(`${TAG} installed`);
}

// Hard caps to prevent large sessions from freezing the extension popup UI.
// Messages exceeding PER_MSG_MAX_CHARS are truncated (content is preserved up
// to the cap with a truncation notice appended).
// Sessions whose total content exceeds ACCUMULATOR_MAX_CHARS are sent as-is
// but no further merges are performed — the service worker shrink-guard then
// protects IDB from a smaller DOM-scrape overwriting the stored full history.
const PER_MSG_MAX_CHARS     =  80_000;
const ACCUMULATOR_MAX_CHARS = 500_000;

function capMessage(m: CapturedMessage): CapturedMessage {
  if (m.content.length <= PER_MSG_MAX_CHARS) return m;
  return {
    ...m,
    content: m.content.slice(0, PER_MSG_MAX_CHARS) +
      `\n\n[ContextMover: content truncated at ${PER_MSG_MAX_CHARS} chars to prevent UI freeze]`,
  };
}

// Merge a freshly-captured batch with previously-known messages.  Strategy:
//   • Use (role + first 80 chars of content) as a fingerprint.
//   • If a fresh message matches an existing fingerprint, REPLACE it (the new
//     copy is more complete — assistant streams grow over time).
//   • Otherwise APPEND.
function mergeMessages(prior: CapturedMessage[], fresh: CapturedMessage[]): CapturedMessage[] {
  // If accumulator is already at the size cap, stop merging — forward as-is.
  const priorChars = prior.reduce((s, m) => s + m.content.length, 0);
  if (priorChars >= ACCUMULATOR_MAX_CHARS) {
    console.warn(`${TAG} accumulator at cap (${priorChars} chars) — skipping merge`);
    return prior;
  }

  const out = [...prior];
  for (const m of fresh) {
    const capped = capMessage(m);
    const fp = fingerprint(capped);
    const idx = out.findIndex((p) => fingerprint(p) === fp);
    if (idx >= 0) {
      const existing = out[idx];
      out[idx] = capped.content.length >= existing.content.length ? capped : existing;
    } else {
      out.push(capped);
    }
  }
  return out;
}

function fingerprint(m: CapturedMessage): string {
  return `${m.role}::${m.content.slice(0, 80).replace(/\s+/g, " ").trim()}`;
}

function deriveTitle(platform: Platform, messages: CapturedMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user")?.content
    ?? messages[0]?.content
    ?? "";
  const cleaned = firstUser.replace(/\s+/g, " ").trim();
  if (cleaned) return cleaned.length > 72 ? `${cleaned.slice(0, 71)}…` : cleaned;
  return `${platform[0].toUpperCase()}${platform.slice(1)} session`;
}
