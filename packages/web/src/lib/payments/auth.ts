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

import { createClient } from "@/lib/supabase/server";
import { NextRequest } from "next/server";

export async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;

  const supabase = createClient();
  const token = authHeader.replace("Bearer ", "");
  const { data: { user } } = await supabase.auth.getUser(token);
  return user;
}
