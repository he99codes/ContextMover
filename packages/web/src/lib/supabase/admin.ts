// packages/web/src/lib/supabase/admin.ts
// [SECURITY] Service-role client — server-only. Never import in client components.
// Uses the raw supabase-js createClient (not the SSR wrapper) with the service-role
// key so it bypasses Row Level Security for webhook / server utility operations.
// The Database generic is intentionally omitted here because the raw createClient
// resolves table types differently than @supabase/ssr's typed wrappers; callers
// use explicit `as` casts for type safety instead.
import { createClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdminClient = ReturnType<typeof createClient<any>>;

export function createAdminClient(): AdminClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "[Supabase admin] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
