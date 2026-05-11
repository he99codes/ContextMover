// packages/web/src/lib/payments/auth.ts
// Shared Bearer-token auth helper for payment API routes.
// Resolves the authenticated Supabase user from an Authorization header.
// Returns `null` on missing / invalid token — never throws.

import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";

export async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const token = authHeader.replace("Bearer ", "");
  const { data: { user } } = await supabase.auth.getUser(token);
  return user;
}
