# Issue Report

## Section 1 — Auto-Download

### 1A — Download trigger locations

**Location 1** — `handleManualDownload()` — `URL.createObjectURL` + `a.click()`
File: `src/sidebar/MigrationModal.tsx`, lines 162–176

```typescript
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
    setTimeout(() => URL.revokeObjectURL(url), 500) // wait for download to start before revoking
    setDownloaded(true)
    setDropped(true)
    deleteCachedFile()
  }
```

---

**Location 2** — Auto-download `useEffect` — `chrome.downloads.download()` + fallback `a.click()`
File: `src/sidebar/MigrationModal.tsx`, lines 202–231

```typescript
  useEffect(() => {
    if (!fileReady || !fileObjectUrl || autoSaved || dropped) return
    let cancelled = false
    ;(async () => {
      try {
        if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
          // Preferred: silent download via chrome.downloads (no save-as
          // prompt if the user has 'Ask where to save' disabled).
          await new Promise<void>((resolve) => {
            chrome.downloads.download(
              { url: fileObjectUrl, filename: migrationFile.filename, saveAs: false },
              () => { void chrome.runtime.lastError; resolve() }
            )
          })
        } else {
          // Fallback: synthetic anchor click.
          const a = document.createElement('a')
          a.href = fileObjectUrl
          a.download = migrationFile.filename
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
        }
        if (!cancelled) setAutoSaved(true)
      } catch (err) {
        console.warn('[CM:migration] auto-save failed:', err)
      }
    })()
    return () => { cancelled = true }
  }, [fileReady, fileObjectUrl, autoSaved, dropped, migrationFile.filename])
```

---

**Location 3** — `onDragStart` fallback — calls `handleManualDownload()` when file cannot be added to `dataTransfer`
File: `src/sidebar/MigrationModal.tsx`, lines 354–362

```typescript
            if (!fileAdded) {
              // Extension-origin blob URLs are private — web pages cannot read
              // them as file attachments. Trigger download so the user can
              // attach via the 📎 button instead.
              e.preventDefault()
              setDragFailed(true)
              handleManualDownload()
              return
            }
```

---

**Location 4** — `prefetchFile` useEffect — `URL.createObjectURL` (creates object URL, does NOT trigger download)
File: `src/sidebar/MigrationModal.tsx`, lines 178–194

```typescript
  useEffect(() => {
    let cancelled = false
    async function prefetchFile() {
      try {
        const content = await getFileContent()
        if (cancelled) return
        if (!content) { setFetchError(true); return }
        const blob = new Blob([content], { type: 'application/xml' })
        const url = URL.createObjectURL(blob)
        setFileObjectUrl(url)
        setFileContent(content)
        setFileReady(true)
      } catch { if (!cancelled) setFetchError(true) }
    }
    prefetchFile()
    return () => { cancelled = true }
  }, [])
```

---

### 1B — MigrationSuccess complete component

File: `src/sidebar/MigrationModal.tsx`, lines 103–496

```typescript
function MigrationSuccess({
  migrationFile,
  cacheKey,
  injected,
  elapsed,
  targetPlatform,
  onClose
}: {
  migrationFile: {
    filename: string
    charCount: number
    estimatedTokens: number
    tier: number
    platform: string
    sessionTitle: string
  }
  cacheKey: string
  injected: boolean
  elapsed: number
  targetPlatform: string
  onClose: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const [dropped, setDropped] = useState(false)
  const [dragFailed, setDragFailed] = useState(false)
  const [fileReady, setFileReady] = useState(false)
  const [fetchError, setFetchError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileObjectUrl, setFileObjectUrl] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [downloaded, setDownloaded] = useState(false)
  // True once the file has been auto-saved to the user's Downloads folder.
  // We auto-download because dragging JS-constructed File objects from a Chrome
  // extension side panel cross-origin into a web page does NOT populate the
  // target's dataTransfer.files — a Chromium security boundary. The downloads
  // bar at the bottom of the screen exposes a real disk file the user can
  // drag (OS-level drag, which DOES work) or attach via the chat's 📎 button.
  const [autoSaved, setAutoSaved] = useState(false)
  const sizeKB = Math.round(migrationFile.charCount / 1024)

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

  function deleteCachedFile(): void {
    chrome.runtime.sendMessage(
      { type: 'DELETE_CACHED_FILE', cacheKey },
      () => {}
    )
  }

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
    setTimeout(() => URL.revokeObjectURL(url), 500) // wait for download to start before revoking
    setDownloaded(true)
    setDropped(true)
    deleteCachedFile()
  }

  useEffect(() => {
    let cancelled = false
    async function prefetchFile() {
      try {
        const content = await getFileContent()
        if (cancelled) return
        if (!content) { setFetchError(true); return }
        const blob = new Blob([content], { type: 'application/xml' })
        const url = URL.createObjectURL(blob)
        setFileObjectUrl(url)
        setFileContent(content)
        setFileReady(true)
      } catch { if (!cancelled) setFetchError(true) }
    }
    prefetchFile()
    return () => { cancelled = true }
  }, [])

  // ── Auto-save to disk as soon as the file is ready ────────────────────────
  // Why: dragging JS-constructed File objects from a Chrome extension side
  // panel cross-origin into a web page does NOT populate target.files (Chromium
  // security boundary). To guarantee the user has a movable file, we download
  // it to disk immediately. They can then drag from the OS downloads bar —
  // which is a real OS-level file drag and works in every web target.
  useEffect(() => {
    if (!fileReady || !fileObjectUrl || autoSaved || dropped) return
    let cancelled = false
    ;(async () => {
      try {
        if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
          // Preferred: silent download via chrome.downloads (no save-as
          // prompt if the user has 'Ask where to save' disabled).
          await new Promise<void>((resolve) => {
            chrome.downloads.download(
              { url: fileObjectUrl, filename: migrationFile.filename, saveAs: false },
              () => { void chrome.runtime.lastError; resolve() }
            )
          })
        } else {
          // Fallback: synthetic anchor click.
          const a = document.createElement('a')
          a.href = fileObjectUrl
          a.download = migrationFile.filename
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
        }
        if (!cancelled) setAutoSaved(true)
      } catch (err) {
        console.warn('[CM:migration] auto-save failed:', err)
      }
    })()
    return () => { cancelled = true }
  }, [fileReady, fileObjectUrl, autoSaved, dropped, migrationFile.filename])

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (fileObjectUrl) URL.revokeObjectURL(fileObjectUrl)
    }
  }, [fileObjectUrl])

  return (
    <div style={{ padding: '4px' }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center',
        gap:'8px', marginBottom:'16px' }}>
        <span style={{ fontSize:'20px' }}>✅</span>
        <div>
          <div style={{ fontSize:'12px', fontWeight:900,
            color:'#00FF88', textTransform:'uppercase',
            letterSpacing:'0.1em' }}>
            Migration complete
          </div>
          <div style={{ fontSize:'10px', color:'#6B6B6B', marginTop:'2px' }}>
            {injected
              ? `Instructions injected into ${targetPlatform} ✓`
              : `Open ${targetPlatform} and paste instructions`}
          </div>
        </div>
      </div>

      {/* Drag zone — anchor with object URL */}
      {dropped ? (
        <div style={{
          background: 'rgba(0,255,136,0.08)',
          border: '1px solid rgba(0,255,136,0.2)',
          borderRadius: '10px',
          padding: '20px 14px',
          marginBottom: '12px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize:'28px', marginBottom:'8px' }}>
            {dragFailed ? '⬇️' : '🎉'}
          </div>
          <div style={{ fontSize:'11px', fontWeight:900,
            color:'#00FF88', marginBottom:'4px' }}>
            {dragFailed ? 'File downloaded' : 'File delivered'}
          </div>
          <div style={{ fontSize:'9px', color:'#6B6B6B' }}>
            {dragFailed
              ? 'Drag from sidebar cannot deliver files — attach it using the 📎 button in the chat'
              : 'Upload it in the AI chat if not already done'}
          </div>
        </div>
      ) : fetchError ? (
        <div style={{
          background: 'rgba(255,68,68,0.08)',
          border: '2px dashed rgba(255,68,68,0.3)',
          borderRadius: '10px',
          padding: '20px 14px',
          marginBottom: '12px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize:'28px', marginBottom:'8px' }}>⚠️</div>
          <div style={{ fontSize:'11px', fontWeight:900,
            color:'#FF4444', marginBottom:'4px' }}>
            File expired
          </div>
          <div style={{ fontSize:'9px', color:'#6B6B6B' }}>
            Please run migration again
          </div>
        </div>
      ) : !fileReady ? (
        <div style={{
          background: '#111',
          border: '2px dashed #2A2A2A',
          borderRadius: '10px',
          padding: '20px 14px',
          marginBottom: '12px',
          textAlign: 'center',
          cursor: 'not-allowed'
        }}>
          <div style={{ fontSize:'28px', marginBottom:'8px' }}>⏳</div>
          <div style={{ fontSize:'11px', fontWeight:900,
            color:'#6B6B6B', marginBottom:'4px' }}>
            Preparing file...
          </div>
          <div style={{ fontSize:'9px', color:'#4A4A4A' }}>
            Ready to drag in a moment
          </div>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          draggable={true}
          onDragStart={(e) => {
            // CRITICAL: do NOT use an <a href> for the drag source — the anchor
            // auto-populates dataTransfer with text/uri-list pointing to the
            // blob:chrome-extension:// URL, which is a private-origin URL the
            // target page (ChatGPT/Claude) cannot read. Their drop handlers
            // then fall back to text/plain and show the URL as a text token
            // → user sees "icon + filename" instead of the file being uploaded.
            //
            // Strategy: clear all auto-populated MIME entries, then add the
            // real File object as the only payload.
            let fileAdded = false
            try {
              e.dataTransfer.clearData()
            } catch { /* some browsers throw if no data set yet */ }
            if (fileContent) {
              try {
                const file = new File(
                  [fileContent],
                  migrationFile.filename,
                  { type: 'application/xml' }
                )
                e.dataTransfer.items.add(file)
                // Verify the file actually landed in dataTransfer.files —
                // items.add can silently no-op in some extension contexts.
                fileAdded = e.dataTransfer.files.length > 0
                  || e.dataTransfer.items.length > 0
              } catch { /* items API unavailable */ }
            }
            if (!fileAdded) {
              // Extension-origin blob URLs are private — web pages cannot read
              // them as file attachments. Trigger download so the user can
              // attach via the 📎 button instead.
              e.preventDefault()
              setDragFailed(true)
              handleManualDownload()
              return
            }
            e.dataTransfer.effectAllowed = 'copy'
            setDragging(true)
          }}
          onDragEnd={() => {
            setDragging(false)
            setDropped(true)
            deleteCachedFile()
          }}
          style={{
            display: 'block',
            background: dragging
              ? 'rgba(0,255,136,0.12)'
              : 'rgba(0,255,136,0.04)',
            border: `2px dashed ${dragging
              ? '#00FF88'
              : 'rgba(0,255,136,0.35)'}`,
            borderRadius: '10px',
            padding: '20px 14px',
            marginBottom: '12px',
            cursor: 'grab',
            textAlign: 'center',
            textDecoration: 'none',
            transition: 'all 0.15s ease',
            userSelect: 'none'
          }}
        >
          <div style={{ fontSize:'28px', marginBottom:'8px',
            pointerEvents:'none' }}>
            {autoSaved ? '✅' : '📁'}
          </div>
          <div style={{ fontSize:'11px', fontWeight:900,
            color:'#00FF88', marginBottom:'4px',
            pointerEvents:'none' }}>
            {dragging ? 'Drop into AI chat!'
              : autoSaved ? 'Saved to Downloads'
              : 'Drag into AI chat'}
          </div>
          <div style={{ fontSize:'9px', color:'#6B6B6B',
            fontFamily:'monospace', marginBottom:'4px',
            wordBreak:'break-all', pointerEvents:'none' }}>
            {migrationFile.filename}
          </div>
          <div style={{ fontSize:'9px', color:'#4A4A4A',
            pointerEvents:'none', marginBottom: autoSaved ? '6px' : '0' }}>
            {sizeKB}KB · ~{migrationFile.estimatedTokens.toLocaleString()} tokens
          </div>
          {autoSaved && (
            <div style={{ fontSize:'9px', color:'#00FF88AA',
              pointerEvents:'none', lineHeight: 1.4 }}>
              Drag from the downloads bar↓ or use 📎 in the chat
            </div>
          )}
        </div>
      )}

      {/* Download button */}
      {!dropped && (
        <div style={{ textAlign:'center', marginBottom:'14px' }}>
          <button
            onClick={handleManualDownload}
            disabled={!fileReady}
            style={{
              background:'transparent',
              border:'1px solid #2A2A2A',
              borderRadius:'4px',
              color: fileReady ? '#6B6B6B' : '#3A3A3A',
              fontSize:'9px',
              fontWeight:700,
              padding:'6px 14px',
              cursor: fileReady ? 'pointer' : 'not-allowed',
              textTransform:'uppercase',
              letterSpacing:'0.08em'
            }}
          >
            ⬇ Download file instead
          </button>
          {downloaded && (
            <div style={{ fontSize:'9px', color:'#3A6A4A',
              marginTop:'4px' }}>
              ✓ Saved to Downloads folder
            </div>
          )}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div style={{ fontSize:'10px', color:'#FF4444',
          marginBottom:'10px', textAlign:'center' }}>
          {error}
        </div>
      )}

      {/* How to use */}
      {!dropped && (
        <div style={{ background:'#0A0A0A', border:'1px solid #2A2A2A',
          borderRadius:'6px', padding:'12px', marginBottom:'12px' }}>
          <div style={{ fontSize:'9px', fontWeight:900, color:'#6B6B6B',
            textTransform:'uppercase', letterSpacing:'0.12em',
            marginBottom:'8px' }}>
            How to use
          </div>
          {[
            `Go to your ${targetPlatform} tab`,
            'Drag the file above into the chat',
            'AI reads it and continues your work'
          ].map((step, i) => (
            <div key={i} style={{ display:'flex', gap:'8px',
              marginBottom:'6px', fontSize:'10px', color:'#6B6B6B' }}>
              <span style={{ color:'#00FF88', fontWeight:700,
                flexShrink:0 }}>{i + 1}.</span>
              <span>{step}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize:'9px', color:'#3A3A3A',
        textAlign:'center', marginBottom:'12px' }}>
        File auto-expires in 30 minutes · {(elapsed/1000).toFixed(1)}s
      </div>

      <button onClick={onClose} style={{
        width:'100%', padding:'10px', background:'transparent',
        border:'1px solid #2A2A2A', borderRadius:'4px',
        color:'#6B6B6B', fontSize:'10px', fontWeight:700,
        cursor:'pointer', textTransform:'uppercase',
        letterSpacing:'0.1em'
      }}>
        Done
      </button>
    </div>
  )
}
```

---

### 1C — Drag zone JSX

File: `src/sidebar/MigrationModal.tsx`, lines 322–415

The drag area is a `<div>` with `role="button"`, `draggable={true}`, and an `onDragStart` handler. It is NOT an `<a>` tag.

```tsx
        <div
          role="button"
          tabIndex={0}
          draggable={true}
          onDragStart={(e) => {
            let fileAdded = false
            try {
              e.dataTransfer.clearData()
            } catch { /* some browsers throw if no data set yet */ }
            if (fileContent) {
              try {
                const file = new File(
                  [fileContent],
                  migrationFile.filename,
                  { type: 'application/xml' }
                )
                e.dataTransfer.items.add(file)
                fileAdded = e.dataTransfer.files.length > 0
                  || e.dataTransfer.items.length > 0
              } catch { /* items API unavailable */ }
            }
            if (!fileAdded) {
              e.preventDefault()
              setDragFailed(true)
              handleManualDownload()
              return
            }
            e.dataTransfer.effectAllowed = 'copy'
            setDragging(true)
          }}
          onDragEnd={() => {
            setDragging(false)
            setDropped(true)
            deleteCachedFile()
          }}
          style={{ ... }}
        >
          <div style={{ fontSize:'28px', marginBottom:'8px',
            pointerEvents:'none' }}>
            {autoSaved ? '✅' : '📁'}
          </div>
          <div style={{ fontSize:'11px', fontWeight:900,
            color:'#00FF88', marginBottom:'4px',
            pointerEvents:'none' }}>
            {dragging ? 'Drop into AI chat!'
              : autoSaved ? 'Saved to Downloads'
              : 'Drag into AI chat'}
          </div>
          <div style={{ fontSize:'9px', color:'#6B6B6B',
            fontFamily:'monospace', marginBottom:'4px',
            wordBreak:'break-all', pointerEvents:'none' }}>
            {migrationFile.filename}
          </div>
          <div style={{ fontSize:'9px', color:'#4A4A4A',
            pointerEvents:'none', marginBottom: autoSaved ? '6px' : '0' }}>
            {sizeKB}KB · ~{migrationFile.estimatedTokens.toLocaleString()} tokens
          </div>
          {autoSaved && (
            <div style={{ fontSize:'9px', color:'#00FF88AA',
              pointerEvents:'none', lineHeight: 1.4 }}>
              Drag from the downloads bar↓ or use 📎 in the chat
            </div>
          )}
        </div>
```

---

### 1D — useEffect on mount

File: `src/sidebar/MigrationModal.tsx`, lines 178–194

The only `useEffect` with an empty dependency array `[]` (runs on mount) is `prefetchFile`. It does NOT call any download function — it only fetches file content and creates an object URL.

```typescript
  useEffect(() => {
    let cancelled = false
    async function prefetchFile() {
      try {
        const content = await getFileContent()
        if (cancelled) return
        if (!content) { setFetchError(true); return }
        const blob = new Blob([content], { type: 'application/xml' })
        const url = URL.createObjectURL(blob)
        setFileObjectUrl(url)
        setFileContent(content)
        setFileReady(true)
      } catch { if (!cancelled) setFetchError(true) }
    }
    prefetchFile()
    return () => { cancelled = true }
  }, [])
```

The auto-download `useEffect` (lines 202–231) has dependency array `[fileReady, fileObjectUrl, autoSaved, dropped, migrationFile.filename]` — it does NOT run on mount. It fires when `fileReady` transitions to `true`.

---

### 1E — getFileContent()

File: `src/sidebar/MigrationModal.tsx`, lines 143–153

It is async (returns a `Promise`). It fetches from the service worker's `migrationFileCache` in-memory `Map` via `chrome.runtime.sendMessage`.

```typescript
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

---

### 1F — fileObjectUrl state

File: `src/sidebar/MigrationModal.tsx`

**Declaration:** line 131
```typescript
  const [fileObjectUrl, setFileObjectUrl] = useState<string | null>(null)
```

**Setter call — `setFileObjectUrl(url)`:** line 187, inside `prefetchFile()` which is called from the mount `useEffect` (line 178).

```typescript
        const url = URL.createObjectURL(blob)
        setFileObjectUrl(url)
        setFileContent(content)
        setFileReady(true)
```

`setFileObjectUrl` is called at line 187, BEFORE `setAutoSaved(true)` (line 225). The auto-download `useEffect` gates on `fileReady` (set line 189) being `true`. React batches state updates, so `fileObjectUrl` and `fileReady` are set in the same render cycle. The auto-download `useEffect` fires on the NEXT render, after `fileObjectUrl` is already set. Therefore `fileObjectUrl` IS set BEFORE the auto-download fires.

---

### 1G — "Saved to Downloads" text location

File: `src/sidebar/MigrationModal.tsx`, line 397

Controlled by the `autoSaved` state variable (declared line 140, set to `true` at line 225 after `chrome.downloads.download` resolves).

```tsx
            {dragging ? 'Drop into AI chat!'
              : autoSaved ? 'Saved to Downloads'
              : 'Drag into AI chat'}
```

There is also a second "Saved to Downloads folder" string at line 442, controlled by the `downloaded` state (set by `handleManualDownload()`):

```tsx
          {downloaded && (
            <div style={{ fontSize:'9px', color:'#3A6A4A',
              marginTop:'4px' }}>
              ✓ Saved to Downloads folder
            </div>
          )}
```

---

### 1H — "Drag from downloads bar" text

File: `src/sidebar/MigrationModal.tsx`, lines 409–414

This text IS present in the code. It renders when `autoSaved` is `true` (i.e., after `chrome.downloads.download` completes successfully).

```tsx
          {autoSaved && (
            <div style={{ fontSize:'9px', color:'#00FF88AA',
              pointerEvents:'none', lineHeight: 1.4 }}>
              Drag from the downloads bar↓ or use 📎 in the chat
            </div>
          )}
```

---

## Section 2 — Claude Detection

### 2A — scrapeMessages() complete

File: `src/content/claude.ts`, lines 17–57

```typescript
function scrapeMessages(): Message[] {
  const found: Array<{ el: Element; role: 'user' | 'assistant' }> = []

  // Primary selectors — role assigned from the selector itself, never from
  // DOM position or class-substring guessing.
  document.querySelectorAll<HTMLElement>('[data-testid="human-turn"]')
    .forEach(el => { if (!isStreaming(el)) found.push({ el, role: 'user' }) })
  document.querySelectorAll<HTMLElement>('[data-testid="ai-turn"]')
    .forEach(el => { if (!isStreaming(el)) found.push({ el, role: 'assistant' }) })

  // Fallback if primary returns nothing. Use DISTINCT selectors per role
  // rather than a generic selector + class-string match — the latter would
  // mis-classify e.g. an element with class "humanize-button" as a user turn.
  if (found.length === 0) {
    const userSel = '[class*="human-turn"], [class*="HumanTurn"], [class*="user-message"]'
    const asstSel = '.font-claude-message, [class*="ai-turn"], [class*="AssistantTurn"], [class*="assistant-message"]'
    document.querySelectorAll<HTMLElement>(userSel).forEach(el => {
      if (el.parentElement?.closest(userSel)) return
      if (isStreaming(el)) return
      found.push({ el, role: 'user' })
    })
    document.querySelectorAll<HTMLElement>(asstSel).forEach(el => {
      if (el.parentElement?.closest(asstSel)) return
      if (isStreaming(el)) return
      found.push({ el, role: 'assistant' })
    })
  }

  // Sort by DOM position
  found.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )

  return found
    .map(({ el, role }) => ({
      role,
      content: extractContent(el),
      timestamp: Date.now()
    }))
    .filter(m => m.content.trim().length > 0)
}
```

---

### 2B — installFetchInterceptor()

File: `src/content/claude.ts`, lines 60–89

EXISTS. Injects a `<script>` tag into `document.documentElement` to run in MAIN world.

```typescript
function installFetchInterceptor(): void {
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      const _originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await _originalFetch.apply(this, args);
        const url = typeof args[0] === 'string'
          ? args[0]
          : args[0]?.url ?? '';
        if (url.includes('/chat_conversations/') &&
            url.includes('tree=True')) {
          try {
            const clone = response.clone();
            const data = await clone.json();
            if (data?.chat_messages) {
              window.dispatchEvent(new CustomEvent(
                '__CM_CLAUDE_CONVERSATION__',
                { detail: JSON.stringify(data) }
              ));
            }
          } catch {}
        }
        return response;
      };
    })();
  `;
  document.documentElement.appendChild(script);
  script.remove();
}
```

---

### 2C — `__CM_CLAUDE_CONVERSATION__` listener

File: `src/content/claude.ts`, lines 91–116

EXISTS.

```typescript
window.addEventListener('__CM_CLAUDE_CONVERSATION__', (e: Event) => {
  try {
    const data = JSON.parse((e as CustomEvent).detail);
    const messages: Message[] = (data.chat_messages as any[])
      .map((m: any) => {
        const text = Array.isArray(m.content)
          ? m.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text as string)
              .join('\n')
          : typeof m.content === 'string'
            ? m.content
            : '';
        return {
          role: (m.sender === 'human' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: text.trim(),
          timestamp: new Date(m.created_at).getTime(),
        };
      })
      .filter((m: Message) => m.content.length > 0);
    if (messages.length > 0) {
      console.debug('[CM:capture] Claude network intercept:', messages.length, 'msgs');
      void sendCapture(messages, 'claude');
    }
  } catch {}
});
```

---

### 2D — startSessionCapture() call

File: `src/content/claude.ts`, lines 120–124

```typescript
startSessionCapture({
  platform: "claude",
  selectorOrElement: "main",
  scrapeMessages: () => runCapturePipeline("claude", scrapeMessages),
});
```

Arguments: `platform = "claude"`, `selectorOrElement = "main"`, `scrapeMessages` is a lambda calling `runCapturePipeline("claude", scrapeMessages)`. No `getTitle` argument is passed.

---

### 2E — manifest.json claude entry

File: `manifest.json`, lines 70–79

```json
        {
            "matches": [
                "https://claude.ai/*"
            ],
            "js": [
                "src/content/claude.ts"
            ],
            "run_at": "document_start",
            "all_frames": false
        }
```

- `run_at`: `"document_start"`
- `matches`: `"https://claude.ai/*"` only
- `world`: NOT SET (defaults to `"ISOLATED"`)

There is a SEPARATE manifest entry that runs in `world: "MAIN"` at `document_start` for ALL platforms including `claude.ai/*`:

```json
        {
            "matches": [
                "https://claude.ai/*",
                "https://chatgpt.com/*",
                ...
            ],
            "js": [
                "src/content/fetch-interceptor.ts"
            ],
            "run_at": "document_start",
            "world": "MAIN"
        }
```

File: `manifest.json`, lines 37–53

---

### 2F — Script tag injection code

File: `src/content/claude.ts`, lines 61–88

`installFetchInterceptor()` creates a `<script>` tag, sets `script.textContent` to an IIFE string, appends it to `document.documentElement`, then immediately removes the script element. This is the standard pattern for ISOLATED-world scripts to execute code in MAIN world.

```typescript
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      const _originalFetch = window.fetch;
      window.fetch = async function(...args) {
        ...
      };
    })();
  `;
  document.documentElement.appendChild(script);
  script.remove();
```

This injection runs from `claude.ts` (ISOLATED world). By the time it runs, `fetch-interceptor.ts` (MAIN world, same `run_at: "document_start"`) has already installed its own `window.fetch` override. The injected script captures `fetch-interceptor.ts`'s override as `_originalFetch`, then wraps it again.

---

### 2G — URL match pattern

File: `src/content/claude.ts`, lines 70–71 (inside `installFetchInterceptor` IIFE string)

```javascript
        if (url.includes('/chat_conversations/') &&
            url.includes('tree=True')) {
```

This matches ONLY Claude's conversation-load GET endpoint (e.g., `GET /api/.../chat_conversations/{id}?tree=True`). It does NOT match streaming POST endpoints (e.g., `/api/.../chat_conversations/{id}/completion`).

For comparison, `fetch-interceptor.ts` detects Claude at lines 101–102:

```typescript
    if ((url.includes("claude.ai/api") && /completion|append_message|chat_conversations/.test(url)) ||
        ((url.includes("a-api.anthropic.com") || url.includes("api.anthropic.com")) && /\/v1\//.test(url))) return "claude";
```

---

### 2H — Claude session ID derivation

File: `src/lib/session-id.ts`

Session IDs are NOT derived directly from the URL in the service worker. The service worker calls `resolveSessionId(platform, tab.url)` (lines 1549–1552 in `service-worker.ts`). The resolution logic is in `src/lib/session-id.ts`.

**URL key format** (line 34):
```typescript
  return `${platform}::${path}`;
  // e.g. "claude::claude.ai/chat/abc123def456"
```

where `path = ${hostname}${pathname}${search}` with trailing slash stripped (lines 29–31):
```typescript
    const u = new URL(href);
    path = `${u.hostname}${u.pathname}${u.search}`.replace(/\/$/, "");
```

**New session format** (line 61):
```typescript
  return `${platform}-${raw.slice(0, 10)}`;
  // e.g. "claude-a1b2c3d4e5"
```

where `raw` is a `crypto.randomUUID()` with dashes stripped (lines 57–60):
```typescript
  const raw =
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`)
      .replace(/-/g, "");
```

**Legacy format** (lines 47–52):
```typescript
  let hash = 7;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash * 31 + path.charCodeAt(i)) >>> 0);
  }
  return `${platform}-${hash.toString(36)}`;
  // e.g. "claude-1a2b3c4d"
```

---

### 2I — Immediate scrape calls

File: `src/content/shared.ts`, lines 348–353 (inside `startSessionCapture`)

```typescript
  void capture();
  setTimeout(capture, 100);
  setTimeout(capture, 500);
  setTimeout(capture, 1000);
  setTimeout(capture, 1500);
  window.addEventListener("load", capture, { once: true });
```

There are **5 scheduled calls on load** (immediate + 4 `setTimeout`) plus one `load` event listener. The immediate `void capture()` fires synchronously on script load. All 5 are subject to the fetch-intercept gate check:

```typescript
    const fc = (window as unknown as { __contextForgeFetchCaptured?: { at: number; count: number } })
      .__contextForgeFetchCaptured;
    if (fc && Date.now() - fc.at < FETCH_FALLBACK_WINDOW_MS) {
      console.log(
        `[ContextMover] ${config.platform}: fetch-intercept active (count=${fc.count}, age=${Date.now() - fc.at}ms), skipping DOM scrape`
      );
      return;
    }
```

File: `src/content/shared.ts`, lines 207–214

If `__contextForgeFetchCaptured` is set (by `fetch-interceptor.ts`/`interceptor-bridge.ts`) within the last 60 seconds, ALL 5 immediate scrape calls are suppressed.

---

### 2J — Fetch interceptor for Claude that listens to network response

Two fetch interceptors exist for Claude simultaneously:

**Interceptor 1** — `src/content/fetch-interceptor.ts` (MAIN world, `document_start`, manifest-declared)

EXISTS. Overrides `window.fetch` globally for all platforms. Detects Claude at lines 101–102, dispatches `contextmover:captured` CustomEvent. Handled by `src/content/interceptor-bridge.ts` which listens for `contextmover:captured` and forwards to service worker as `CAPTURE_SESSION`. Handles both SSE streaming responses (`parseClaude`) and full conversation-load JSON (`parseClaudeHistory`).

**Interceptor 2** — `src/content/claude.ts`, `installFetchInterceptor()` (script-injected into MAIN world at runtime, called at line 118)

EXISTS. Wraps `window.fetch` via DOM script injection. Listens ONLY for `/chat_conversations/` with `tree=True`. Dispatches `__CM_CLAUDE_CONVERSATION__` CustomEvent. Handled at lines 91–116 in `claude.ts` (ISOLATED world). Does NOT handle streaming assistant responses.

**Conflict:** `claude.ts`'s injected script runs AFTER `fetch-interceptor.ts` has already installed its override. `_originalFetch` in the injected IIFE therefore points to `fetch-interceptor.ts`'s override, not the browser's native fetch. The resulting call chain is:

```
page → claude.ts injected wrapper → fetch-interceptor.ts wrapper → native fetch
```

Every Claude API call passes through BOTH interceptors. The `__contextForgeFetchCaptured` flag is set by `interceptor-bridge.ts` when `fetch-interceptor.ts` fires. This flag suppresses the DOM fallback scrape for 60 seconds (`FETCH_FALLBACK_WINDOW_MS = 60_000`, `shared.ts` line 191).

---

## Summary

### What is broken and what is missing — facts from code only

**Auto-Download:**

1. `chrome.downloads.download` is called from the React sidebar (`src/sidebar/MigrationModal.tsx` line 211). The sidebar runs as a Chrome extension side panel page. `chrome.downloads` is available in extension pages but requires the `downloads` permission. The `downloads` permission IS present in `manifest.json` line 13. However, `chrome.downloads.download` requires a URL accessible by the extension — `fileObjectUrl` is a `blob:chrome-extension://` URL created inside the sidebar page, which IS accessible to extension pages. This path should work.

2. The `autoSaved` `useEffect` guards on `!autoSaved` in its condition (line 203) and also lists `autoSaved` in its dependency array (line 231). If `chrome.downloads.download` never calls its callback (e.g., service worker is inactive and `chrome.downloads` is unavailable in that context), `setAutoSaved(true)` is never called, and the `useEffect` will re-run every time `fileReady` or `fileObjectUrl` changes — but since the guard `if (!fileReady || !fileObjectUrl || autoSaved || dropped) return` runs first, and `fileReady`/`fileObjectUrl` do not change after initial set, the effect will only run once.

3. The "Drag from the downloads bar↓" text at line 412 renders when `autoSaved === true`. This text IS present in the deployed code and is shown ONLY after a successful auto-download.

4. `handleManualDownload` uses `URL.createObjectURL` and `a.click()` — this triggers a download from the sidebar page's context. It also sets `dropped = true` (line 174), which hides the drag zone permanently.

**Claude Session Detection:**

1. `claude.ts` installs a SECOND `window.fetch` wrapper via script injection (`installFetchInterceptor()`, line 118). `fetch-interceptor.ts` (manifest, MAIN world, `document_start`) has ALREADY installed a `window.fetch` override before `claude.ts`'s injection runs. The injected IIFE from `claude.ts` therefore captures `fetch-interceptor.ts`'s already-patched `window.fetch` as its `_originalFetch`, creating a double-intercept chain.

2. The `__CM_CLAUDE_CONVERSATION__` event path in `claude.ts` only fires for URLs matching `/chat_conversations/` AND `tree=True` (lines 70–71). This covers conversation-load GETs but NOT streaming POST responses (`/completion` endpoint). New messages sent in a Claude chat go to the `/completion` endpoint, which is NOT matched by this filter.

3. `fetch-interceptor.ts` detects Claude streaming via the regex `/completion|append_message|chat_conversations/` (line 101). It dispatches `contextmover:captured`. `interceptor-bridge.ts` handles this event and sets `window.__contextForgeFetchCaptured`. Once set, `startSessionCapture`'s DOM-fallback gate suppresses all DOM scrapes for 60 seconds (shared.ts lines 207–214). If `interceptor-bridge.ts`'s capture path fails silently (e.g., `assistantCount === 0`, line 150 in `interceptor-bridge.ts`), `__contextForgeFetchCaptured` is NOT set, but the DOM scrape may have already been blocked on a prior successful cycle.

4. `claude.ts` is declared with `run_at: "document_start"` and no `world` key in `manifest.json` (lines 70–79), meaning it runs in the ISOLATED world. `installFetchInterceptor()` must inject a script tag to reach the MAIN world. At `document_start`, `document.documentElement` exists, so injection is possible, but it runs AFTER `fetch-interceptor.ts` (MAIN world, `document_start`) has already patched `window.fetch`.

5. The `__CM_CLAUDE_CONVERSATION__` event listener in `claude.ts` (lines 91–116) calls `sendCapture(messages, 'claude')` which calls `resolveSessionId(platform, location.href)` (shared.ts line 686). If this fires while Claude's URL is still `https://claude.ai/new` (before SPA navigation to the conversation URL), the session ID is bound to `/new`. The DOM-scrape path in `startSessionCapture` detects URL changes and re-resolves (shared.ts lines 196–202), but the fetch-intercept path in `sendCapture` does NOT re-resolve on URL change — it calls `resolveSessionId` with `location.href` at the moment of the fetch response, which may be a different URL than the DOM-scrape path resolves.

6. `fetch-interceptor.ts`'s `parseClaude` (SSE path) extracts user prompt from the request body via `extractOpenAIUserPrompt` (line 459). If `requestBodyText` is `null` (which happens if `earlyPlatform` is null at the time the request body is read, or if `init.body` is not a plain string), no user message is emitted — only the assistant turn. `interceptor-bridge.ts` then gates on `assistantCount > 0` (line 150) before forwarding to the service worker. If the SSE parser returns only the assistant turn without a user message, `merged` still contains prior user messages from the accumulator, so it should still pass the gate — unless this is the FIRST message in a conversation.
