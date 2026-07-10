# ContextMover — Master Fix Bundle (Sonnet 4.6 Thinking)
# Paste MASTER CONTEXT first, then ONE PART per session. Run in order.

---
## MASTER CONTEXT (paste every session)

MV3 Chrome extension. Repo: /home/vip/Desktop/ContextMover
Pkg: packages/browser-extension
SW: src/background/service-worker.ts (NO DOM, NO ML)
Offscreen: src/offscreen/ (owns @xenova/transformers)
Content: src/content/{claude,chatgpt,gemini,grok,perplexity,deepseek}.ts + shared.ts
Sidebar: src/sidebar/*.tsx (MigrationModal.tsx, Sidebar.tsx, SessionList.tsx)
DB: src/lib/db.ts | Drive: src/lib/drive/* (drive.appdata)
Tier1/2: src/lib/summarizer.ts + src/lib/file-builder.ts
Tier3: src/lib/attention-engine.ts + src/lib/semantic-index/*
Remote selectors: src/lib/remote-config.ts (1h TTL + 6h alarm)

RULES:
1. NEVER import transformers in SW. Models offscreen-only.
2. NEVER document.* in SW.
3. Hardcoded selectors stay as fallback even when _remoteSelectors present.
4. Never delete or weaken tests.
5. No emoji or comment churn in source.
6. Build must pass after every part: cd packages/browser-extension && npx tsc --noEmit && npm run build
7. Cite @/abs/path.ts:LN in every claim.
8. Root-cause fixes only. No downstream workarounds.
9. Pause before: manifest perm changes, Drive schema changes, user data deletion.
10. End each part: (a) diffs (b) verify cmds (c) manual test (d) NOT fixed + why.

Forbidden phrases: "absolutely right", "great idea", "I agree", "makes sense".

---
## EXECUTION ORDER
1. UX Cleanup           — low risk
2. Drag-drop payload    — low risk
3. Tier divergence      — HIGH (use Crime & Punishment fixture)
4. Scrapers + scrollback — high
5. DeepSeek 3->2 bug    — medium
6. Drive cross-profile  — HIGH
7. Network-tap audit    — medium
8. E2E regression sweep — low

---
## PART 1 — UX Cleanup

Three surgical removals. No new features.

1A. Remove per-row download button from session list.
Find in src/sidebar/SessionList.tsx or Sidebar.tsx. Delete button + handler.
Download stays ONLY in MigrationModal.tsx::MigrationSuccess.

1B. Remove "capture quality dropping — try scrolling" alert.
Grep literal string. Delete toast component AND heuristic/state that triggers it. No dead state.

1C. Remove auto-close-on-tab-change.
Search: chrome.tabs.onActivated + onClose()/window.close() in src/sidebar/.
Delete listener entirely. Sidebar must persist across tab switches — required for cross-tab migrations.

Accept: build clean. No per-row download. No scroll alert. Sidebar stays open switching Claude->ChatGPT mid-migration.

---
## PART 2 — Drag-Drop File Payload

Symptom: drag emits text string only; no actual file lands on target chat input.

Fix in MigrationModal.tsx::MigrationSuccess onDragStart handler:

  const blob = new Blob([content], { type: "application/xml" });
  const url  = URL.createObjectURL(blob);
  e.dataTransfer.setData("DownloadURL", `application/xml:${filename}:${url}`);
  e.dataTransfer.setData("text/plain", filename);
  e.dataTransfer.effectAllowed = "copy";

Revoke URL on onDragEnd.
If extension-origin DownloadURL is blocked by Chrome: fallback to hidden <a download> click on dragstart + toast "File saved to Downloads".

Accept: drop onto Claude/ChatGPT composer attaches actual XML, not description text.

---
## PART 3 — Tier Divergence (CRITICAL)

Symptom: Tier1 / Tier2 / Tier3 produce byte-identical files on long sessions.
Fixture: /home/vip/Desktop/ContextMover/crime and punishment.txt

3A. Write Vitest test FIRST at src/lib/__tests__/tier-divergence.test.ts:
  - Read fixture. Split into 200 chunks ~2KB. Alternate user/assistant roles.
  - Build ContextSession. Call buildTier1File, buildTier2File, buildTier3File.
    Tier3 query: "What does Raskolnikov feel about his crime?"
  - Assert:
      charCount: t1 > t2 > t3
      sha256:    t1 != t2 != t3
      Tier3 keyword density ("guilt"/"crime"/"Raskolnikov") > Tier2
      Tier1 >= 95% input chars | Tier2 30-70% | Tier3 <= 25%

3B. Diagnose handleMigrateContext in service-worker.ts — which builder is called per tier.
Likely causes:
  - All three fall through to buildTier1File (silent catch -> tier1 fallback).
  - OR getMessagesFromChunks pads with tail-10, erasing attention filtering.
  - OR attention-engine returns 0 chunks (SW context, no DOM) -> keyword fallback returns ALL.

3C. Fix root causes:
  - Tier2: verify compressTier1Assistant() actually reduces middle length. Add assertion log.
  - Tier3: queryAttention() must return scored top-K, not all. getMessagesFromChunks must NOT
    unconditionally tail-pad; only pad if chunk count < 5.
  - Make outputs structurally distinct: Tier2 wraps compressed turns in <summary> tags;
    Tier3 wraps each retained turn in <attention score="X.XX"> tag.

Accept: test passes. 200-msg fixture -> 3 strictly smaller, distinct XMLs. Tier3 topically relevant.

---
## PART 4 — Scrapers + Scroll-Back Loader

Affected: ChatGPT (bad), Gemini (bad — needs scroll), Claude (inspect), Perplexity (inspect), Grok (OK, enhance).
Root cause: SPAs virtualise off-screen turns; old turns load only on scroll-up.

4A. Add autoScrollBackToTop(scope) to src/content/shared.ts:
  1. scrollContainer = _remoteSelectors.scrollContainer ?? nearest scrollable ancestor of scope.
  2. Loop: scrollTop = 0; await MutationObserver settle (no new nodes 800ms) OR 30s hard cap.
  3. Restore original scrollTop after scrape.
  New startSessionCapture flag: requiresScrollBack: true.
  Enable for: ChatGPT, Gemini, Claude (>100 turns), DeepSeek.

4B. Per-platform selector audit (May 2026 DOM):
  For each platform, confirm primary selector hits before fallback chain.
  Add log: [CM:diag:<platform>] strategy=N user=N asst=N
  All platforms must use extraCaptureDelays: [1500, 3000] minimum.

4C. ChatGPT specifically: verify src/content/chatgpt.ts Strategy 0 (messageSelector via
  [data-message-author-role]) is primary and hits before any class-based fallback.

Accept: cold-open 200-turn ChatGPT/Gemini chat, trigger capture without manual scroll -> user>100, asst>100 in logs.

---
## PART 5 — DeepSeek 3->2 Truncation

Symptom: 3-message session captured as 2. Last assistant message dropped.

Diagnose in src/content/deepseek.ts:
  - isStreaming() may match last assistant turn (not fully committed to DOM yet).
  - extraCaptureDelays may fire before final turn renders.
  - dedup seen-Set may drop re-rendered element with same content.

Fix:
  - Streaming guard: require BOTH streaming class AND absence of terminal punctuation.
  - Use extraCaptureDelays: [1500, 3000] for DeepSeek.
  - dedup by content-hash fallback, not only element reference.

Accept: 3-message DeepSeek session -> migration XML contains all 3 turns. Log: user=N asst=N correct.

---
## PART 6 — Drive Cross-Profile Sync (HIGH)

Symptom: sessions captured in Chrome profile A invisible in profile B even when both use same Drive account.

6A. Diagnose src/lib/drive/drive-client.ts + sync-manager.ts:
  - getToken() uses chrome.identity.getAuthToken — tied to primary Chrome profile sign-in.
    Two profiles = two different tokens even for same Google account unless same profile is signed in.
  - Local index in chrome.storage.local is per-profile and doesn't seed from Drive on connect.

6B. Fix — pull-on-connect flow:
  When user authenticates Drive, call drive.files.list (appdata space) immediately.
  For each file found: if sessionId not in local DB, import it. Seed local DB from Drive.

6C. Fix — upsert not create:
  Before uploading, list appdata files by name/sessionId. If exists -> PATCH. Prevents
  cross-profile duplicates.

6D. Fix — incremental push:
  syncAfterCapture must re-upload updated file (PATCH) when session gains new messages,
  not only on first capture.

6E. UI note: add tooltip "Drive sync works across profiles only if all profiles authenticate
  with the same Google account. Different Google accounts = separate silos."

Accept: same Google account in two Chrome profiles -> capture in A, pull Drive in B -> session appears. Session updates in A -> B sees updated version after sync.

---
## PART 7 — Network-Tap (API Capture) Audit

Some LLMs stream via SSE (ChatGPT /backend-api/conversation, Gemini streaming endpoint).
Tapping these gives higher fidelity than DOM scraping alone.

Check if src/content/fetch-interceptor.ts exists and is wired to ChatGPT/Gemini.
If yes: verify SSE stream parsing + dedup with DOM messages by message ID.
If no: add fetch interceptor for ChatGPT (intercept /backend-api/conversation) and Gemini.
  - Parse text/event-stream chunks.
  - Feed into same scrapeMessages pipeline as additive source.
  - DOM scraping stays primary; API tap supplements.
  - Dedup by content-hash to avoid double-entries.

Accept: ChatGPT 50-turn session captured via API tap -> user=50 asst=50, no duplicates.

---
## PART 8 — E2E Regression Sweep

BUILD:
  cd packages/browser-extension && npx tsc --noEmit && npm run build

VITEST:
  npm test -- tier-divergence   (Part 3 test must pass)

CHECKLIST:
1. Claude 10-turn: log shows "primary selector matched" not "fallback A".
2. ChatGPT 200-turn (cold, no scroll): user>100 asst>100 in logs.
3. Gemini 200-turn (cold): same.
4. DeepSeek 3-msg: XML has all 3 turns.
5. Session list: NO download button. NO scroll alert.
6. Switch tab mid-migration: sidebar stays open.
7. Drag card onto Claude composer: actual XML attaches.
8. Two profiles, same Google account: A captures -> B pull -> session visible.
9. Tier3 migration on 200-msg session: XML smaller than Tier1/2, topically relevant.
10. SW console: chrome.alarms.getAll -> cm-remote-config-refresh alarm present.

ALL 10 must pass with zero console errors.
