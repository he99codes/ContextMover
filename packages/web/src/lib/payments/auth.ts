/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/lib/payments/auth.ts
// Shared Bearer-token auth helper for payment API routes.
// Resolves the authenticated Supabase user from an Authorization header.
// Returns `null` on missing / invalid token — never throws.

import { NextRequest } from "next/server";

export async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;

  const token = authHeader.replace(/^Bearer\s+/i, "");

  // Use a plain Supabase client (non-SSR, no cookies) to validate the Bearer token.
  // The cookie-based SSR client doesn't reliably handle explicit token params in API
  // routes. A fresh anon client with persistSession:false calls Supabase's /auth/v1/user
  // with the token directly.
  const { createClient: createAnonClient } = await import("@supabase/supabase-js");
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supaUrl || !supaKey) return null;

  const supabase = createAnonClient(supaUrl, supaKey, { auth: { persistSession: false } });
  const { data: { user } } = await supabase.auth.getUser(token);
  return user;
}
