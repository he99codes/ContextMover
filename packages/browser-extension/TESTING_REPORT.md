# ContextMover Extension - Deep Testing Report (June 2026)

This document synthesizes findings from a deep testing session conducted on June 2nd, 2026. It covers multiple critical bugs across the extension's core feature set.

## 1. Executive Summary

The extension is suffering from several high-severity regressions and broken features that significantly degrade the user experience and administrative capabilities. The most critical issues are the complete failure of the Attention Engine (Tier 3 Migration) and the semantic indexing system. The Admin Panel is also non-functional, and key regressions in migration auto-injection and platform scraping have been identified.

## 2. High-Severity Issues

### 2.1. Attention Engine (Tier 3 Migration) is Broken

- **Symptom:** Tier 3 migrations are unreliable across all platforms. They either fail completely due to timeouts or produce low-quality output with inaccurate code analysis.
- **Root Cause Analysis (from Logs):** This is a two-part failure:
    1.  **Parser Not Loading:** The logs show a critical error: `[ContextMover:attention-engine] web-tree-sitter unavailable — regex fallback active`. The engine that parses code structure is failing to load, causing the system to fall back to inaccurate regex matching. This severely degrades the quality of context analysis for any migration involving code.
    2.  **Offscreen Document Timeout:** The logs also repeatedly show `[CM:index] Offscreen query embed failed — using keyword fallback: Error: offscreen embed timeout (45s)`. The process of generating vector embeddings for context is taking too long and timing out, which completely breaks Tier 3 migration when a query is provided.
- **Severity:** Critical. The core feature of Tier 3 migration is fundamentally broken in two different ways (quality and reliability).

### 2.2. Semantic Indexing System Failure

- **Symptom:** The "indexing" status badge on session cards never changes or completes. It remains perpetually stuck.
- **Root Cause Analysis (from Logs):** The service worker logs show a fatal error in the background indexing queue: `[CM:sw:bgIdx] indexing failed (non-fatal): Error: [CM:queue] Dropped: background queue overflow`. This means that as new sessions are captured, the indexing queue becomes overloaded and simply drops indexing jobs. The logs also show the system is unable to recover interrupted jobs on startup (`[CM:startup] giving up on chatgpt-a7c2827c13 after 3 retries`).
- **Severity:** Critical. Without a functioning index, Tier 3 migrations and semantic search cannot work.

### 2.3. Admin Panel & Remote Config API Non-Functional

- **Symptom:** The admin panel is completely broken. The user management page may show stale data. The `/admin/scrapers` page is empty, fails to save any changes, and does not display any of the automatically reported bug reports from the extension.
- **Root Cause Analysis (from Logs):** The browser console shows that all API requests to `/api/scraper-admin/*` endpoints are failing with a `403 (Forbidden)` error. This indicates a severe authentication/authorization issue on the backend. The API is not recognizing the logged-in user as an administrator, blocking all access to view or modify scraper configurations and bug reports. This failure also breaks the extension's ability to fetch remote updates for broken scrapers.
- **Severity:** Critical. Prevents all administration and the primary mechanism for remote-fixing broken scrapers.

## 3. Medium-Severity Regressions & Bugs

### 3.1. Migration Auto-Injection Failure

- **Symptom:** For Tier 2 and Tier 3 migrations, the small summary of the context is no longer being automatically injected into the target LLM's prompt input field. This was a previously working feature.
- **Root Cause Analysis (from Logs):** The service worker logs explicitly state the reason: `[CM:sw] Tier 2 skipAutoInject=true — injection deferred to MigrationModal button click`. The logic is intentionally preventing auto-injection. This suggests a flaw in the logic that determines whether to auto-inject or not.
- **Severity:** Medium. It breaks the user workflow and requires an extra manual step.

### 3.2. Claude Scraper is Broken

- **Symptom:** The Claude scraper is failing to find messages using its primary CSS selectors.
- **Root Cause Analysis (from Logs):** The web logs for `claude.ai` repeatedly show `[CM:claude] all selectors returned 0 — structural fallback will run next`. The extension logs confirm this with `UI Update Detected! Scraper broken on claude: Zero messages found after retries.` This is identical to the issue recently fixed for the Gemini scraper and is caused by a DOM update on the Claude website.
- **Severity:** Medium. Capture is still working via the structural fallback, but it is less reliable.

### 3.3. DOM Probe Feature Ineffective

- **Symptom:** The "Run DOM Probe" feature, intended for self-healing, is reportedly doing nothing.
- **Root Cause Analysis:** The implementation of the feature is likely incomplete or has a logic error preventing it from triggering, analyzing the DOM, or reporting its findings.
- **Severity:** Medium. The intended self-healing mechanism is not working.

### 3.4. Gemini Scraper Failure (Existing Sessions)

- **Symptom:** The extension fails to detect any messages in an existing, previously opened Gemini session. It only successfully captures messages in a brand new session.
- **Root Cause Analysis (from Logs):** The Gemini web logs show a complete failure of the primary selectors (`ZERO-SCRAPE: no selectors matched any nodes`) and a failure of the structural fallback (`too few substantial elements (0), skipping`). This indicates the DOM structure for a re-loaded Gemini session is different from a new one, and the current scrapers do not account for this.
- **Severity:** Critical. Prevents users from continuing work in existing conversations.

### 3.5. Intermittent Scraper & Capture Failure (ChatGPT)

- **Symptom:** Session detection on `chat.openai.com` is highly inconsistent. Sometimes new and existing sessions are detected, but often they are not. Manual file injection works, but the reliability of context migration is inconsistent.
- **Root Cause Analysis (from Logs):** This is a multi-faceted failure:
    1.  **Primary Scraper Broken:** The logs show `[CM:diag:chatgpt] strategy=1 user=0 asst=0`, confirming the primary CSS selector strategy has failed.
    2.  **Inconsistent Network Interceptor:** The `fetch` interceptor, which is the most reliable method, is only working sporadically. Logs show both successful captures (`fetch-tap user=13 asst=13`) and many failures (`no messages parsed`). This explains the inconsistent behavior.
    3.  **Virtual Scroll Issues:** The structural DOM scraper is being defeated by ChatGPT's virtual scrolling, often only seeing a fraction of the messages on screen (`suppressed shrinking scrape (16→8)`).
- **Severity:** High. The user experience is unpredictable, and reliable capture—the foundation of the extension—is compromised.

### 3.6. Total Scraper Failure (Perplexity)

- **Symptom:** The extension fails to detect any messages in existing Perplexity sessions. It only detects a new session after a message is sent. Manual injection for Tiers 1 & 2 works, but Tier 3 migration is completely broken.
- **Root Cause Analysis (from Logs):**
    1.  **Complete Scraper Failure:** The logs show all five scraping strategies (A-E) fail with zero messages found. The root cause is a `Selector not found: main` error, indicating a fundamental change in the Perplexity DOM that our scraper cannot handle.
    2.  **Systemic Trigger Issue:** This platform confirms a systemic architectural flaw. The extension is not re-evaluating pages on load, relying only on new network events to trigger capture. This is why only new sessions are detected.
    3.  **Tier 3 Timeout:** The failure of Tier 3 migration is confirmed to be caused by the same systemic `scoring timed out — heuristic fallback` issue in the Attention Engine that affects all other platforms.
- **Severity:** Critical. Capture is completely broken, and Tier 3 migration is non-functional.

### 3.7. Total Scraper Failure (Grok)

- **Symptom:** The extension fails to detect any messages in existing Groq sessions. It only detects a new session after a message is sent.
- **Root Cause Analysis (from Logs):**
    1.  **Complete Scraper Failure:** The logs show a `Selector not found: main` error, identical to the Perplexity failure. The fundamental DOM structure has changed, and the scraper is broken.
    2.  **Systemic Trigger Issue Confirmed:** This platform provides the final confirmation of a systemic architectural flaw. The extension is not re-evaluating pages on load, relying only on new network events to trigger capture.
    3.  **Virtual Scroll Vulnerability:** Logs show `suppressed shrinking scrape`, indicating the scraper is also vulnerable to virtual scroll issues.
- **Severity:** Critical. Capture is completely broken.

### 3.8. Inverted Scraper Failure (DeepSeek)

- **Symptom:** In a unique failure mode, the extension successfully captures existing DeepSeek conversations but fails to capture any new conversations that are started.
- **Root Cause Analysis (from Logs):**
    1.  **Inverted DOM Structure:** The web logs show a successful scrape (`strategy=B user=1 asst=2`) on an existing conversation but a complete failure (`NO messages found`) on a new one. This indicates the DOM for a new, empty chat is different from a populated one, and the scraper can only handle the latter.
    2.  **Broken Primary Selector:** Despite the partial success, the extension logs still report `UI Update Detected! Scraper broken on deepseek: Selector not found: main`. This confirms the scraper is fundamentally broken and its occasional success is accidental.
    3.  **Tier 3 Failure:** Logs confirm Tier 3 migration is broken due to the same systemic Attention Engine timeouts and `web-tree-sitter` failures seen on all other platforms.
- **Severity:** Critical. The inability to capture new conversations breaks the primary workflow.

### 3.9. File & Context Injection Failure (Gemini)

- **Symptom:** Manually or automatically injecting context (from any migration tier) into the Gemini prompt box fails.
- **Root Cause Analysis (from Logs):** The service worker logs show a generic `[CM:gemini] injection failed — reason: unknown`. This points to a failure in the content script responsible for interacting with the Gemini prompt input field.
- **Severity:** High. Blocks the primary migration workflow.


## 4. Log File References

- **Extension Logs:** Provided by user, detailing service worker errors.
- **Claude Web Logs:** `@/home/vip/Desktop/ContextMover/claude.ai-1780398526742.log`
