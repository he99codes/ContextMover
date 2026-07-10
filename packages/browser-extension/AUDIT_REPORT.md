# ContextMover Browser Extension — Audit Report

**Scope:** `packages/browser-extension/src/`  
**Report format:** 10 issues · exact file paths · exact function names · exact line numbers · exact broken code snippets  
**Instruction:** DO NOT FIX. Document only. Every code snippet is verbatim from source.

---

## Table of Contents

1. [Issue 1 — `GET_SIDEBAR_STATE` Message Not Handled in Service Worker](#issue-1)
2. [Issue 2 — `TOGGLE_SIDEBAR` Panel State Detection Not Scoped to Sender's Tab](#issue-2)
3. [Issue 3 — `scrapeSessionFromPage` Missing `perplexity` and `deepseek` Handlers](#issue-3)
4. [Issue 4 — `CAPTURE_HEALTH` Alert Threshold Mismatch (0.7 vs 0.8)](#issue-4)
5. [Issue 5 — `busy` Flag Not Visually Reset Before SW-Sleeping Retry Window](#issue-5)
6. [Issue 6 — `buildMetaPromptAsync` Overwrites All MetaPrompts With Same Primary Key; `getMetaPrompt` Ignores `platform` and `tier` Parameters](#issue-6)
7. [Issue 7 — `context-builder.ts` XML Format Does Not CDATA-Wrap File Content](#issue-7)
8. [Issue 8 — `setPanelBehavior` Called Twice With Contradictory Values Across SW Lifecycle Events](#issue-8)
9. [Issue 9 — `sendMessageToTab` Called With Non-Null Assertion on Optional `targetTabId`](#issue-9)
10. [Issue 10 — `claude.ts` Structural Fallback Assigns Roles by DOM Index Parity](#issue-10)

---

## Dependency Map

```
toggle.ts
  └─ sends GET_SIDEBAR_STATE → service-worker.ts (MISSING handler) ← Issue 1
  └─ sends TOGGLE_SIDEBAR   → service-worker.ts TOGGLE_SIDEBAR case ← Issue 2, Issue 5

service-worker.ts
  └─ handleMigrateContext() → sendMessageToTab(payload.targetTabId!) ← Issue 9
  └─ buildMetaPromptAsync() → db.saveMetaPrompt({ id: session.id }) ← Issue 6
  └─ scrapeSessionFromPage() → missing perplexity/deepseek branches ← Issue 3
  └─ CAPTURE_HEALTH handler → threshold 0.7 ← Issue 4
  └─ setPanelBehavior(true) at module level ← Issue 8
  └─ onInstalled → setPanelBehavior(false) ← Issue 8

db.ts
  └─ metaPrompts keyPath = "id" (simple string) ← Issue 6
  └─ getMetaPrompt ignores platform/tier params ← Issue 6

health-monitor.ts
  └─ ALERT_THRESHOLD = 0.8 ← conflicts with service-worker.ts 0.7 ← Issue 4

context-builder.ts
  └─ buildXml() → raw ${f.content} in XML ← Issue 7

claude.ts
  └─ detectByStructure() → role by index parity ← Issue 10
```

---

## Missing Implementations

| Item | Location | Description |
|------|----------|-------------|
| `GET_SIDEBAR_STATE` handler | `service-worker.ts` switch statement | Message sent from `toggle.ts:77-86`; no corresponding `case` exists |
| `perplexity` branch in `scrapeSessionFromPage` | `service-worker.ts:1560-1618` | Only 4 of 6 platforms handled |
| `deepseek` branch in `scrapeSessionFromPage` | `service-worker.ts:1560-1618` | Only 4 of 6 platforms handled |
| Composite key for `metaPrompts` table | `db.ts:227`, `db.ts:285-298` | Simple `id` key with platform/tier ignored |

---

## Risk Assessment

| Issue | Severity | User-Visible Impact |
|-------|----------|---------------------|
| 1 — GET_SIDEBAR_STATE missing | **HIGH** | Toggle button always shows "closed" on inject/tab focus |
| 2 — Unscoped getContexts | **HIGH** | Toggle direction inverted when sidebar is open on another tab |
| 3 — Missing platform scrapers | **MEDIUM** | perplexity/deepseek sessions never recovered via tab sync |
| 4 — Threshold mismatch | **MEDIUM** | Capture alerts fire or clear at wrong success-rate breakpoints |
| 5 — busy visual race | **LOW** | Button can be double-clicked during 150ms retry window |
| 6 — MetaPrompt key collision + ignored params | **HIGH** | Pre-built prompts always return wrong platform/tier data |
| 7 — Unescaped XML content | **HIGH** | Migration XML file silently malformed for code-heavy sessions |
| 8 — Contradictory setPanelBehavior | **MEDIUM** | Toolbar icon behavior changes after SW sleep/restart |
| 9 — Non-null assertion on optional tabId | **HIGH** | Runtime undefined passed to chrome.tabs.sendMessage on missing tabId |
| 10 — Role by index parity | **LOW** | First captured message labeled wrong role on structural fallback |

---

---

## Issue 1

### `GET_SIDEBAR_STATE` Message Not Handled in Service Worker

**Files involved:**
- `packages/browser-extension/src/content/sidebar-toggle/toggle.ts`
- `packages/browser-extension/src/background/service-worker.ts`

**What the code is supposed to do:**  
When the toggle button is injected into the page (and when the tab becomes visible again via `visibilitychange`), `syncState()` sends a `GET_SIDEBAR_STATE` message to the service worker to read the actual current sidebar open/closed state and sync the button's visual indicator accordingly.

**Function names and line numbers:**

- `toggle.ts:77–86` — `syncState()` function
- `service-worker.ts:376–938` — the full `switch (msg.type)` block (no `GET_SIDEBAR_STATE` case present)
- `service-worker.ts:937–938` — `default:` case that handles unknown message types

**Exact broken code — sender (`toggle.ts:77–86`):**

```typescript
function syncState(): void {
    chrome.runtime.sendMessage(
      { type: "GET_SIDEBAR_STATE" },
      (res) => {
        if (chrome.runtime.lastError) return;
        isOpen = res?.isOpen ?? false;
        updateBtn();
      }
    );
  }
```

**Exact broken code — receiver (`service-worker.ts:937–939`):**

```typescript
      default:
        sendResponse({ error: `Unknown message type: ${msg.type}` });
    }
```

**What it actually does wrong:**  
The service worker switch statement has no `case "GET_SIDEBAR_STATE":`. The message falls through to the `default:` case, which responds with `{ error: "Unknown message type: GET_SIDEBAR_STATE" }`. Back in `toggle.ts`, the callback receives `{ error: "..." }` — `res?.isOpen` is `undefined` — so `isOpen = res?.isOpen ?? false` always resolves to `false`. The toggle button always initializes as "closed" and always re-initializes as "closed" every time the user switches back to the tab (via `visibilitychange`), regardless of the sidebar's actual state.

**Related files touching the same logic:**
- `toggle.ts:139–146` — `visibilitychange` listener calls `syncState()` on tab focus
- `toggle.ts:71` — `isOpen` local variable whose only authoritative source is `syncState()`
- `service-worker.ts:734–773` — `TOGGLE_SIDEBAR` case does write `sendResponse({ isOpen: true/false })` but that is only consumed in the click handler callback, not by `syncState()`

---

## Issue 2

### `TOGGLE_SIDEBAR` Panel State Detection Not Scoped to Sender's Tab

**Files involved:**
- `packages/browser-extension/src/background/service-worker.ts`

**What the code is supposed to do:**  
When the toggle button is clicked, the service worker should detect whether the sidebar panel is currently open **on the tab that sent the message**, then open or close it accordingly for that specific tab.

**Function names and line numbers:**

- `service-worker.ts:734–773` — `case "TOGGLE_SIDEBAR":` handler

**Exact broken code (`service-worker.ts:741–750`):**

```typescript
        // Detect actual panel state via getContexts() — immune to SW restart state loss
        let panelIsOpen = false;
        try {
          const contexts = await chrome.runtime.getContexts({
            contextTypes: ["SIDE_PANEL" as chrome.runtime.ContextType],
          });
          panelIsOpen = contexts.length > 0;
        } catch {
          panelIsOpen = false;
        }
```

**What it actually does wrong:**  
`chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })` returns ALL side panel instances for the extension across ALL tabs — it is NOT filtered to the `tabId` of the message sender. If the sidebar is open on Tab A and the user clicks the toggle button on Tab B (which has no sidebar open), `contexts.length > 0` evaluates to `true`, so the handler tries to **close** the panel for Tab B with `chrome.sidePanel.close({ tabId: tabB })`. Since no panel is open on Tab B, `close` either throws (Chrome 123+) or no-ops. The response sent back is `{ isOpen: false }`, so the toggle button on Tab B treats itself as now "closed" — which is correct by accident — but the actual panel on Tab A is untouched. The user on Tab B gets no sidebar opened. Conversely, if the sidebar was just opened on Tab B and another tab also has it open, the detection will still see `contexts.length > 0` and try to close instead of open.

**Related files touching the same logic:**
- `toggle.ts:93–137` — click handler sends `TOGGLE_SIDEBAR` and updates `isOpen` from `res.isOpen`
- `service-worker.ts:752–764` — close branch uses `chrome.sidePanel.close({ tabId })` where `tabId` IS the sender's tab, but the decision to close was wrong
- `service-worker.ts:765–771` — open branch also uses the sender's `tabId` correctly

---

## Issue 3

### `scrapeSessionFromPage` Missing `perplexity` and `deepseek` Handlers

**Files involved:**
- `packages/browser-extension/src/background/service-worker.ts`

**What the code is supposed to do:**  
`syncOpenTabs()` iterates over all entries in `PLATFORM_URLS` (which includes `claude`, `chatgpt`, `gemini`, `grok`, `perplexity`, `deepseek`) and for each matching open tab, executes `scrapeSessionFromPage(platform)` inside the page to recover the current session messages. This is the "tab sync" recovery path for sessions that were not captured via the content script.

**Function names and line numbers:**

- `service-worker.ts:1504–1541` — `syncOpenTabs()` function
- `service-worker.ts:1544–1635` — `scrapeSessionFromPage(platform)` function
- `service-worker.ts:1560–1619` — the conditional chain inside `scrapeSessionFromPage`
- `service-worker.ts:232–239` — `PLATFORM_URLS` constant

**Exact broken code — `PLATFORM_URLS` declaration (`service-worker.ts:232–239`):**

```typescript
const PLATFORM_URLS = {
  claude:     ["https://claude.ai/*"],
  chatgpt:    ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  gemini:     ["https://gemini.google.com/*"],
  grok:       ["https://grok.com/*", "https://grok.x.ai/*"],
  perplexity: ["https://www.perplexity.ai/*"],
  deepseek:   ["https://chat.deepseek.com/*"],
} as const;
```

**Exact broken code — `scrapeSessionFromPage` conditional chain (`service-worker.ts:1560–1619`):**

```typescript
  if (platform === "chatgpt") {
    messages = Array.from(
      document.querySelectorAll<HTMLElement>("[data-message-author-role]")
    )
      ...
  } else if (platform === "claude") {
    ...
  } else if (platform === "gemini") {
    ...
  } else if (platform === "grok") {
    ...
  }

  if (messages.length === 0) {
    return null;
  }
```

**What it actually does wrong:**  
`syncOpenTabs()` calls `scrapeSessionFromPage(platform)` for all 6 platform keys. Inside `scrapeSessionFromPage`, the `if/else if` chain handles only `chatgpt`, `claude`, `gemini`, and `grok`. When `platform === "perplexity"` or `platform === "deepseek"`, no branch executes — `messages` remains `[]` — and the function returns `null`. Back in `syncOpenTabs()`, `snapshot` is `null`, `continue` is reached, and the tab is silently skipped. All perplexity and deepseek tabs are never recovered via the `syncOpenTabs` path.

**Related files touching the same logic:**
- `service-worker.ts:1519–1536` — the null-check guard in `syncOpenTabs` that silently skips `null` results
- `src/content/perplexity.ts` — the actual content script does have a multi-strategy `scrapeMessages`; this is a separate, independent implementation in the SW that simply omits those platforms
- `src/content/deepseek.ts` — same as above

---

## Issue 4

### `CAPTURE_HEALTH` Alert Threshold Mismatch (0.7 in SW vs 0.8 in `health-monitor.ts`)

**Files involved:**
- `packages/browser-extension/src/background/service-worker.ts`
- `packages/browser-extension/src/lib/capture/health-monitor.ts`

**What the code is supposed to do:**  
There are two code paths that store capture quality alerts in `chrome.storage.local` under the key `alert_${platform}`. Both are intended to implement the same "capture health monitoring" feature: fire an alert when the capture success rate drops below a defined threshold over the last 10 samples (minimum 3 samples required).

**Function names and line numbers:**

- `service-worker.ts:885–918` — `case "CAPTURE_HEALTH":` handler
- `service-worker.ts:900–915` — threshold check and storage write
- `health-monitor.ts:1–113` — `CaptureHealthMonitor` class
- `health-monitor.ts:83–97` — `checkHealth()` private method
- `health-monitor.ts:86` — `private readonly ALERT_THRESHOLD = 0.8`

**Exact broken code — service worker (`service-worker.ts:900–914`):**

```typescript
        const successRate = history.filter(Boolean).length / history.length;
        if (successRate < 0.7 && history.length >= 3) {
          console.warn(
            `[CM:health] ${hPlatform} capture rate: ${(successRate * 100).toFixed(0)}% — selectors may be broken`
          );
          await chrome.storage.local.set({
            [`alert_${hPlatform}`]: {
              platform: hPlatform,
              successRate,
              timestamp: Date.now(),
              message: `Capture quality dropped on ${hPlatform}. Assistant messages may be missing.`,
            },
          });
        } else {
          await chrome.storage.local.remove(`alert_${hPlatform}`);
        }
```

**Exact broken code — health-monitor.ts (`health-monitor.ts:83–97`):**

```typescript
  private readonly ALERT_THRESHOLD = 0.8;

  ...

  private async checkHealth(platform: string, history: HealthRecord[]): Promise<void> {
    if (history.length < 3) return;
    const successRate = history.filter((r) => r.success).length / history.length;
    if (successRate < this.ALERT_THRESHOLD) {
      const alert: CaptureAlert = {
        platform,
        successRate,
        timestamp: Date.now(),
        message: `Capture quality dropped on ${platform}. Some messages may be missing.`,
      };
      await chrome.storage.local.set({ [`alert_${platform}`]: alert });
    }
  }
```

**What it actually does wrong:**  
The two code paths use different threshold values for the same conceptual check:
- `service-worker.ts` fires at `successRate < 0.7` (70%)
- `health-monitor.ts` fires at `successRate < 0.8` (80%)

A capture success rate of 75% would trigger an alert from `health-monitor.ts` but NOT from the SW handler. A rate of 65% would trigger the SW handler alert but also sets it via `health-monitor.ts`. Additionally:
- The SW handler's `else` branch **removes** the alert key when `successRate >= 0.7`, even if `health-monitor.ts` had stored an alert at 75%
- `health-monitor.ts` has no corresponding "remove alert on recovery" logic
- Both write to the same storage key `alert_${platform}` with different message strings, so whichever runs last wins

**Related files touching the same logic:**
- `src/sidebar/Sidebar.tsx` — reads `alert_${platform}` from storage to display the UI banner
- `src/lib/capture/health-monitor.ts:56–80` — `record()` method calls `checkHealth()` and maintains a sliding window in `HealthRecord[]`

---

## Issue 5

### `busy` Flag Not Visually Reset Before SW-Sleeping Retry Window

**Files involved:**
- `packages/browser-extension/src/content/sidebar-toggle/toggle.ts`

**What the code is supposed to do:**  
When the user clicks the toggle button, `busy` is set to `true` and `updateBtn()` is called to apply the busy CSS class. When the service worker responds (or when both attempts fail), `busy` is cleared and `updateBtn()` is called to remove the busy class. During the entire async window, the button should reject further clicks via the `if (busy) return` guard.

**Function names and line numbers:**

- `toggle.ts:93–137` — `btn.addEventListener("click", ...)` handler
- `toggle.ts:98–100` — `busy` set and `updateBtn()` called
- `toggle.ts:106–136` — `chrome.runtime.sendMessage` callback

**Exact broken code (`toggle.ts:106–136`):**

```typescript
    chrome.runtime.sendMessage(
      { type: "TOGGLE_SIDEBAR" },
      (res) => {
        busy = false;

        if (chrome.runtime.lastError) {
          // SW was sleeping — wake it up and retry
          console.warn("[CM:toggle] SW sleeping, retrying...");
          setTimeout(() => {
            chrome.runtime.sendMessage(
              { type: "TOGGLE_SIDEBAR" },
              (retryRes) => {
                if (chrome.runtime.lastError) {
                  // Both failed — revert
                  isOpen = !isOpen;
                  updateBtn();
                  return;
                }
                isOpen = retryRes?.isOpen ?? isOpen;
                updateBtn();
              }
            );
          }, 150); // Short retry — SW wakes fast
          return;
        }

        // Confirm actual state from SW
        isOpen = res?.isOpen ?? isOpen;
        updateBtn();
      }
    );
```

**What it actually does wrong:**  
`busy = false` is set at the very top of the callback, **before** the `chrome.runtime.lastError` check. On the SW-sleeping code path, `busy` is set to `false` and then `return` is reached without calling `updateBtn()`. The button's visual busy state is never cleared (since `updateBtn()` was not called), but `busy` is now `false`, meaning the `if (busy) return` guard at the top of the click handler will not block a second click. A user can click the button again during the 150ms `setTimeout` window, triggering a second `TOGGLE_SIDEBAR` message concurrently with the pending retry. The second click will also flip `isOpen` optimistically before the first retry has resolved, leaving `isOpen` out of sync with the actual panel state when both callbacks eventually fire.

**Related files touching the same logic:**
- `toggle.ts:88–91` — `updateBtn()` function that applies `cf-toggle--busy` class
- `toggle.ts:98–104` — the initial `busy = true` + `updateBtn()` + optimistic `isOpen` flip on click

---

## Issue 6

### `buildMetaPromptAsync` Overwrites All MetaPrompts With Same Primary Key; `getMetaPrompt` Ignores `platform` and `tier` Parameters

**Files involved:**
- `packages/browser-extension/src/background/service-worker.ts`
- `packages/browser-extension/src/lib/db.ts`

**What the code is supposed to do:**  
`buildMetaPromptAsync` is called after every debounced session write to pre-build migration prompts for all 6 platforms × 2 tiers = 12 distinct MetaPrompt records per session. These are stored in IndexedDB so that `handleMigrateContext` can retrieve the correct pre-built prompt for the requested platform and tier without re-computing it.

**Function names and line numbers:**

- `service-worker.ts:1240–1306` — `buildMetaPromptAsync(session)` function
- `service-worker.ts:1270–1278` — tier-1 `db.saveMetaPrompt` call
- `service-worker.ts:1291–1299` — tier-2 `db.saveMetaPrompt` call
- `db.ts:227` — `metaPrompts` table schema definition
- `db.ts:285–287` — `saveMetaPrompt` implementation
- `db.ts:289–294` — `getMetaPrompt` implementation

**Exact broken code — IDB schema (`db.ts:217–228`):**

```typescript
    // ── v5: + metaPrompts store (pre-built migration prompts) ──
    // Indexed by sessionId for fast lookup during migration.
    this.version(5).stores({
      sessions: "id, platform, updatedAt",
      ...
      metaPrompts: "id, platform, tier, builtAt",
    });
```

**Exact broken code — `saveMetaPrompt` (`db.ts:285–287`):**

```typescript
  async saveMetaPrompt(metaPrompt: MetaPrompt): Promise<void> {
    await dexieDb.metaPrompts.put(metaPrompt);
  },
```

**Exact broken code — `buildMetaPromptAsync` tier-1 write (`service-worker.ts:1270–1278`):**

```typescript
      await db.saveMetaPrompt({
        id: session.id,
        platform: target,
        tier: 1,
        prompt: tier1Prompt,
        compressionRatio: tier1Compression,
        builtAt: Date.now(),
        messageCount: session.messages.length,
      });
```

**Exact broken code — `buildMetaPromptAsync` tier-2 write (`service-worker.ts:1291–1299`):**

```typescript
      await db.saveMetaPrompt({
        id: session.id,
        platform: target,
        tier: 2,
        prompt: tier2Prompt,
        compressionRatio: tier2Compression,
        builtAt: Date.now(),
        messageCount: session.messages.length,
      });
```

**Exact broken code — `getMetaPrompt` (`db.ts:289–294`):**

```typescript
  async getMetaPrompt(sessionId: string, platform?: string, tier?: 1 | 2 | 3): Promise<MetaPrompt | undefined> {
    if (platform && tier !== undefined) {
      return dexieDb.metaPrompts.get(sessionId);
    }
    return dexieDb.metaPrompts.get(sessionId);
  },
```

**What it actually does wrong:**  
The `metaPrompts` Dexie table is declared with `"id"` as its primary keyPath. All 12 calls to `db.saveMetaPrompt` use `id: session.id` — the same value. Dexie's `put()` performs an upsert keyed by the primary key. Each successive call overwrites the previous record. After the loop completes across all 6 platforms and 2 tiers, only the **last** MetaPrompt written (tier 2 for the last platform, which happens to be `perplexity` based on the `targets` array order) survives in IndexedDB. All 11 prior records are silently discarded.

Additionally, `getMetaPrompt(sessionId, platform, tier)` ignores `platform` and `tier` entirely — both branches of the `if` statement execute `dexieDb.metaPrompts.get(sessionId)` regardless of the arguments. The `if (platform && tier !== undefined)` branch adds no different logic. Any caller expecting platform/tier-specific lookup receives the one surviving record (wrong platform/tier) or `undefined`.

**Related files touching the same logic:**
- `service-worker.ts:1256` — `targets` array defines the order of the loop: `["claude", "chatgpt", "gemini", "grok", "deepseek", "perplexity"]`
- `src/lib/types.ts` — `MetaPrompt` type definition (not read; unclear if `id` is typed as composite)

---

## Issue 7

### `context-builder.ts` XML Format Does Not CDATA-Wrap File Content

**Files involved:**
- `packages/browser-extension/src/lib/file-system/context-builder.ts`

**What the code is supposed to do:**  
`buildXml()` constructs an XML block containing selected project files for inclusion in Claude migration prompts. Each file's path, language, and content are embedded as a `<file>` XML element. The output is later injected into the migration prompt and uploaded to Claude.

**Function names and line numbers:**

- `context-builder.ts:74–89` — `buildXml(files, rootName, fileTreeText)` private method
- `context-builder.ts:75–77` — `fileTags` template literal

**Exact broken code (`context-builder.ts:74–79`):**

```typescript
  private buildXml(files: ProjectFile[], rootName: string, fileTreeText: string): string {
    const fileTags = files.map((f) =>
      `    <file path="${f.path}" language="${f.language}" size="${this.formatSize(f.size)}">\n${f.content}\n    </file>`
    ).join("\n");
```

**What it actually does wrong:**  
`f.content` is interpolated directly into the XML string with no escaping and no `<![CDATA[...]]>` wrapper. Source code files routinely contain characters that are illegal unescaped in XML element content:
- `<` and `>` — present in TypeScript generics, JSX, comparison operators, HTML templates
- `&` — present in logical operators (`&&`), HTML entities, string literals
- Literal `</file>` sequences — any file containing `</file>` in a string literal or comment terminates the XML element prematurely, causing a parse error and truncating all remaining file content

Additionally, `f.path` is also unescaped in the `path="..."` XML attribute, meaning paths containing `"` or `<` would break the attribute syntax.

The tier-1 and tier-2 file builders (`buildTier1File`, `buildTier2File`) in `file-builder.ts` correctly use `<![CDATA[...]]>` for message content. `context-builder.ts` is inconsistent with this established pattern.

**Related files touching the same logic:**
- `src/lib/file-builder.ts:51–82` — `buildTier1File` uses `<![CDATA[...]]>` correctly for message content
- `src/sidebar/MigrationModal.tsx:692–700` — calls `fileContextBuilder.buildProjectContext(...)` and passes result as `projectContext` in the `MIGRATE_CONTEXT` payload
- `service-worker.ts:1448–1455` — `handleMigrateContext` receives `payload.projectContext` and includes it in the instruction prompt

---

## Issue 8

### `setPanelBehavior` Called Twice With Contradictory Values Across SW Lifecycle Events

**Files involved:**
- `packages/browser-extension/src/background/service-worker.ts`

**What the code is supposed to do:**  
The extension intends to disable Chrome's built-in toolbar-icon-click-to-open side panel behavior (`openPanelOnActionClick: false`) so that the in-page toggle button is the only mechanism that opens/closes the sidebar. The `action.onClicked` listener at line 358 is registered as a fallback to explicitly call `sidePanel.open()` when `openPanelOnActionClick: false`.

**Function names and line numbers:**

- `service-worker.ts:298–300` — module-level `setPanelBehavior` call (runs on every SW start)
- `service-worker.ts:318–320` — `onInstalled` handler `setPanelBehavior` call
- `service-worker.ts:356–363` — `chrome.action.onClicked` listener

**Exact broken code — module-level call (`service-worker.ts:297–300`):**

```typescript
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err: unknown) => console.warn("[ContextMover] setPanelBehavior failed:", err));
```

**Exact broken code — `onInstalled` call (`service-worker.ts:318–320`):**

```typescript
  // Disable Chrome's built-in click-to-open side panel — our toggle button handles it.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
    .catch((e) => console.warn("[CM:sw] setPanelBehavior failed:", e));
```

**Exact broken code — `action.onClicked` listener (`service-worker.ts:357–363`):**

```typescript
// Fallback: explicitly open the panel when the toolbar icon is clicked.
// Handles edge cases where setPanelBehavior alone isn't triggered.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id == null) return;
  chrome.sidePanel
    .open({ tabId: tab.id })
    .catch((err: unknown) => console.warn("[ContextMover] sidePanel.open failed:", err));
});
```

**What it actually does wrong:**  
The service worker module-level code (lines 297–300) runs on **every** SW start (cold start, SW restart after sleep, update). It sets `openPanelOnActionClick: true`. The `onInstalled` handler (lines 318–320) runs only on extension install/update and sets `openPanelOnActionClick: false`.

After a service worker sleep/restart with no install/update event:
- Only the module-level `true` call executes
- Chrome's built-in click-to-open is **enabled**
- When `openPanelOnActionClick: true`, Chrome intercepts toolbar icon clicks and opens the panel without firing `action.onClicked`
- The `action.onClicked` fallback listener is never triggered
- The toolbar icon click bypasses the toggle button logic entirely

After a fresh install or update:
- Both calls run; `onInstalled` (`false`) runs after module-level (`true`)
- The final state is `false` — correct behavior
- `action.onClicked` fires on toolbar icon click and explicitly calls `sidePanel.open()`

The behavior is therefore inconsistent across SW lifecycle states. After SW sleep/restart (the most common scenario for long-running browser sessions), `openPanelOnActionClick: true` means the toolbar icon opens the sidebar without going through the `TOGGLE_SIDEBAR` message path, bypassing any state synchronization.

**Related files touching the same logic:**
- `toggle.ts:106–136` — the toggle button click sends `TOGGLE_SIDEBAR` to the SW; this is unaffected by `setPanelBehavior` since the toggle button is in the page, not the toolbar

---

## Issue 9

### `sendMessageToTab` Called With Non-Null Assertion on Optional `targetTabId`

**Files involved:**
- `packages/browser-extension/src/background/service-worker.ts`

**What the code is supposed to do:**  
`handleMigrateContext` sends the final instruction prompt to the target platform tab via `sendMessageToTab`. The target tab ID is supplied by the sidebar via `payload.targetTabId`. The function uses this ID to call `chrome.tabs.sendMessage(tabId, ...)` to reach the content script in the target tab.

**Function names and line numbers:**

- `service-worker.ts:1361–1501` — `handleMigrateContext(payload, sendResponse, accessToken)` function
- `service-worker.ts:1362–1376` — payload type definition showing `targetTabId?: number`
- `service-worker.ts:1459–1468` — `sendMessageToTab` call site with non-null assertion
- `service-worker.ts:1752–1826` — `sendMessageToTab(tabId, message)` function body

**Exact broken code — payload type (`service-worker.ts:1361–1376`):**

```typescript
async function handleMigrateContext(
  payload: {
    sessionId: string;
    targetPlatform: string;
    targetTabId?: number;
    tier?: 1 | 2 | 3;
    caveman?: boolean;
    task?: string;
    strength?: "light" | "strict";
    useAttentionEngine?: boolean;
    precomputedSummary?: string;
    precomputedAttentionMap?: unknown;
    promptTemplateId?: string | null;
    projectContext?: string | null;
  },
```

**Exact broken code — call site (`service-worker.ts:1459–1468`):**

```typescript
  let injected = false
  try {
    const result = await sendMessageToTab(payload.targetTabId!, {
      type: 'INJECT_CONTEXT',
      prompt: instructionPrompt,
      platform: payload.targetPlatform
    })
    injected = result.ok
  } catch (err) {
    console.warn('[CM:sw] Injection failed (non-fatal):', err)
  }
```

**Exact broken code — `sendMessageToTab` first usage of `tabId` (`service-worker.ts:1765–1770`):**

```typescript
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, message) as Promise<unknown>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Injection timed out after 10s")), ATTEMPT_TIMEOUT_MS)
        ),
      ]);
```

**What it actually does wrong:**  
`targetTabId` is declared as `targetTabId?: number` — an optional field. The `!` non-null assertion at `payload.targetTabId!` tells TypeScript to treat it as `number`, suppressing the compile-time error. At runtime, if `targetTabId` is `undefined` (which is valid per the type), `sendMessageToTab(undefined, ...)` is called. Inside `sendMessageToTab`, `tabId` is `undefined`. `chrome.tabs.sendMessage(undefined, message)` either throws a type error or Chrome interprets `undefined` as an invalid tab ID and rejects with a runtime error. The `catch (err)` block at the call site swallows this error with a non-fatal warning, so `injected` remains `false` — the migration silently fails to inject the prompt, but the user receives a `{ success: true }` response regardless, since injection failure is treated as non-fatal.

**Related files touching the same logic:**
- `src/sidebar/MigrationModal.tsx:702–731` — sends the `MIGRATE_CONTEXT` message; always includes `targetTabId: tab.id` (line 708), but the tab lookup could theoretically fail before this point
- `src/sidebar/MigrationModal.tsx:665–672` — the tab lookup: if `tab?.id` is null, an error is shown and the migration is aborted before reaching the SW call — so in practice `targetTabId` may always be present from the sidebar
- `service-worker.ts:1460` — the `!` assertion is the point of failure if called from any other path without `targetTabId`

---

## Issue 10

### `claude.ts` Structural Fallback Assigns Roles by DOM Index Parity

**Files involved:**
- `packages/browser-extension/src/content/claude.ts`

**What the code is supposed to do:**  
When all primary and secondary CSS selectors in `scrapeMessages()` return no results, `detectByStructure()` provides a last-resort fallback. It finds the main chat container element, enumerates its direct children with sufficient text content, and assigns `user` or `assistant` roles based on their position — the assumption being that chat messages alternate starting with the user.

**Function names and line numbers:**

- `claude.ts:54–86` — `scrapeMessages()` function
- `claude.ts:91–114` — `detectByStructure()` function
- `claude.ts:99–113` — loop that assigns roles by parity
- `claude.ts:116–131` — `findChatContainer()` function

**Exact broken code (`claude.ts:91–114`):**

```typescript
function detectByStructure(): Message[] {
  const container = findChatContainer();
  if (!container) return [];

  const children = Array.from(container.children).filter(
    (el) => (el.textContent?.trim().length ?? 0) > 10
  );

  const messages: Message[] = [];
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as HTMLElement;
    if (isStreaming(el)) continue;
    const content = extractMessageContent(el);
    if (!content) continue;
    // Even indices = user, odd = assistant (typical chat layout)
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content,
      timestamp: Date.now(),
    });
  }

  return messages;
}
```

**Exact broken code — `findChatContainer` selectors (`claude.ts:116–131`):**

```typescript
function findChatContainer(): Element | null {
  const selectors = [
    'main',
    '[role="main"]',
    '.conversation',
    '[class*="conversation"]',
    '[class*="messages"]',
    '[class*="chat"]',
    '[data-test-render-count]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.children.length > 2) return el;
  }
  return null;
}
```

**What it actually does wrong:**  
The loop assigns `role: i % 2 === 0 ? "user" : "assistant"`. This hardcodes the assumption that the **first substantive child** of the chat container is always a user message. Claude's DOM may include:
- A greeting preamble or "Welcome to Claude" system card (index 0 → labeled `user`)
- An "Upgrade to Pro" banner (index 0 → labeled `user`, pushes real first user message to index 1 → labeled `assistant`)
- Thinking/reasoning blocks that appear as separate container children before or between turns

Additionally, the `findChatContainer` selectors include `'main'` and `'[role="main"]'` — broad selectors that on Claude's page contain the full application shell, not just the message list. `el.children.length > 2` is the only guard, but the main element may have dozens of children including navigation, input fields, and toolbars. All of these with `textContent.length > 10` would be included in the enumeration and assigned alternating roles. Messages that are streaming (`isStreaming(el)` is `true`) are skipped with `continue`, but this does **not** decrement `i`, so subsequent messages are assigned the parity of the position after the skipped streaming element — potentially assigning `assistant` to the next user message.

**Related files touching the same logic:**
- `claude.ts:133–137` — `startSessionCapture` passes `scrapeMessages: () => runCapturePipeline("claude", scrapeMessages)` — `detectByStructure()` is called only within `scrapeMessages()` directly (not via `runCapturePipeline`)
- `src/lib/capture/structural-detector.ts` — a separate, more sophisticated structural detector exists in `lib/` but is NOT used by `claude.ts`; `claude.ts` implements its own inline fallback independently
- `src/content/shared.ts` — `runCapturePipeline` applies `validateCapture` after scraping; role-swapped messages may pass validation if counts still balance

---

*End of audit report. 10 issues documented. No fixes applied.*
