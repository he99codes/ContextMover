---
name: testing-web-api-security
description: Test ContextMover web API route security (auth guards, rate limiting, input sanitization, debug log removal). Use when verifying security-related changes to packages/web API routes.
---

# Testing ContextMover Web API Security

## Architecture Overview

- **Monorepo:** `packages/web` (Next.js 14), `packages/browser-extension`, `packages/mcp-server`
- **API routes:** `packages/web/src/app/api/` (Next.js App Router)
- **Auth:** Supabase auth via `@supabase/ssr` + custom helpers in `lib/payments/auth.ts` and `lib/usage/helpers.ts`
- **Rate limiting:** Upstash Redis sliding window in `lib/rate-limiter.ts` (falls back to in-process Map if `UPSTASH_REDIS_REST_URL` is not set); keyed by user ID when authenticated, IP otherwise
- **Email:** ZeptoMail SMTP via nodemailer in `lib/mailer.ts`
- **Payments:** Razorpay webhooks in `app/api/webhooks/razorpay/`

## Running the Dev Server Without Secrets

The Next.js middleware (`src/middleware.ts`) creates a Supabase client and redirects unauthenticated users. To bypass middleware for API testing:

1. Create `packages/web/.env.local` with **empty** Supabase vars:
   ```
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_ANON_KEY=
   SUPABASE_SERVICE_ROLE_KEY=
   NEXT_PUBLIC_APP_URL=http://localhost:3000
   ```
2. Middleware lines 23-28 check if env vars are falsy and skip auth if so → all requests pass through to route handlers.
3. **Do NOT** use placeholder strings like `your_supabase_project_url` — the Supabase SDK validates URL format and will crash the middleware.
4. Start: `cd packages/web && npx next dev --port 3000`

### What works without secrets
- Auth guards that check `Authorization` header before calling Supabase (e.g., `getAuthUser` returns `null` if no header)
- Rate limiting (falls back to IP-based key in catch block)
- Pure utility functions (e.g., `escapeHtml`)
- Static code verification via grep

### What doesn't work without secrets
- Any route that calls `createAdminClient()` or `createClient()` for DB operations (returns 500)
- Email sending (requires `ZEPTO_SMTP_PASSWORD`)
- Webhook signature verification (requires `RAZORPAY_WEBHOOK_SECRET`)

## Testing Patterns

### Auth Guard Testing
For routes that added auth guards (e.g., `getAuthUser(req)`):
```bash
# Should return 401 on protected routes
curl -s -w '\nHTTP_CODE:%{http_code}' http://localhost:3000/api/payments/subscription-count
```
The guard checks `Authorization` header before any Supabase call, so it works without real credentials.

### Rate Limit Testing
For routes with `checkRateLimit(req, userId, maxRequests)`:
```bash
# Send maxRequests+2 rapid requests, verify the (maxRequests+1)th returns 429
for i in $(seq 1 7); do
  curl -s -w '\nHTTP:%{http_code}' -X POST http://localhost:3000/api/support/bug-report \
    -H 'Content-Type: application/json' \
    -d '{"description":"Test report number '$i'"}'
done
```
Rate limiter uses Upstash Redis when `UPSTASH_REDIS_REST_URL` is set, falls back to in-process Map (sufficient for local testing).

### Before/After Comparison
The strongest proof for security fixes is comparing behavior between `main` and the PR branch:
1. Test on PR branch, record HTTP status codes
2. `git checkout main`, restart dev server
3. Repeat same curl commands
4. Compare: e.g., 401 vs 200 proves auth guard is new

### escapeHtml Testing
The `escapeHtml` function in `lib/mailer.ts` is pure — test via Node.js:
```bash
node -e "function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;'); } console.log(escapeHtml('<script>alert(1)</script>'))"
```

### Static Code Verification
For log removal, guard changes, and type changes:
```bash
grep -n 'auth-debug' packages/web/src/lib/usage/helpers.ts
grep -n 'NODE_ENV' packages/web/src/app/api/webhooks/razorpay/route.ts
```

## Devin Secrets Needed

No secrets are strictly required for security guard testing. For full end-to-end testing:
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` — for DB operations
- `ZEPTO_SMTP_PASSWORD` — for email sending verification
- `RAZORPAY_WEBHOOK_SECRET` — for webhook signature verification

## Key Files

| File | Purpose |
|------|---------|
| `packages/web/src/middleware.ts` | Auth middleware — skip logic on lines 23-28 |
| `packages/web/src/lib/rate-limiter.ts` | In-memory rate limiter with IP fallback |
| `packages/web/src/lib/payments/auth.ts` | `getAuthUser()` — checks Authorization header |
| `packages/web/src/lib/usage/helpers.ts` | `getAuthUserFromRequest()` — alternative auth helper |
| `packages/web/src/lib/mailer.ts` | `escapeHtml()` + email sending |
| `packages/web/src/app/api/webhooks/razorpay/route.ts` | Webhook signature verification |

## CI

- `pnpm run lint` — ESLint (pre-existing lint errors in browser-extension package; web package is clean)
- `pnpm run build` — Next.js build + extension build
- Pipeline Tests, Web Build, Extension Build, GitGuardian checks run on PRs
- Vercel deployment may fail if Git author email doesn't match a GitHub account — this is infrastructure, not code
