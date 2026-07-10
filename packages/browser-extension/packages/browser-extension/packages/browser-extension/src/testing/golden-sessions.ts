/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/testing/golden-sessions.ts
// Hardcoded golden test conversations for migration quality testing.
// These sessions are READ-ONLY and never written to production storage.

import type { ContextSession, Message } from "@/lib/types";

const T0 = 1_700_000_000_000; // fixed base timestamp for reproducibility
const msg = (role: Message["role"], content: string, offset = 0): Message => ({
  role, content, timestamp: T0 + offset * 60_000,
});

// ─────────────────────────────────────────────────────────────────────────────
// SESSION 1 — short-clean (10 messages, no code)
// ─────────────────────────────────────────────────────────────────────────────
const session1: ContextSession = {
  id: "golden-1",
  platform: "claude",
  title: "short-clean",
  createdAt: T0,
  updatedAt: T0 + 9 * 60_000,
  messages: [
    msg("user",      "I want to set up a new TypeScript monorepo for our team. We need pnpm workspaces, a shared utils package, and two apps.", 0),
    msg("assistant", "Good choice. pnpm workspaces are ideal for this. The important thing to note: you must use Node.js 18+ for the latest pnpm v8 features. I'll walk you through the structure.", 1),
    msg("user",      "Should we use Turborepo or Nx for task orchestration?", 2),
    msg("assistant", "Going with Turborepo here — it integrates with pnpm natively and has simpler config than Nx. The deciding factor: Nx requires a lot of config files whereas Turbo uses a single turbo.json. We decided against Nx for this project.", 3),
    msg("user",      "What about shared ESLint config?", 4),
    msg("assistant", "Create a packages/eslint-config package. Each app extends it. This ensures consistent linting rules across the monorepo.", 5),
    msg("user",      "And TypeScript config sharing?", 6),
    msg("assistant", "Same pattern — a packages/tsconfig package. Apps extend via `extends: @repo/tsconfig/base.json`. Note that each app still needs its own tsconfig.json to specify include paths.", 7),
    msg("user",      "Perfect. What's the next step?", 8),
    msg("assistant", "Next step: run `pnpm init` at the root, create pnpm-workspace.yaml with `packages: ['apps/*', 'packages/*']`, then scaffold each workspace package.", 9),
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// SESSION 2 — medium-code (40 messages, 4 code blocks)
// ─────────────────────────────────────────────────────────────────────────────
const session2Messages: Message[] = [
  msg("user",      "I'm getting a TypeScript error in my React component. The error says: Type 'string | undefined' is not assignable to type 'string'.", 0),
  msg("assistant", "That's a strict null check. The fix is to add a non-null assertion or a default value. Here's the pattern you should use.", 1),
  msg("user",      "Show me the broken code first.", 2),
  msg("assistant", `Here's the broken code that causes the error:\n\`\`\`typescript\n// src/components/UserCard.tsx\ninterface Props {\n  userId: string | undefined;\n}\n\nfunction UserCard({ userId }: Props) {\n  const url = \`/api/users/\${userId}\`; // Error: userId may be undefined\n  return <div>{url}</div>;\n}\n\`\`\``, 3),
  msg("user",      "And the fix?", 4),
  msg("assistant", `Here's the fixed version:\n\`\`\`typescript\n// src/components/UserCard.tsx\ninterface Props {\n  userId?: string;\n}\n\nfunction UserCard({ userId }: Props) {\n  if (!userId) return null;\n  const url = \`/api/users/\${userId}\`;\n  return <div>{url}</div>;\n}\n\`\`\`\nFixed by adding an early return guard. This is the idiomatic React pattern.`, 5),
  msg("user",      "Got it. Now I need to fetch user data. What's the API endpoint?", 6),
  msg("assistant", "The API endpoint is https://api.example.com/v2/users/{id}. Note that the version is v2 — the v1 endpoint is deprecated. You must include an Authorization header.", 7),
  msg("user",      "What auth header format?", 8),
  msg("assistant", "Bearer token: `Authorization: Bearer <your_token>`. The token requires the `users:read` scope.", 9),
  msg("user",      "Let me write the fetch hook.", 10),
  msg("assistant", `Here's the custom hook:\n\`\`\`typescript\n// src/hooks/useUser.ts\nimport { useState, useEffect } from 'react';\n\ninterface User {\n  id: string;\n  name: string;\n  email: string;\n}\n\nexport function useUser(userId: string | undefined) {\n  const [user, setUser] = useState<User | null>(null);\n  const [loading, setLoading] = useState(false);\n\n  useEffect(() => {\n    if (!userId) return;\n    setLoading(true);\n    fetch(\`https://api.example.com/v2/users/\${userId}\`, {\n      headers: { Authorization: \`Bearer \${getToken()}\` },\n    })\n      .then((r) => r.json())\n      .then(setUser)\n      .finally(() => setLoading(false));\n  }, [userId]);\n\n  return { user, loading };\n}\n\`\`\``, 11),
  msg("user",      "Why useState instead of useReducer here?", 12),
  msg("assistant", "Going with useState here — the state is simple enough that useReducer would be overkill. We decided against useReducer for this hook because there are only two state variables.", 13),
];

// Fill messages 14–39 with realistic discussion
const session2Filler: Message[] = Array.from({ length: 27 }, (_, i) => {
  const isUser = i % 2 === 0;
  const idx = i + 14;
  const contents = [
    "How do I handle the loading state in the UI?",
    "Use a skeleton component. Opted for a CSS-based skeleton instead of a spinner for better UX.",
    "Should I add error handling to the hook?",
    "Yes. Add a `error` state. Using try/catch in the useEffect is the right approach here.",
    "What about request cancellation?",
    "Use AbortController. This prevents memory leaks when the component unmounts.",
    "Let me add TypeScript generics to make this reusable.",
    "Good idea. The generic version: `useApi<T>(url: string): { data: T | null, loading: boolean, error: Error | null }`",
    "Does this work with React Query?",
    "Yes, but switching to React Query for data fetching would be cleaner. We opted for the custom hook first to keep dependencies minimal.",
    "How do I test this hook?",
    "Use renderHook from @testing-library/react. Mock fetch with jest.spyOn.",
    "What version of React Testing Library?",
    "Requires version 14+. The current version is 14.2.1 — make sure your package.json requires ^14.0.0.",
    "Added the tests. They're passing.",
    "Here's what we implemented: custom useUser hook with TypeScript generics, loading/error states, AbortController cleanup, and unit tests.",
    "Next step is to integrate into the UserCard component.",
    "Correct. Import useUser in UserCard and replace the hardcoded URL.",
    "Done. The component is now using the hook.",
    "Created the updated UserCard.tsx with hook integration. The type errors are resolved.",
    "Should we add storybook stories?",
    "That's a good next step — todo: add Storybook stories for UserCard loading, error, and success states.",
    "Agreed. I'll add those in the next session.",
    "The remaining work: Storybook stories, e2e tests with Playwright, and documentation.",
    "Perfect. Let's move on to the next feature.",
    "Still need to add error boundary wrapping around UserCard components.",
    "Right. Error boundaries are pending — add them before the v2 release.",
    "Understood.",
  ];
  return msg(isUser ? "user" : "assistant", contents[i % contents.length], idx);
});

const session2: ContextSession = {
  id: "golden-2",
  platform: "chatgpt",
  title: "medium-code",
  createdAt: T0,
  updatedAt: T0 + 39 * 60_000,
  messages: [...session2Messages, ...session2Filler],
};

// ─────────────────────────────────────────────────────────────────────────────
// SESSION 3 — long-dense (110 messages, 8 code blocks, 6 decisions, 5 facts)
// ─────────────────────────────────────────────────────────────────────────────
const codeBlocks3 = [
  `\`\`\`typescript\n// src/lib/auth.ts\nexport async function verifyToken(token: string): Promise<User | null> {\n  try {\n    const payload = jwt.verify(token, process.env.JWT_SECRET!);\n    return payload as User;\n  } catch {\n    return null;\n  }\n}\n\`\`\``,
  `\`\`\`typescript\n// src/middleware/auth.middleware.ts\nexport const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token) return res.status(401).json({ error: 'Unauthorized' });\n  const user = await verifyToken(token);\n  if (!user) return res.status(403).json({ error: 'Forbidden' });\n  req.user = user;\n  next();\n};\n\`\`\``,
  `\`\`\`sql\n-- migrations/001_create_users.sql\nCREATE TABLE users (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  email TEXT UNIQUE NOT NULL,\n  hashed_password TEXT NOT NULL,\n  created_at TIMESTAMPTZ DEFAULT NOW()\n);\n\`\`\``,
  `\`\`\`typescript\n// src/services/user.service.ts\nexport class UserService {\n  async createUser(email: string, password: string): Promise<User> {\n    const hashed = await bcrypt.hash(password, 12);\n    return this.db.users.create({ email, hashed_password: hashed });\n  }\n\n  async findByEmail(email: string): Promise<User | null> {\n    return this.db.users.findFirst({ where: { email } });\n  }\n}\n\`\`\``,
  `\`\`\`typescript\n// src/routes/auth.routes.ts\nrouter.post('/login', async (req, res) => {\n  const { email, password } = req.body;\n  const user = await userService.findByEmail(email);\n  if (!user) return res.status(404).json({ error: 'User not found' });\n  const valid = await bcrypt.compare(password, user.hashed_password);\n  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });\n  const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET!, { expiresIn: '7d' });\n  res.json({ token });\n});\n\`\`\``,
  `\`\`\`typescript\n// src/lib/rate-limiter.ts\nimport rateLimit from 'express-rate-limit';\nexport const loginRateLimiter = rateLimit({\n  windowMs: 15 * 60 * 1000,\n  max: 10,\n  message: 'Too many login attempts, please try again later',\n});\n\`\`\``,
  `\`\`\`typescript\n// tests/auth.test.ts\ndescribe('AuthService', () => {\n  it('creates user with hashed password', async () => {\n    const user = await userService.createUser('test@example.com', 'password123');\n    expect(user.email).toBe('test@example.com');\n    expect(user.hashed_password).not.toBe('password123');\n  });\n\n  it('verifies valid token', async () => {\n    const token = jwt.sign({ id: '1' }, process.env.JWT_SECRET!);\n    const result = await verifyToken(token);\n    expect(result).not.toBeNull();\n  });\n});\n\`\`\``,
  `\`\`\`dockerfile\n# Dockerfile\nFROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --only=production\nCOPY . .\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n\`\`\``,
];

const session3Core: Message[] = [
  msg("user",      "Building a full authentication system with JWT, bcrypt, rate limiting, and PostgreSQL. Let's start with the token verification logic.", 0),
  msg("assistant", `Here's the JWT verification function. Note that JWT_SECRET must be at least 256 bits — a short secret will fail in production.\n\n${codeBlocks3[0]}`, 1),
  msg("user",      "Good. Now the middleware.", 2),
  msg("assistant", `${codeBlocks3[1]}\n\nDecided against session-based auth here — JWT is stateless and scales better for our microservices setup. Going with JWT for all API authentication.`, 3),
  msg("user",      "Database schema?", 4),
  msg("assistant", `${codeBlocks3[2]}\n\nUsing PostgreSQL 15 — the gen_random_uuid() function requires pg_crypto extension which is enabled by default in Postgres 15+. The API endpoint for user management is /api/v1/users.`, 5),
  msg("user",      "Write the user service.", 6),
  msg("assistant", `${codeBlocks3[3]}\n\nHere's the UserService created. Using bcrypt cost factor 12 — that's the industry standard for production. Requires bcrypt version 5+.`, 7),
  msg("user",      "The login route.", 8),
  msg("assistant", `${codeBlocks3[4]}\n\nImplemented login route. Opted for 7-day token expiry instead of 1-hour to reduce friction for users. We decided against refresh tokens for the initial version.`, 9),
  msg("user",      "Add rate limiting.", 10),
  msg("assistant", `${codeBlocks3[5]}\n\nRate limiter added. The window is 15 minutes max 10 attempts — switching to a stricter 5-attempt limit would be better for security but we're sticking with 10 for the beta.`, 11),
  msg("user",      "Write the tests.", 12),
  msg("assistant", `${codeBlocks3[6]}\n\nHere's the test suite — tests are written and passing. All auth flows covered.`, 13),
  msg("user",      "Dockerize it.", 14),
  msg("assistant", `${codeBlocks3[7]}\n\nDockerfile created. Using node:20-alpine for minimal image size.`, 15),
];

// Generate 94 more filler messages for long-dense
const longFiller = Array.from({ length: 94 }, (_, i): Message => {
  const isUser = i % 2 === 0;
  const idx = i + 16;
  const pool = [
    ["How should I handle password reset?", "Use a time-limited reset token (15 min expiry) stored in Redis. The endpoint is /api/v1/auth/reset-password."],
    ["Should we add email verification?", "Yes. Opted for a 6-digit OTP instead of magic links — simpler to implement and works on mobile."],
    ["What about 2FA?", "Next step is to add TOTP-based 2FA using speakeasy. Still need to implement the QR code generation endpoint."],
    ["Is the auth middleware covering all routes?", "Here's what we covered: login, register, password reset. The profile and settings routes still need auth middleware applied."],
    ["Add CORS configuration.", "Going with cors package, allowing only our frontend domain. The cors version requires 2.8.5+."],
    ["How do we handle token refresh?", "Decided against refresh tokens initially — we'll add them in v2 if session expiry becomes a user complaint."],
    ["Tests are failing in CI.", "The issue is the JWT_SECRET env var not being set in the test environment. Next step is to add a .env.test file."],
    ["Fixed the CI issue.", "Created .env.test with test-only secrets. All 18 tests are now passing. The pipeline is green."],
    ["Can we add logging?", "Using Winston. Opted for structured JSON logging instead of plaintext — easier to query in production."],
    ["What log levels?", "Error, warn, info, debug. The production environment must only use error and warn to avoid log flooding."],
    ["Add health check endpoint.", "Here's the health check: GET /health returns 200 with uptime, memory usage, and db connection status."],
    ["Database connection pooling?", "Using pg-pool. The pool requires a minimum of 2 and maximum of 10 connections — adjust based on server RAM."],
    ["Remaining work for v1 launch?", "Todo: add email verification, write OpenAPI docs, set up Sentry error monitoring, and load test with k6."],
    ["Good progress today.", "Here's a summary of what was implemented: JWT auth, bcrypt hashing, rate limiting, database schema, middleware, tests, and Docker."],
    ["Next session we tackle email.", "Agreed. Still need to integrate SendGrid for transactional emails. The API key must be kept in environment variables, never in code."],
  ];
  const pair = pool[Math.floor(i / 2) % pool.length];
  return msg(isUser ? "user" : "assistant", pair[isUser ? 0 : 1], idx);
});

const session3: ContextSession = {
  id: "golden-3",
  platform: "gemini",
  title: "long-dense",
  createdAt: T0,
  updatedAt: T0 + 109 * 60_000,
  messages: [...session3Core, ...longFiller],
};

// ─────────────────────────────────────────────────────────────────────────────
// SESSION 4 — code-heavy (30 messages, 10 code blocks)
// ─────────────────────────────────────────────────────────────────────────────
const mkCode = (n: number, lang: string, path: string, body: string) =>
  `\`\`\`${lang}\n// ${path}\n${body}\n\`\`\``;

const codeBlocks4 = [
  mkCode(1, "typescript", "src/store/index.ts",    "import { create } from 'zustand';\nexport const useStore = create<State>((set) => ({ count: 0, inc: () => set((s) => ({ count: s.count + 1 })) }));"),
  mkCode(2, "typescript", "src/store/slices/auth.ts", "export const authSlice = (set: SetState) => ({ user: null, setUser: (u: User) => set({ user: u }), clearUser: () => set({ user: null }) });"),
  mkCode(3, "typescript", "src/hooks/useAuth.ts",   "export const useAuth = () => useStore((s) => ({ user: s.user, setUser: s.setUser, clearUser: s.clearUser }));"),
  mkCode(4, "typescript", "src/components/Login.tsx", "export default function Login() {\n  const { setUser } = useAuth();\n  const onSubmit = async (data: LoginForm) => {\n    const user = await loginApi(data);\n    setUser(user);\n  };\n  return <form onSubmit={handleSubmit(onSubmit)}>...</form>;\n}"),
  mkCode(5, "typescript", "src/api/client.ts",     "export const apiClient = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL, timeout: 10000 });\napiClient.interceptors.request.use((c) => { c.headers.Authorization = `Bearer ${getToken()}`; return c; });"),
  mkCode(6, "typescript", "src/api/auth.ts",       "export const loginApi = (d: LoginForm) => apiClient.post<User>('/auth/login', d).then((r) => r.data);\nexport const logoutApi = () => apiClient.post('/auth/logout');"),
  mkCode(7, "typescript", "src/middleware.ts",     "export function middleware(req: NextRequest) {\n  const token = req.cookies.get('token')?.value;\n  if (!token && req.nextUrl.pathname.startsWith('/dashboard')) {\n    return NextResponse.redirect(new URL('/login', req.url));\n  }\n}"),
  mkCode(8, "typescript", "src/lib/tokens.ts",     "export const getToken = () => localStorage.getItem('cf_token');\nexport const setToken = (t: string) => localStorage.setItem('cf_token', t);\nexport const clearToken = () => localStorage.removeItem('cf_token');"),
  mkCode(9, "typescript", "src/types/auth.ts",     "export interface User { id: string; email: string; name: string; plan: 'free' | 'pro'; }\nexport interface LoginForm { email: string; password: string; }\nexport interface AuthState { user: User | null; setUser: (u: User) => void; clearUser: () => void; }"),
  mkCode(10,"typescript", "tests/auth.spec.ts",    "describe('auth store', () => {\n  it('sets user', () => {\n    const { result } = renderHook(() => useAuth());\n    act(() => result.current.setUser(mockUser));\n    expect(result.current.user).toEqual(mockUser);\n  });\n});"),
];

const session4Messages: Message[] = codeBlocks4.flatMap((code, i) => [
  msg("user",      i === 0 ? "Build a complete Zustand auth store with login, logout, and token management for a Next.js 14 app." : `Now write ${["the auth slice", "the useAuth hook", "the Login component", "the API client", "the auth API functions", "the Next.js middleware", "the token utilities", "the TypeScript types", "the unit tests"][i - 1]}.`, i * 3),
  msg("assistant", `Here's the implementation:\n\n${code}\n\n${i === 0 ? "Created the base Zustand store." : i === 9 ? "Here are the unit tests — all passing. Created the complete auth system." : `Created ${["auth slice", "useAuth hook", "Login component", "API client", "auth API", "Next.js middleware", "token utilities", "TypeScript types"][i - 1]}.`}`, i * 3 + 1),
  msg("user",      i < 9 ? "Looks good, continue." : "The entire auth system is done.", i * 3 + 2),
]);

const session4: ContextSession = {
  id: "golden-4",
  platform: "grok",
  title: "code-heavy",
  createdAt: T0,
  updatedAt: T0 + 29 * 60_000,
  messages: session4Messages.slice(0, 30),
};

// ─────────────────────────────────────────────────────────────────────────────
// SESSION 5 — decision-heavy (25 messages, no code)
// ─────────────────────────────────────────────────────────────────────────────
const session5: ContextSession = {
  id: "golden-5",
  platform: "deepseek",
  title: "decision-heavy",
  createdAt: T0,
  updatedAt: T0 + 24 * 60_000,
  messages: [
    msg("user",      "We need to choose a database for our real-time collaborative note-taking app. Options are: Supabase, Firebase, PlanetScale, or self-hosted Postgres.", 0),
    msg("assistant", "Going with Supabase — it gives us Postgres, real-time subscriptions, and auth all in one. The main trade-off is vendor lock-in, but the productivity gain outweighs it for our timeline.", 1),
    msg("user",      "Good. For the frontend state, Redux or Zustand?", 2),
    msg("assistant", "Opted for Zustand — Redux is overkill for our app complexity. The bundle size is 1KB vs Redux Toolkit's 12KB. We decided against Redux because the boilerplate slows us down.", 3),
    msg("user",      "Real-time sync approach: WebSockets or SSE?", 4),
    msg("assistant", "Sticking with Supabase's real-time (WebSockets under the hood). We looked at implementing raw SSE but switching to the Supabase subscription API saves us 2-3 days of infra work.", 5),
    msg("user",      "How should we handle offline mode?", 6),
    msg("assistant", "Going with a local-first approach using IndexedDB for offline storage. Opted for Dexie.js as the IndexedDB wrapper — it has the best TypeScript support and conflict resolution primitives.", 7),
    msg("user",      "Conflict resolution strategy?", 8),
    msg("assistant", "Switching to CRDT-based merging instead of last-write-wins. We decided against last-write-wins after seeing it cause data loss in our prototype. Using Yjs for the CRDT implementation.", 9),
    msg("user",      "What about search? Algolia or in-house?", 10),
    msg("assistant", "Opted for Algolia for search — the instant search UX is too good to build ourselves. The cost is acceptable at our expected scale. We decided against building full-text search on Postgres because it lacks faceting.", 11),
    msg("user",      "Deployment: Vercel or AWS?", 12),
    msg("assistant", "Going with Vercel for the frontend and Supabase for the backend. Sticking with this instead of a full AWS setup because our team has zero AWS DevOps experience.", 13),
    msg("user",      "Caching strategy?", 14),
    msg("assistant", "Let's use React Query for server-state caching. Opted for a 5-minute stale time for most queries. The exception: collaborative document state must never be cached — always fresh.", 15),
    msg("user",      "Authentication: magic links or password?", 16),
    msg("assistant", "Switching to magic links as the primary auth method. Going with Supabase Auth for this. We decided against passwords for the initial launch to reduce support burden.", 17),
    msg("user",      "What about file attachments?", 18),
    msg("assistant", "Opted for Supabase Storage for file uploads. The 50MB file size limit is acceptable for notes. Instead of building our own CDN, let's use Supabase's built-in CDN.", 19),
    msg("user",      "Error monitoring?", 20),
    msg("assistant", "Going with Sentry. It integrates with Vercel natively. We decided against Datadog — it's priced for enterprises, not startups. The Sentry developer plan covers our needs.", 21),
    msg("user",      "Testing strategy?", 22),
    msg("assistant", "Opted for Vitest + Testing Library for unit and integration tests, Playwright for e2e. Switching from Jest to Vitest because of its native ESM support and faster execution.", 23),
    msg("user",      "Summarize all decisions.", 24),
    msg("assistant", "Here's our full decision log: Supabase (DB+auth+storage), Zustand (state), Supabase real-time (sync), IndexedDB+Dexie (offline), Yjs CRDTs (conflicts), Algolia (search), Vercel (deploy), React Query (cache), magic links (auth), Sentry (monitoring), Vitest+Playwright (testing). All major architecture decisions are now settled.", 25),
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// SESSION 6 — edge-empty (3 messages — verify no crashes)
// ─────────────────────────────────────────────────────────────────────────────
const session6: ContextSession = {
  id: "golden-6",
  platform: "perplexity",
  title: "edge-empty",
  createdAt: T0,
  updatedAt: T0 + 2 * 60_000,
  messages: [
    msg("user",      "What is the difference between async/await and Promises in JavaScript?", 0),
    msg("assistant", "async/await is syntactic sugar over Promises. Both are asynchronous, but async/await is more readable for sequential operations. Under the hood, an async function always returns a Promise.", 1),
    msg("user",      "Thanks, that makes sense.", 2),
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────
export const GOLDEN_SESSIONS: ContextSession[] = [
  session1,
  session2,
  session3,
  session4,
  session5,
  session6,
];
