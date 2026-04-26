// packages/browser-extension/src/content/interceptor-bridge.ts
//
// ISOLATED-world content script.  Listens for the `contextforge:captured`
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
};

type CapturedDetail = {
  platform: Platform;
  messages: CapturedMessage[];
};

const TAG = "[ContextForge:bridge]";
const VALID_PLATFORMS: Platform[] = ["claude", "chatgpt", "gemini", "grok"];
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
    for (const [p, entry] of sessionCache) {
      if (entry.id === forgottenId) sessionCache.delete(p);
    }
    // Reset the DOM-fallback gate so the scraper takes over immediately if the
    // bridge cannot re-issue a capture (e.g. tab idle, no fresh fetch).
    w.__contextForgeFetchCaptured = undefined;
    console.log(`${TAG} cleared cached state for forgotten session ${forgottenId}`);
  });

  window.addEventListener("contextforge:captured", (rawEvent: Event) => {
    void (async () => {
      try {
        const event = rawEvent as CustomEvent<CapturedDetail>;
        const detail = event.detail;
        if (!detail || typeof detail !== "object") return;

        const { platform, messages } = detail;

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
          });
        }
        if (cleaned.length === 0) return;

        // Merge with prior captures for this session.
        const sessionId = await ensureSessionId(platform);
        const prior = accumulator.get(sessionId) ?? [];
        const merged = mergeMessages(prior, cleaned);
        accumulator.set(sessionId, merged);

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
          chrome.runtime.sendMessage(
            {
              type: "CAPTURE_SESSION",
              payload: {
                platform,
                sessionId,
                title,
                messages: merged,
                source: "fetch-intercept",
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
  });

  console.log(`${TAG} installed`);
}

// Merge a freshly-captured batch with previously-known messages.  Strategy:
//   • Use (role + first 80 chars of content) as a fingerprint.
//   • If a fresh message matches an existing fingerprint, REPLACE it (the new
//     copy is more complete — assistant streams grow over time).
//   • Otherwise APPEND.
function mergeMessages(prior: CapturedMessage[], fresh: CapturedMessage[]): CapturedMessage[] {
  const out = [...prior];
  for (const m of fresh) {
    const fp = fingerprint(m);
    const idx = out.findIndex((p) => fingerprint(p) === fp);
    if (idx >= 0) {
      const existing = out[idx];
      out[idx] = m.content.length >= existing.content.length ? m : existing;
    } else {
      out.push(m);
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
