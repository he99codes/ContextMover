# Chrome Web Store Listing — ContextMover

Copy-paste each section below into the corresponding field in the Chrome Web Store Developer Dashboard.

---

## MISSING PERMISSION JUSTIFICATIONS

### unlimitedStorage justification
```
ContextMover stores AI conversation sessions locally on the user's device using IndexedDB. Each captured session includes message text, semantic embeddings (vector representations for context search), and structured metadata. A single active developer may accumulate hundreds of sessions across six supported AI platforms (Claude, ChatGPT, Gemini, Grok, Perplexity, DeepSeek), with each session containing dozens of messages. The semantic embedding model (MiniLM-L6-v2) generates 384-dimensional float vectors per text chunk, which are stored locally for instant offline retrieval. Without unlimitedStorage, the default 10 MB quota would be exhausted within days of normal use, causing data loss and degraded functionality. All data remains on-device; no conversation content is transmitted to external servers. The extension never stores data beyond what the user explicitly captures through their own AI interactions.
```

### identity justification
```
ContextMover uses the chrome.identity API exclusively for Google OAuth2 authentication. This serves two purposes: (1) User sign-in via Google to access their ContextMover account for subscription management and usage tracking, and (2) Google Drive AppData scope access to enable optional cross-device sync of conversation sessions. The extension requests only the drive.appdata scope, which limits access to a hidden application-specific folder that cannot read or modify any other files in the user's Google Drive. Authentication tokens are managed securely through Chrome's built-in identity system and are never exposed to web pages or third-party services. Users are prompted with Google's standard consent screen before any access is granted. No identity information is shared with third parties.
```

### alarms justification
```
ContextMover uses the chrome.alarms API for two periodic background maintenance tasks: (1) Automatic refresh of remote platform configuration data (selector updates) once per hour to ensure the extension adapts to AI platform UI changes without requiring a store update, and (2) Periodic session data synchronization with Google Drive AppData for users who have opted into cross-device sync. These alarms run at low frequency (hourly intervals) to minimize resource usage and battery impact. The alarms API is used instead of setInterval because Chrome MV3 service workers are ephemeral and may be terminated between events. Alarms persist across service worker restarts, ensuring reliable scheduling. No alarms are used for tracking, analytics, or advertising purposes.
```

---

## DATA USAGE CHECKBOXES

Based on what ContextMover actually collects, check the following boxes:

- [x] **Personally identifiable information** — Email address (for account authentication via Google sign-in)
- [ ] Health information — NOT collected
- [ ] Financial and payment information — NOT collected (payments handled entirely by Stripe, no card data touches the extension)
- [x] **Authentication information** — OAuth2 tokens stored locally for API authentication
- [ ] Personal communications — NOT collected
- [ ] Location — NOT collected
- [x] **Web history** — URLs of AI platform pages are used locally to identify conversation sessions (never transmitted to external servers)
- [x] **User activity** — The extension observes DOM content on supported AI platforms to capture conversation messages (this is the core functionality)
- [x] **Website content** — AI conversation text is captured and stored locally for context retrieval (this is the extension's primary purpose)

### Certify all three disclosures:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

---

## TEST INSTRUCTIONS

### Credentials
- **Username:** (leave blank — extension uses Google Sign-In, no username/password)
- **Password:** (leave blank)

### Additional instructions
```
No login is required to test core functionality. Install the extension, open any supported AI platform (claude.ai, chatgpt.com, gemini.google.com, grok.com, perplexity.ai, or chat.deepseek.com), and have a conversation. The extension automatically captures messages in the sidebar panel (right-click extension icon > Open Side Panel). To test migration: select a session in the sidebar, click "Migrate", choose a target platform and tier. Pro features require a subscription but all capture and retrieval features work without sign-in.
```

---

## NOTES FOR REVIEW

### Remote Code — already filled, but verify this matches:
The extension does NOT use remote code. All JavaScript and WebAssembly files are bundled within the extension package. The extension fetches JSON configuration data (platform CSS selectors) from its own server (contextmover.com/api/scraper-admin/configs) to allow hotfix updates when AI platforms change their DOM structure, but this is purely declarative JSON data — not executable code. The ONNX runtime (ort-wasm-simd.wasm) and Tree-sitter parsers are bundled locally. The MiniLM-L6-v2 embedding model is also bundled within the extension package.

### Data flow summary (for reviewer confidence):
1. User visits supported AI platform → content script reads conversation DOM
2. Messages stored in local IndexedDB (on-device only)
3. Semantic embeddings computed locally via bundled ONNX model
4. Optional: encrypted session metadata synced to user's own Google Drive AppData folder
5. No conversation content ever leaves the device to ContextMover servers
6. Server communication limited to: auth tokens (Supabase), usage counters, JSON config updates
