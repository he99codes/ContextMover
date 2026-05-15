# CAPTURE_DRAGDROP_DIAGNOSTIC.md

---

## Problem A — Capture Fluctuation

### A1 — Capture Triggers (all of them)

**DOM path — `src/content/shared.ts` inside `startSessionCapture`:**

- `shared.ts:323` MutationObserver via `createObserver(config.selectorOrElement, capture)` — 150ms debounce, `childList+subtree+characterData`
- `shared.ts:326` Immediate `void capture()`
- `shared.ts:327–332` `setTimeout(capture, 100/500/1000/1500/3000/6000)`
- `shared.ts:333` `window.addEventListener("load", capture, { once: true })`
- `shared.ts:336–340` `visibilitychange` → `setTimeout(capture, 300)` when tab visible
- `shared.ts:343` `popstate` → `setTimeout(capture, 500)`
- `shared.ts:347–350` `scroll` → debounced `setTimeout(capture, 800)`
- `shared.ts:354–360` Second MutationObserver on `document` for URL change → `setTimeout(capture, 800/2000/4000)`
- `shared.ts:224–244` Stream-end poll `setInterval(500ms)` → `setTimeout(capture, 500)` after streaming stops. Hard 60s cap.

**Network path — sends `CAPTURE_SESSION` directly, bypasses `capture()`:**

- `chatgpt.ts:90–98` `window.addEventListener('__CM_CHATGPT_CONVERSATION__', ...)` → `sendCapture()` when inline page-world fetch interceptor sees `/backend-api/conversation/` response
- `interceptor-bridge.ts:90–192` `window.addEventListener("contextmover:captured", ...)` receives `CustomEvent` from `fetch-interceptor.ts` for all platforms

---

### A2 — MutationObserver callback (exact code)

`src/content/shared.ts:24–59`

```ts
export function createObserver(
  selectorOrElement: string | Element,
  callback: () => void,
  debounceMs = 150
): MutationObserver {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedCallback = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(callback, debounceMs);
  };
  const observer = new MutationObserver(debouncedCallback);
  function attach() {
    const target =
      typeof selectorOrElement === "string"
        ? document.querySelector(selectorOrElement) ?? document.body
        : selectorOrElement;
    if (!target) {
      document.addEventListener("DOMContentLoaded", attach, { once: true });
      return;
    }
    observer.observe(target, { childList: true, subtree: true, characterData: true });
  }
  attach();
  return observer;
}
```

The callback (`debouncedCallback`) receives the `MutationRecord[]` array but **ignores it**. It calls the outer `capture()` which re-scrapes all `[data-message-author-role]` elements in the full DOM at that moment. It does NOT process only newly-added nodes.

---

### A3 — Initial page load scrape

`shared.ts:326–333`. First `capture()` fires at 0ms immediately when `startSessionCapture` runs, then at 100/500/1000/1500/3000/6000ms, then on `window.load`. No gate waits for full render. The 0ms and 100ms calls frequently run against an incompletely-rendered conversation.

There is no mechanism that says "wait until all messages are in the DOM before running the first scrape."

---

### A4 — Virtual scroll handling

Only one mechanism exists (`shared.ts:346–350`):

```ts
window.addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => void capture(), 800);
}, { passive: true });
```

There is NO code that:
- detects when ChatGPT removes old DOM nodes during downward scroll (virtual scroll eviction)
- merges messages captured at different scroll positions
- accumulates a running total across multiple `scrapeMessages()` calls

Each call to `scrapeMessages()` in `chatgpt.ts:9` does `document.querySelectorAll('[data-message-author-role]')` which returns only what is physically in the DOM at that instant. If ChatGPT has evicted older messages from the DOM, they are gone from that scrape.

---

### A5 — Deduplication logic in SW

`src/background/service-worker.ts:988–1079` — `handleCaptureSession`

**In-flight lock** (`sw:997–1003`): Prevents same session being processed twice within 2.2s:
```ts
if (captureInFlight.has(payload.sessionId)) {
  console.log(`Skipped in-flight duplicate for session ${payload.sessionId}`);
  return;
}
captureInFlight.add(payload.sessionId);
setTimeout(() => captureInFlight.delete(payload.sessionId), 2_200);
```

**Debounced write** (`sw:1033–1055`): Within 200ms, only the last write for a session fires to IDB:
```ts
pendingWrites.set(session.id, session);
const existingTimer = writeTimers.get(session.id);
if (existingTimer !== undefined) clearTimeout(existingTimer);
writeTimers.set(session.id, setTimeout(async () => {
  const toWrite = pendingWrites.get(session.id);
  await db.saveSession(toWrite);
  ...
}, 200));
```

**There is NO "take the highest message count" logic.** When a `CAPTURE_SESSION` arrives with a lower count than previously stored, `handleCaptureSession` unconditionally overwrites with `payload.messages`. `db.saveSession` replaces the stored session. The stored message array becomes whatever the latest payload contained, regardless of whether it has fewer messages than a previous capture.

**Content-script-side dedup** (`shared.ts:281–303`): The content script has a `hashMessages` guard and a `MIN_SEND_INTERVAL_MS = 2000` guard, but these only prevent re-sending the *same* hash. A new (smaller) scrape with a different hash is sent immediately.

---

### A6 — Scroll warning trigger condition

`src/sidebar/Sidebar.tsx:725`:

```tsx
{selected && selected.messages.length < 15 && (
  <div ...>
    ⚠️ Only {selected.messages.length} messages captured.
    <br />
    Scroll to the top of the conversation to load all messages,
    then the extension will capture them automatically.
  </div>
)}
```

**Condition**: `selected.messages.length < 15`
**Threshold**: hardcoded `15` messages. No configuration. Fires whenever the currently-selected session has fewer than 15 captured messages.

---

### A7 — Network layer capture status

**PRESENT. Two separate network-capture systems exist:**

**System 1 — `fetch-interceptor.ts` (MAIN world, all platforms)**
`src/content/fetch-interceptor.ts` — 990 lines. Overrides `window.fetch` in the page's JS context. Platforms and endpoints watched:

```ts
// src/content/fetch-interceptor.ts:93–105
function detectPlatform(url: string): Platform | null {
  if (url.includes("chatgpt.com/backend-api/conversation") ||
      url.includes("chat.openai.com/backend-api/conversation")) return "chatgpt";
  if ((url.includes("claude.ai/api") && /completion|append_message|chat_conversations/.test(url)) ||
      ((url.includes("a-api.anthropic.com") || url.includes("api.anthropic.com")) && /\/v1\//.test(url))) return "claude";
  if (url.includes("gemini.google.com") && /GenerateContent|StreamGenerate|BardChatUi|assistant\.lamda/i.test(url)) return "gemini";
  if (url.includes("grok.com/api") && /chat|conversation|completion/i.test(url)) return "grok";
  ...
}
```

Dispatches `CustomEvent("contextmover:captured", { detail: { platform, messages, metadata, fullHistory } })` on `window`. `fullHistory=true` when a conversation-load GET returns full JSON mapping (ChatGPT) or `chat_messages` array (Claude).

**System 2 — inline script in `chatgpt.ts`**
`src/content/chatgpt.ts:30–59`. Injects a `<script>` into the page that overrides `window.fetch` separately and dispatches `CustomEvent("__CM_CHATGPT_CONVERSATION__", { detail })` for `/backend-api/conversation/` responses containing `data.mapping`.

**Both systems coexist for ChatGPT.** The interceptor-bridge reads `contextmover:captured`; chatgpt.ts reads `__CM_CHATGPT_CONVERSATION__`. Both can send `CAPTURE_SESSION` for the same ChatGPT conversation.

**Bridge** (`src/content/interceptor-bridge.ts`) reads `contextmover:captured` for all platforms and sends `CAPTURE_SESSION`. Also sets `window.__contextForgeFetchCaptured = { at: Date.now(), count: merged.length }` (`interceptor-bridge.ts:158`), which the DOM `capture()` path checks (`shared.ts:204–211`) to skip DOM scraping when a network capture arrived within the last 60s.

---

### A8 — Full ChatGPT capture flow (page load → first CAPTURE_SESSION)

**Files involved in order:**

1. **`src/content/fetch-interceptor.ts`** — injected as MAIN-world content script at `document_start`
   - Overrides `window.fetch`. On any response matching `chatgpt.com/backend-api/conversation`, parses SSE or JSON, dispatches `CustomEvent("contextmover:captured", ...)` on `window`.

2. **`src/content/chatgpt.ts`** — injected as ISOLATED-world content script
   - Calls `installFetchInterceptor()` (`chatgpt.ts:30–60`): injects inline `<script>` that also overrides `window.fetch` for `__CM_CHATGPT_CONVERSATION__` events (second separate interceptor, line 32–59)
   - Calls `startSessionCapture({ platform:"chatgpt", selectorOrElement:"main", scrapeMessages: ... })` (`chatgpt.ts:103–107`)
   - Registers `window.addEventListener('__CM_CHATGPT_CONVERSATION__', ...)` (`chatgpt.ts:90–98`)

3. **`src/content/interceptor-bridge.ts`** — injected as ISOLATED-world content script
   - Registers `window.addEventListener("contextmover:captured", ...)` (`bridge:90`)
   - On event: validates, merges with accumulator, sets `window.__contextForgeFetchCaptured`, sends `chrome.runtime.sendMessage({ type:"CAPTURE_SESSION", ... })`

4. **`src/content/shared.ts:startSessionCapture`** — DOM path
   - `void capture()` fires immediately at t=0
   - Checks `window.__contextForgeFetchCaptured` — if a network capture happened within 60s, DOM scrape is skipped (`shared.ts:204–211`)
   - If no network capture yet: calls `scrapeMessages()` → `document.querySelectorAll('[data-message-author-role]')` → filters streaming nodes → `extractContent()` → returns `Message[]`
   - If messages found and hash changed and ≥2s since last send: calls `ensureSessionId()` → `resolveSessionId("chatgpt", location.href)` → sends `CAPTURE_SESSION`

5. **`src/background/service-worker.ts:handleCaptureSession`** (`sw:988`)
   - Validates sender is a known platform tab
   - In-flight dedup check (2.2s lock)
   - Debounced 200ms write to IDB via `db.saveSession()`
   - Broadcasts `SESSIONS_UPDATED` to sidebar
   - Kicks off `backgroundIndex()` and `buildMetaPromptAsync()`

---

## Problem B — Drag Drop

### B1 — File creation and storage

Migration file is built in `src/background/service-worker.ts:handleMigrateContext` (lines 1216–1404):

```ts
// sw:1246–1298
if (tier === 1) {
  migrationFile = buildTier1File(session)
} else if (tier === 2) {
  migrationFile = buildTier2File(session, summary, payload.task)
} else {
  migrationFile = buildTier3File(session, chunks, payload.task)
}
```

`buildTier1File`, `buildTier2File`, `buildTier3File` are from `src/lib/file-builder.ts`.

After build, stored **in the SW in-memory Map** (`sw:1374–1385`):
```ts
const cacheKey = makeCacheKey(session.id, tier)  // "${sessionId}-tier${tier}"
migrationFileCache.set(cacheKey, {
  filename: migrationFile.filename,
  content: migrationFile.content,   // plain string (XML text)
  charCount: migrationFile.charCount,
  estimatedTokens: migrationFile.estimatedTokens,
  tier, platform, sessionTitle,
  cachedAt: Date.now(),
  sessionId: session.id
})
```

**Format**: plain `string` containing XML. TTL: 30 minutes (`FILE_CACHE_TTL_MS = 30 * 60 * 1000`). **Not a Blob. Not a URL. Not IndexedDB.** Stored only in the SW process's `migrationFileCache` Map.

---

### B2 — GET_CACHED_FILE return value

`src/background/service-worker.ts:907–915`:

```ts
case "GET_CACHED_FILE": {
  const entry = migrationFileCache.get(msg.cacheKey)
  if (!entry) {
    sendResponse({ success: false, error: 'File not in cache or expired' })
    break
  }
  sendResponse({ success: true, file: entry })
  break
}
```

Returns `{ success: true, file: entry }` where `entry` is the full `CachedMigrationFile` object including `content: string` (the raw XML text). Not a Blob, not a URL, not a File object.

The sidebar reads it as (`MigrationModal.tsx:135–145`):
```ts
async function getFileContent(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'GET_CACHED_FILE', cacheKey },
      (response) => {
        if (response?.success) resolve(response.file.content)
        else resolve(null)
      }
    )
  })
}
```

`response.file.content` is the raw XML string.

---

### B3 — Drag zone dataTransfer code

`src/sidebar/MigrationModal.tsx:273–291`:

```tsx
<a
  href={fileObjectUrl || undefined}
  download={migrationFile.filename}
  draggable={true}
  onDragStart={(e) => {
    if (fileContent) {
      try {
        const file = new File([fileContent], migrationFile.filename, { type: 'application/xml' })
        e.dataTransfer.items.add(file)
      } catch { /* dataTransfer.items may be unavailable — fallback to href drag */ }
    }
    e.dataTransfer.effectAllowed = 'copy'
    setDragging(true)
  }}
  onDragEnd={() => {
    setDragging(false)
    setDropped(true)
    deleteCachedFile()
  }}
```

`dataTransfer.items.add(file)` is called with a `File` object constructed from the XML string content. The fallback (when `items.add` throws) is the anchor's `href={fileObjectUrl}` — a `blob:` URL created at `MigrationModal.tsx:178`:

```ts
const blob = new Blob([content], { type: 'application/xml' })
const url = URL.createObjectURL(blob)
setFileObjectUrl(url)
```

---

### B4 — File construction options

The code already constructs a `File` object (`MigrationModal.tsx:280`):
```ts
const file = new File([fileContent], migrationFile.filename, { type: 'application/xml' })
e.dataTransfer.items.add(file)
```

`DataTransfer.items.add(File)` is available in extension sidepanel contexts (Chrome 105+). The `try/catch` silently falls back to anchor-href drag if it throws.

The anchor-href fallback uses `URL.createObjectURL(blob)` (line 178), which produces a `blob:chrome-extension://...` URL. ChatGPT's drop handler cannot read a `blob:chrome-extension://` URL from a different origin.

---

### B5 — ChatGPT drop handler expectation

⚠️ UNCLEAR — ChatGPT's drop handler is not part of this codebase. The extension does not contain any code that inspects ChatGPT's drop handler.

What is observable from the symptom: ChatGPT shows the dropped item as a "document attachment with filename text" rather than an uploaded file. This is consistent with ChatGPT receiving a plain text string from `dataTransfer.getData("text/plain")` or `dataTransfer.getData("text/uri-list")` instead of an entry from `dataTransfer.files` or `dataTransfer.items` with `kind === "file"`.

The `dataTransfer.items.add(File)` path should in theory populate `dataTransfer.files`. Whether Chrome actually exposes `dataTransfer.files` across a cross-origin drag from an extension sidebar to a web page is ⚠️ UNCLEAR from this codebase alone.

---

### B6 — DELETE_CACHED_FILE timing

`src/background/service-worker.ts:917–922`:
```ts
case "DELETE_CACHED_FILE": {
  migrationFileCache.delete(msg.cacheKey)
  sendResponse({ success: true })
  break
}
```

Called from two places in `src/sidebar/MigrationModal.tsx`:

1. `onDragEnd` (`MigrationModal.tsx:287–291`): fires when the drag gesture ends (drop or cancel), **after** the drag:
```ts
onDragEnd={() => {
  setDragging(false)
  setDropped(true)
  deleteCachedFile()   // ← called here
}}
```

2. `handleManualDownload` (`MigrationModal.tsx:154–168`): fires when the Download button is clicked, after the anchor click:
```ts
function handleManualDownload() {
  ...
  setTimeout(() => URL.revokeObjectURL(url), 500)
  setDownloaded(true)
  setDropped(true)
  deleteCachedFile()   // ← called here
}
```

The file is NOT deleted before the user drags it. Deletion happens in `onDragEnd`, which fires after the drag completes.

---

### B7 — Download button difference

`src/sidebar/MigrationModal.tsx:154–168`:

```ts
function handleManualDownload() {
  if (!fileContent) return
  const blob = new Blob([fileContent], { type: 'application/xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = migrationFile.filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 500)
  setDownloaded(true)
  setDropped(true)
  deleteCachedFile()
}
```

The download button creates a `Blob` from `fileContent` (the XML string), creates an object URL, attaches a hidden `<a download=...>` element to the DOM, clicks it programmatically. This produces an actual `.xml` file in the user's Downloads folder. The user then manually attaches it to ChatGPT via the file-upload button, not drag-and-drop.

---

### B8 — URL.createObjectURL usage

**Present in two places:**

1. `src/sidebar/MigrationModal.tsx:178` — on component mount, in `prefetchFile()`:
```ts
const blob = new Blob([content], { type: 'application/xml' })
const url = URL.createObjectURL(blob)
setFileObjectUrl(url)
```
Used as the `<a href={fileObjectUrl}>` fallback for the drag anchor.

2. `src/sidebar/MigrationModal.tsx:157` — in `handleManualDownload()`:
```ts
const blob = new Blob([fileContent], { type: 'application/xml' })
const url = URL.createObjectURL(blob)
```
Used only for the programmatic download anchor click. Revoked after 500ms.

Object URL is also revoked on component unmount (`MigrationModal.tsx:189–193`):
```ts
useEffect(() => {
  return () => {
    if (fileObjectUrl) URL.revokeObjectURL(fileObjectUrl)
  }
}, [fileObjectUrl])
```

A `File` object IS constructed at drag time (`MigrationModal.tsx:280`):
```ts
const file = new File([fileContent], migrationFile.filename, { type: 'application/xml' })
e.dataTransfer.items.add(file)
```

---

## Problem C — checkUsage Error

### C1 — checkUsage URL and expectation

`src/lib/usage-client.ts:36–66`:

```ts
export async function checkUsage(
  tier: 1 | 2 | 3,
  accessToken: string
): Promise<UsageCheckResult> {
  try {
    const res = await fetch(`${API_BASE}/api/usage/check`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tier }),
    });
    const data = (await res.json()) as UsageCheckResult;
    return data;
  } catch (err) {
    console.warn("[usage-client] checkUsage failed, failing open:", err);
    return {
      allowed: true, plan: "unknown", unlimited: true,
      tier, used: 0, limit: -1, remaining: -1, fallback: true,
    };
  }
}
```

`API_BASE = "https://contextmover.com"` (`usage-client.ts:5`).
Full URL: `POST https://contextmover.com/api/usage/check`

Expected response shape (`UsageCheckResult`, `usage-client.ts:7–20`):
```ts
interface UsageCheckResult {
  allowed: boolean; plan: string; unlimited: boolean;
  tier: number; used: number; limit: number; remaining: number;
  reason?: string; daysUntilReset?: number; resetDate?: string;
  upgradeUrl?: string; fallback?: boolean;
}
```

---

### C2 — Reachability

`WEBAPP_URL = "https://contextmover.com"` (`src/config/urls.ts:2`). This is the deployed production web app. The URL is reachable when the production server is running.

The `SyntaxError: Failed to execute 'json' on 'Response': Unexpected end of JSON input` error means the server returned an empty body (0 bytes) or a non-JSON body (e.g., empty 200, 204 No Content, or an HTML error page), and `res.json()` failed trying to parse it.

The error is NOT a network failure (that would be a `TypeError: Failed to fetch`). The server was reached but returned an unparseable body.

---

### C3 — Error path

The `catch` block in `usage-client.ts:52–65` catches the `SyntaxError` from `res.json()` and returns:
```ts
return {
  allowed: true,
  plan: "unknown",
  unlimited: true,
  tier,
  used: 0,
  limit: -1,
  remaining: -1,
  fallback: true,
}
```

Back in `service-worker.ts:528–543`, `checkMigrationAllowed` returns this result. Because `allowed: true`, the `if (!usage.allowed)` gate is NOT triggered. Migration continues normally.

Full flow: `MIGRATE_CONTEXT` → `checkMigrationAllowed` → `checkUsage` throws → returns `{ allowed: true, fallback: true }` → `handleMigrateContext` runs → migration completes.

---

### C4 — User visibility

No. The error is logged only to the service worker console (`console.warn("[usage-client] checkUsage failed, failing open:", err)`). The sidebar UI receives a successful migration response. The user sees no error indicator. Migration proceeds as if the usage check passed.

The `fallback: true` field in the returned object is never checked by any caller and never displayed to the user.

---

## Key File Paths

**Problem A:**
- `src/content/shared.ts` — `startSessionCapture`, `createObserver`, `capture`, `scrapeMessages`, `hashMessages`, `runCapturePipeline`
- `src/content/chatgpt.ts` — `scrapeMessages`, `installFetchInterceptor`, `parseChatGPTConversationMapping`
- `src/content/fetch-interceptor.ts` — MAIN-world fetch override, `dispatchCaptured`, `detectPlatform`
- `src/content/interceptor-bridge.ts` — `contextmover:captured` listener, `mergeMessages`, `__contextForgeFetchCaptured`
- `src/background/service-worker.ts` — `handleCaptureSession`, `captureInFlight`, `pendingWrites`, `writeTimers`
- `src/sidebar/Sidebar.tsx:725` — scroll-to-top warning

**Problem B:**
- `src/sidebar/MigrationModal.tsx` — `MigrationSuccess` component, `getFileContent`, `deleteCachedFile`, `handleManualDownload`, `onDragStart`, `onDragEnd`, `prefetchFile`
- `src/background/service-worker.ts:907–922` — `GET_CACHED_FILE`, `DELETE_CACHED_FILE`
- `src/background/service-worker.ts:1374–1385` — `migrationFileCache.set`
- `src/lib/file-builder.ts` — `buildTier1File`, `buildTier2File`, `buildTier3File`

**Problem C:**
- `src/lib/usage-client.ts` — `checkUsage`, `API_BASE`
- `src/config/urls.ts` — `WEBAPP_URL`
- `src/background/service-worker.ts:524–548` — `MIGRATE_CONTEXT` handler, freemium gate

---

## What Is Missing

**Problem A:**
- No accumulator in the DOM path — `scrapeMessages()` never merges results across calls; each call is a fresh full-DOM query. If ChatGPT removes messages from the DOM (virtual scroll), they are permanently lost from that session's next DOM-based capture.
- No "take highest count" logic in `handleCaptureSession` — later arrivals with smaller counts silently overwrite larger prior captures.
- The SW's `captureInFlight` lock only lasts 2.2s. The content script fires captures at t=0, 100, 500, 1000, 1500, 3000, 6000ms. Captures at t=3000 and t=6000 arrive after the lock has expired, so they can overwrite a full earlier capture with a partial one if DOM state changed.
- The `hashMessages` guard in the content script prevents re-sending the *same* hash, but a smaller/partial scrape has a different hash and is sent unconditionally.

**Problem B:**
- No verification that `dataTransfer.items.add(File)` actually populates `dataTransfer.files` when dragging from a Chrome extension sidebar into a web page. The `try/catch` around it silently swallows failure and falls back to href-drag which cannot deliver a real file to ChatGPT.
- No code checks whether the drop was "accepted" (i.e., ChatGPT's drop handler processed it as a file). `onDragEnd` fires regardless of whether the target accepted the drop.
- The `blob:chrome-extension://` object URL used as the anchor `href` fallback is a private-origin URL. Web pages cannot read it via `fetch()` or `FileReader`. ChatGPT's file-upload handler, if it tries to resolve the URL, will fail.

**Problem C:**
- `fallback: true` is never surfaced to the user. There is no UI indicator that usage enforcement was skipped due to an API error.
- The `res.ok` check is absent before `res.json()` in `checkUsage`. A non-2xx response body (HTML error page, empty 204) will always throw `SyntaxError` and always fail open.
