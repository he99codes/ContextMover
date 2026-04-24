# ContextForge

> Never lose coding context again. One layer. Any agent. Zero friction.

ContextForge is a monorepo containing two synchronized packages that together form an "OS layer" for AI coding agents:

1. **Browser Extension** — Passively captures conversations from Claude, ChatGPT, Gemini, and Grok. Stores them locally in IndexedDB. Injects migrated context into any target platform.
2. **VS Code Extension** — Captures real-time IDE state (active file, open tabs, git branch/diff, diagnostics) and exposes it via a local HTTP bridge.

---

## Monorepo Structure

```
contextforge/
├── package.json              # pnpm workspaces root
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── packages/
    ├── browser-extension/
    │   ├── manifest.json     # Manifest V3
    │   ├── vite.config.ts    # @crxjs/vite-plugin
    │   └── src/
    │       ├── background/   # Service worker + storage
    │       ├── content/      # Per-platform DOM observers
    │       ├── popup/        # React popup UI
    │       ├── sidebar/      # React sidebar UI
    │       └── lib/          # db, summarizer, translator, types
    └── vscode-extension/
        └── src/
            ├── extension.ts          # Activation entry point
            ├── context-collector.ts  # IDE snapshot logic
            └── bridge-server.ts      # HTTP bridge on :49152
```

---

## Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9 (`npm install -g pnpm`)

---

## Setup

```bash
# Install all dependencies
pnpm install

# Build both packages
pnpm build
```

---

## Browser Extension — Development

```bash
cd packages/browser-extension
pnpm dev
```

Then in Chrome:
1. Navigate to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `packages/browser-extension/dist`

The extension hot-reloads via `@crxjs/vite-plugin`.

---

## VS Code Extension — Development

```bash
cd packages/vscode-extension
pnpm dev   # starts tsc --watch
```

Then in VS Code:
1. Open the `packages/vscode-extension` folder
2. Press `F5` to launch an Extension Development Host
3. The bridge server starts automatically on port `49152`
4. Check the status bar for the `$(plug) ContextForge` item

### VS Code to LLM Pipeline

The VS Code extension can now package your live IDE state and send it to the LLM you choose.

Commands:
- `ContextForge: Copy IDE Context For LLM` - captures the current IDE state and copies a provider-formatted prompt
- `ContextForge: Open LLM With IDE Context` - captures the same prompt, copies it, and opens the selected provider in your browser

Additional VS Code settings:
- `contextforge.preferredProvider` - `ask`, `chatgpt`, `claude`, `gemini`, `grok`, or `custom`
- `contextforge.customProviderUrl` - the URL used when `preferredProvider` is `custom`

The migrated IDE payload includes:
- active file content or selection
- open tabs
- workspace name/root
- git branch and diff summary
- VS Code diagnostics

---

## How Migration Works

1. **Capture** — Content scripts observe `MutationObserver` on each AI platform's DOM and stream new messages to the service worker via `chrome.runtime.sendMessage`.
2. **Store** — The service worker persists sessions to IndexedDB (via `idb`) and optionally mirrors them to the VS Code bridge.
3. **Summarize** — When you click **Migrate**, the summarizer checks token budget. Short sessions pass verbatim; long sessions are compressed into a structured meta-prompt keeping the last 6 messages verbatim.
4. **Translate** — The Context Translation Adapter formats the summary for the target model:
   - **Claude** → strict `<context_migration>` XML tags
   - **ChatGPT / Grok** → structured Markdown with `##` headings
   - **Gemini** → plain `[SECTION]` delimiters
5. **Inject** — The formatted prompt is sent to the target tab's content script, which simulates paste into the input box.

---

## Configuration

### Browser Extension
Settings sync via `chrome.storage.sync`:
- `bridgePort` (default: `49152`)
- `autoCapture` (default: `true`)
- `maxTokensForSummary` (default: `6000`)

### VS Code Extension
Settings in VS Code preferences under **ContextForge**:
- `contextforge.bridgePort` — port for the local HTTP bridge
- `contextforge.maxFilesInContext` — max open files in snapshots

---

## Supported Platforms

| Platform | Capture | Inject |
|----------|---------|--------|
| Claude (claude.ai) | ✓ | ✓ |
| ChatGPT (chatgpt.com) | ✓ | ✓ |
| Gemini (gemini.google.com) | ✓ | ✓ |
| Grok (grok.x.ai) | ✓ | ✓ |

---

## Architecture

```
AI Platforms (observed + injected)
    │  MutationObserver                    ↑ inject prompt
    ▼                                      │
Browser Extension (MV3)           Migration Engine
  ├── Content scripts  ──────►  Service Worker
  ├── IndexedDB (local)               │
  └── Popup / Sidebar UI              ├── Summarizer (token-smart)
                                      └── Translator (XML/MD/plain)
    │  HTTP :49152
    ▼
VS Code Extension
  ├── Bridge Server (http.Server)
  └── Context Collector (files, git, diagnostics)
```

---

## License

MIT
