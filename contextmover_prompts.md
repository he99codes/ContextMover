# CONTEXTMOVER — MASTER PROMPT LIBRARY
Last updated: 2026-05-21
Maintained by: Claude Sonnet 4.6

---

## HOW TO USE THIS FILE

1. Pick a prompt from PENDING section
2. Ask Claude: "Give me the Windsurf prompt for [PROMPT_ID]"
3. Run it in Windsurf with the assigned model
4. Move prompt to COMPLETED with date

## MODEL ASSIGNMENT GUIDE

| Task Type | Model | Thinking |
|---|---|---|
| Complex architecture, multi-file | Opus 4.6 | ON |
| Logic bugs, audits | Sonnet 4.6 | ON |
| Simple UI, text changes | Sonnet 4.6 | OFF |
| Planning, docs, this file | Kimi K2 | — |
| Security, critical fixes | Opus 4.6 | ON |

---

## PENDING PROMPTS

---

### [P001] CRITICAL — Fix @xenova/transformers broken on all platforms
**Priority:** P0 — blocks semantic indexing entirely
**Model:** Opus 4.6, Thinking ON
**Files:** service-worker.ts, semantic-index.ts, offscreen.ts, offscreen.html, vite.config.ts
**Problem:**
- `Failed to resolve module specifier '@xenova/transformers'` on every session
- `ReferenceError: document is not defined` in service worker
- Semantic indexing (Tier 3) completely broken — falls back to Tier 1 always
- 94% context compression on every migration
**Fix needed:**
- Bundle @xenova/transformers into offscreen chunk (not external specifier)
- Remove all ML initialization from service worker context
- Remove in-process fallback that calls document.* in SW
- Replace with BM25 keyword fallback when offscreen fails
- Verify WASM files copied to dist correctly
**Status:** [ ] Pending

---

### [P002] HIGH — user=0 on Grok, Perplexity, DeepSeek
**Priority:** P1 — migrations missing all user messages
**Model:** Sonnet 4.6, Thinking ON
**Files:** grok.ts, perplexity.ts, deepseek.ts
**Problem:**
- Grok: total=26, user=0, assistant=26
- Perplexity: total=5, user=0, assistant=5
- DeepSeek: total=2, user=0, assistant=2
- User messages not captured → migrated context has answers with no questions
**Fix needed:**
- Fix user message selectors for all 3 platforms (3 fallback chain each)
- Add MutationObserver retry if user=0 after first scrape
- Add DOM inspection logging for future debugging
**Status:** [ ] Pending

---

### [P003] HIGH — XML file migration broken on Gemini, Grok, Perplexity, DeepSeek
**Priority:** P1 — core feature broken for 4 platforms
**Model:** DeepSeek V3, Thinking ON
**Files:** migrate-context.ts, gemini.ts, grok.ts, perplexity.ts, deepseek.ts, claude.ts (ref), chatgpt.ts (ref)
**Problem:**
- Single-click XML file injection fails on all 4 platforms
- Download fallback may not be triggering correctly
- Text migration (Tier 1/2) also broken on these platforms
- No drag and drop (intentionally removed) — do not re-add
**Architecture:**
- Single click → attempt XML file injection via DataTransfer
- On failure → auto-trigger XML download + show sidebar message
- Text migration = separate path using summarized/attention output
**Fix needed:**
- Audit file injection vs working Claude/ChatGPT pattern
- Fix per-platform: file input selector, DataTransfer injection, submit
- Fix download fallback: auto-trigger + correct sidebar message
- Fix text injection: correct selector + React-compatible method per platform
**Status:** [ ] Pending

---

### [P004] HIGH — Migration injection timeout
**Priority:** P1
**Model:** Sonnet 4.6, Thinking ON
**Files:** service-worker.ts, migrate-context.ts
**Problem:**
- `Tab injection attempt 1/3 failed: Injection timed out after 10s`
- Target tab content script not ready when injection starts
**Fix needed:**
- Wait for tab.status === 'complete' before first attempt
- Ping tab and wait for CM_DIAG script-loaded before injecting
- Exponential backoff: 2s → 4s → 8s
- On all 3 failures: show user "Tab not ready — please try again"
**Status:** [ ] Pending

---

### [P005] MEDIUM — Claude always using fallback A selector
**Priority:** P2
**Model:** Sonnet 4.6, Thinking OFF
**Files:** claude.ts
**Problem:**
- Primary Claude selector never matches — always fallback A (.font-claude-response)
- One DOM update from total capture failure
**Fix needed:**
- Fix primary selector to [data-testid="assistant-message"]
- Add third fallback: div[class*="prose"] inside message container
- Add logging: "primary selector matched: X elements"
**Status:** [ ] Pending

---

### [P006] MEDIUM — Summarization: hardcoded vs transformer audit
**Priority:** P2
**Model:** Opus 4.6, Thinking ON
**Files:** summarizer.ts, attention-engine.ts, usage-client.ts, semantic-index.ts
**Problem:**
- Unknown whether summarization uses transformer embeddings or hardcoded patterns
- Tier 1 hard limit: head=3/tail=6 (should be head=5/tail=10)
- Middle messages dropped entirely — quality loss on long sessions
- Need comparison: hardcoded regex extraction vs transformer-based scoring
**Fix needed:**
- Audit: is attention engine actually using embeddings from indexing?
- Or is it using hardcoded signal patterns only (error/decision/code keywords)?
- Compare output quality: run both on same session, measure what gets kept
- If transformer not wired into attention: wire it in
- Fix head/tail limits: head=5, tail=10
- Use embedding similarity scores to select top middle messages (not just drop all)
- Add logging: [CM:summarizer] method=transformer/hardcoded, kept=X/Y messages
**Status:** [ ] Pending

---

### [P007] HIGH — Razorpay: remove all plans, keep only 3 clean plans
**Priority:** P1 — billing must be clean before launch
**Model:** Sonnet 4.6, Thinking ON
**Files:** 
- packages/web/src/lib/payments/ (all files)
- packages/web/src/app/api/payments/ (all routes)
- packages/web/src/app/(dashboard)/pricing/ (pricing page)
- packages/browser-extension/src/sidebar/ (upgrade UI)
- Any file referencing plan names, plan IDs, or Razorpay plan constants
**Problem:**
- Multiple old plans exist in codebase
- Need to clean to exactly 3 plans only
**New plan structure (ONLY these 3):**

| Plan | Type | Price | Billing |
|---|---|---|---|
| Free | Free forever | ₹0 | — |
| Pro Monthly | Auto-pay subscription | ₹299/month | Monthly recurring |
| Pro Annual | Auto-pay subscription | ₹2399/year | Annual recurring |

**Fix needed:**
- Remove ALL other plan references from entire codebase
- Create/update Razorpay plan IDs for Pro Monthly (₹299) and Pro Annual (₹2399)
- Both paid plans must be AUTO-PAY subscriptions (not one-time payments)
- Update pricing page to show exactly these 3 plans
- Update subscription check logic to recognize new plan IDs only
- Update sidebar upgrade prompts to reference correct plans
- Update webhook handler to handle subscription events for these 2 plans
- Add constants file: PLANS.ts with plan IDs, prices, names — single source of truth
- Remove any hardcoded old prices (₹499, ₹999, any other amounts)
**Razorpay access:** Full access confirmed — can create/modify plans directly
**Status:** [ ] Pending

---

### [P008] LOW — Remote config: selectors.json setup
**Priority:** P3
**Model:** Sonnet 4.6, Thinking OFF
**Files:** remote-config.ts, packages/web/public/config/selectors.json
**Problem:**
- Remote config architecture was designed but may not be fully wired
- Need to verify content scripts actually read from remoteConfig first
**Fix needed:**
- Verify all content scripts use getSelectors() not hardcoded strings
- Verify selectors.json is served correctly at /config/selectors.json
- Verify 1-hour cache refresh works
- Verify hot reload on CONFIG_UPDATED fires correctly
**Status:** [ ] Pending

---

### [P009] LOW — Migration quality warning UI
**Priority:** P3
**Model:** Sonnet 4.6, Thinking OFF
**Files:** sidebar migration component
**Problem:**
- When falling back to Tier 1 (Tier 3 broken), user gets 94% compressed 
  context with no warning
**Fix needed:**
- Show badge in sidebar: "Context: Compressed (Tier 1)" when Tier 3 unavailable
- Show badge: "Full Context (Tier 3)" when semantic indexing works
**Status:** [ ] Pending

---

## COMPLETED PROMPTS

---

### [DONE-001] Copyright headers on all 181 files
**Completed:** 2026-05-18
**Model:** Sonnet 4.6
**Result:** 181 files updated with © 2026 ContextMover header

### [DONE-002] Build obfuscation (vite.config.ts)
**Completed:** 2026-05-18
**Model:** Sonnet 4.6
**Result:** controlFlowFlattening, stringArray, base64 encoding — prod only

### [DONE-003] Server-side IP protection
**Completed:** 2026-05-18
**Model:** Sonnet 4.6
**Result:** /api/attention/score, /api/summarize, /api/migrate/build created

### [DONE-004] Shadow DOM closed on sidebar
**Completed:** 2026-05-18
**Result:** attachShadow({ mode: 'closed' })

### [DONE-005] Remove .env files from git + history purge
**Completed:** 2026-05-21
**Result:** filter-repo run, dist.pem/crx/zip untracked, .gitignore hardened

### [DONE-006] Claude selector chain (fallback A working)
**Completed:** 2026-05-18
**Result:** 3-selector chain, pendingCaptureAfterStream retry

### [DONE-007] Indexing queue (serial, no freeze)
**Completed:** 2026-05-18
**Result:** _indexQueue gate, 2s delay on minimal tier

### [DONE-008] Drive OAuth — remove getAuthToken, use launchWebAuthFlow
**Completed:** 2026-05-18
**Result:** chrome.identity.getAuthToken fully removed

### [DONE-009] Summarization head/tail fix
**Completed:** 2026-05-18
**Result:** head=5, tail=10 (was 3/6), signal-scored middle messages

### [DONE-010] Support page
**Completed:** 2026-05-18
**Result:** /support page created, FAQ + contact + policy links

---

## WEEKLY EXECUTION PLAN

### When Opus 4.6 quota available (best quality):
Run in order: P001 → P006 → P007

### When only Sonnet 4.6 available:
Run in order: P002 → P004 → P005 → P007 → P008 → P009

### When only DeepSeek V3 available:
Run: P003

### When only Kimi K2 available:
- Update this file with new prompts
- Ask Claude to generate prompt text for any new issue
- Plan next sprint

---

## NOTES

- Repo: github.com/he99codes/Context_flow (PRIVATE — confirmed)
- Support: hey@contextmover.com
- Production URL: https://contextmover.com
- Razorpay: full access confirmed 2026-05-21
- Chrome Store: not yet submitted (pending P001, P002, P003 fixes)
- Do NOT submit to Chrome Store until P001 and P002 are resolved