# Security Hardening PR #2 — Test Report

**Method:** Ran local Next.js dev server on both `main` and PR branch (`devin/1780641665-security-hardening`) with empty Supabase env vars (middleware skips auth, API routes reachable). Tested via curl + Node.js scripts. No UI changes — all testing is shell-based.

---

## Test Results

### Test 1: subscription-count auth guard — PASSED

`GET /api/payments/subscription-count` without Authorization header.

| Branch | HTTP Status | Response Body |
|--------|------------|---------------|
| **main** (before) | `200` | `{"activeCount":0}` |
| **PR** (after) | `401` | `{"error":"Unauthorized"}` |

**Assertion:** Endpoint returns 401 without auth on PR branch, was completely open on main. **Passed.**

---

### Test 2: bug-report rate limiting — PASSED

Sent 7 rapid `POST /api/support/bug-report` requests with valid payloads.

| Branch | Requests 1–5 | Request 6 | Request 7 |
|--------|-------------|-----------|-----------|
| **main** (before) | `500` (no rate limit) | `500` (no rate limit) | `500` (no rate limit) |
| **PR** (after) | `500` (rate limit passed) | `429` ("Too many requests") | `429` |

**Assertion:** 6th request returns 429 on PR branch; all 7 return 500 on main (no rate limiter). **Passed.**

---

### Test 3: escapeHtml XSS prevention — PASSED

Tested the `escapeHtml()` function from `mailer.ts` with 5 payloads:

| Test Case | Input | Expected Output | Result |
|-----------|-------|-----------------|--------|
| XSS script injection | `<script>alert("xss")</script>` | `&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;` | **PASS** |
| Mixed HTML entities | `"hello" & 'world'` | `&quot;hello&quot; &amp; &#39;world&#39;` | **PASS** |
| Normal text | `normal text no special chars` | `normal text no special chars` | **PASS** |
| Nested HTML with attributes | `<img src=x onerror=alert(1)>` | `&lt;img src=x onerror=alert(1)&gt;` | **PASS** |
| All 5 entities | `<div class="test">&amp;'s</div>` | `&lt;div class=&quot;test&quot;&gt;&amp;amp;&#39;s&lt;/div&gt;` | **PASS** |

**Assertion:** All 5 HTML entity types (`&`, `<`, `>`, `"`, `'`) correctly escaped. **Passed.**

---

### Test 4: Debug log removal — PASSED

Grepped for removed debug log patterns across branches.

**`helpers.ts` — `[auth-debug]` logs:**

| Branch | Matches |
|--------|---------|
| **main** | 5 matches (lines 79–81, 88–89): `token prefix`, `token length`, `header present`, `getUser error`, `user found` |
| **PR** | 0 matches |

**`service-worker.ts` — `[CM:debug]` logs:**

| Branch | Matches |
|--------|---------|
| **main** | 4 matches (lines 1087, 1099, 1102, 1107): `getSession result`, `fallback to storage`, `getSession threw`, `final accessToken` |
| **PR** | 0 matches |

**Assertion:** All token-leaking debug logs removed. **Passed.**

---

### Test 5: Webhook signature guard tightening — PASSED

Grepped `NODE_ENV` guard in `webhooks/razorpay/route.ts`:

| Branch | Guard Expression | Effect |
|--------|-----------------|--------|
| **main** | `=== "production"` | Only blocks production — staging/preview environments skip signature verification |
| **PR** | `!== "development"` | Blocks everything except explicit dev mode |

**Assertion:** Guard changed from `=== "production"` to `!== "development"`. **Passed.**

*Note: Cannot test via curl because local dev server runs with `NODE_ENV=development` (skips guard by design). Behavioral difference only applies to staging/preview/production.*

---

### Test 6: user_id trust removal in bug-report — PASSED

Compared request body type definition in `bug-report/route.ts`:

| Branch | Body Type Includes `user_id`? | userId Derivation |
|--------|------------------------------|-------------------|
| **main** | Yes — `user_id?: string` in body type | `body.user_id` trusted if present, falls back to auth token |
| **PR** | No — `user_id` removed from body type | Derived only from auth token (`admin.auth.getUser(token)`) |

**Assertion:** Client-supplied `user_id` no longer accepted. **Passed.**

---

## Summary

| # | Test | Result |
|---|------|--------|
| 1 | subscription-count auth guard | **PASSED** |
| 2 | bug-report rate limiting (5/min) | **PASSED** |
| 3 | escapeHtml XSS prevention | **PASSED** |
| 4 | Debug log removal | **PASSED** |
| 5 | Webhook signature guard tightening | **PASSED** |
| 6 | user_id trust removal | **PASSED** |

**All 6 tests passed.** Every security fix is verified with before/after evidence against the main branch.

### Limitations
- Supabase/Razorpay/SMTP secrets were unavailable, so API routes that depend on database operations return 500 after passing security guards. The security guards (auth check, rate limiter) execute before Supabase calls, which is sufficient to prove they work.
- Webhook guard could not be tested at runtime (dev server uses `NODE_ENV=development`). Verified via static code analysis with before/after grep.
- No UI changes to test — all fixes are server-side API route logic.
