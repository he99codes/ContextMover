# ContextMover Security Audit Report

## Summary

Scanned the full monorepo (browser-extension, web/Next.js, MCP server, Supabase migrations). Found **6 critical**, **4 medium**, and **3 low-severity** issues. Will fix the critical ones in a PR.

---

## CRITICAL Issues (fixing in PR)

### 1. Token prefix leaked in server logs — `helpers.ts`
**File:** `packages/web/src/lib/usage/helpers.ts:79-81`
```ts
console.log("[auth-debug] token length:", token.length);
console.log("[auth-debug] token prefix:", token.slice(0, 20));
```
The first 20 characters of every user's JWT are written to server logs on every authenticated request. An attacker with log access can reconstruct tokens. **Fix: Remove all debug logs.**

### 2. Token metadata leaked in extension service-worker logs
**File:** `packages/browser-extension/src/background/service-worker.ts:1087-1107`
```ts
console.log("[CM:debug] getSession result:", { hasSession: ..., hasToken: ..., tokenLen: ... });
console.log("[CM:debug] fallback to storage, token:", typeof accessToken, "len:", ...);
console.log("[CM:debug] final accessToken:", typeof accessToken, "truthy:", !!accessToken, "len:", ...);
```
Leaks token presence/length info to devtools console. **Fix: Remove debug logs.**

### 3. HTML injection in email templates — `contact/route.ts`, `feedback/route.ts`, `refund-request/route.ts`
**Files:**
- `packages/web/src/app/api/contact/route.ts:45-49`
- `packages/web/src/app/api/feedback/route.ts:42-47`
- `packages/web/src/app/api/payments/refund-request/route.ts:45`

User-supplied `name`, `email`, `message`, `reason` fields are interpolated directly into HTML emails without escaping:
```ts
html: `<p><strong>Name:</strong> ${name.trim()}</p>`
```
An attacker can inject `<script>`, `<img onerror=...>`, or phishing links into admin-received emails. **Fix: Escape all user input before embedding in HTML.**

### 4. Bug report endpoint missing rate limiting — `support/bug-report/route.ts`
**File:** `packages/web/src/app/api/support/bug-report/route.ts`
No `checkRateLimit` call. An unauthenticated attacker can flood the DB with bug reports and spam the admin email. The `user_id` field from the request body is trusted without verification (line 19: `body.user_id`). **Fix: Add rate limiting + stop trusting client-supplied user_id.**

### 5. Unauthenticated data exposure — `subscription-count/route.ts`
**File:** `packages/web/src/app/api/payments/subscription-count/route.ts`
Returns the exact count of active paying subscribers with no auth and no rate limiting. This leaks sensitive business metrics to anyone. **Fix: Add auth + rate limiting.**

### 6. Webhook signature bypass in dev — `webhooks/razorpay/route.ts`
**File:** `packages/web/src/app/api/webhooks/razorpay/route.ts:48-53`
When `RAZORPAY_WEBHOOK_SECRET` is not set, signature verification is completely skipped (even in staging/preview deployments). This allows forged webhook events. **Fix: Require the secret in all environments except explicit local dev.**

---

## MEDIUM Issues (noted, not fixing in this PR)

### 7. `subscription-count` leaks business intelligence
Even after adding auth, consider whether this endpoint is necessary at all — it exposes subscriber counts.

### 8. Non-null assertions on env vars (`process.env.X!`)
Multiple API routes use `process.env.NEXT_PUBLIC_SUPABASE_URL!` without null checks. If a deploy is misconfigured, this crashes at runtime with an unhelpful error instead of a clear message. Files: `cancel/route.ts`, `usage/route.ts`, `verify-subscription/route.ts`, `create-subscription/route.ts`.

### 9. In-memory rate limiter resets on cold starts
`rate-limiter.ts` uses a `Map` in-process — every serverless cold start resets all counters. An attacker can exploit this by waiting for scale-down. Recommend Upstash Redis or similar.

### 10. `mock-upgrade` endpoint guarded only by `NODE_ENV`
`packages/web/src/app/api/payments/mock-upgrade/route.ts` — if `NODE_ENV` is not set to `"production"` on a preview/staging deploy, this endpoint is live and allows free Pro upgrades.

---

## LOW Issues (informational)

### 11. CORS allows all `chrome-extension://` origins
`mcp-server/src/bridge/extension-bridge.ts:67` — any Chrome extension can POST to the bridge. However, the bridge is localhost-only (127.0.0.1), so network exposure is minimal.

### 12. `dangerouslySetInnerHTML` for JSON-LD
`packages/web/src/app/page.tsx:58` — uses `dangerouslySetInnerHTML` but only with `JSON.stringify(JSON_LD)` (safe, no user input). Low risk.

### 13. `.env.example` contains placeholder values resembling real keys
Not a leak, but `rzp_test_your_key_id_here` patterns could confuse new contributors into thinking these are real.

---

## What's Already Good

- **Supabase RLS**: Properly enabled on all tables with `FOR ALL` owner-only policies.
- **Admin guard**: All `/api/admin/*` routes use `requireAdmin()` with email-based verification.
- **Env guard**: `env-guard.ts` prevents `NEXT_PUBLIC_` prefixed secrets from leaking to the client bundle.
- **Webhook signature**: Uses `crypto.timingSafeEqual` (constant-time comparison).
- **Rate limiting**: Most API routes have `checkRateLimit()`.
- **Telemetry sanitizer**: Whitelists safe keys before logging.
- **No SQL injection**: Supabase client uses parameterized queries exclusively.
- **No hardcoded secrets**: All keys are in env vars, `.env` files are gitignored.
