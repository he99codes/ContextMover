// packages/web/src/lib/env-guard.ts
//
// [SECURITY] Runtime environment variable guard.
//
// Rules:
//   1. Any env var whose name contains SERVICE_ROLE, SECRET, or PRIVATE
//      must NEVER be prefixed NEXT_PUBLIC_ (which bakes it into the client bundle).
//   2. This module is imported in the server-side root layout so violations
//      are caught at startup rather than silently shipping a secret.
//
// Usage: import "@/lib/env-guard" at the top of server components or layout.tsx.

const FORBIDDEN_PUBLIC_PATTERNS = [
  "SERVICE_ROLE",
  "SECRET",
  "PRIVATE",
  "SERVICE_KEY",
  "ADMIN_KEY",
];

// [SECURITY] Only runs on the server (process.env is not available client-side).
// In the browser this module is a no-op.
if (typeof window === "undefined") {
  for (const [key] of Object.entries(process.env)) {
    if (!key.startsWith("NEXT_PUBLIC_")) continue;

    const upperKey = key.toUpperCase();
    for (const forbidden of FORBIDDEN_PUBLIC_PATTERNS) {
      if (upperKey.includes(forbidden)) {
        const msg =
          `[SECURITY] CRITICAL: Environment variable "${key}" contains a ` +
          `sensitive keyword ("${forbidden}") but is prefixed with NEXT_PUBLIC_. ` +
          `This will expose the secret in the client-side JavaScript bundle. ` +
          `Rename it to remove the NEXT_PUBLIC_ prefix and access it only in ` +
          `server components or /app/api/ route handlers.`;

        if (process.env.NODE_ENV === "production") {
          // Hard crash in production — never ship with a leaked secret.
          throw new Error(msg);
        } else {
          // Loud warning in development.
          console.error(msg);
        }
      }
    }
  }
}
