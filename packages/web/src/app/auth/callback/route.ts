/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { Database } from "@/types/database";

// [SECURITY] Only allow relative paths as redirect targets.
// Prevents open-redirect attacks via a malicious ?next= parameter.
function safeRedirectPath(next: string | null): string {
  if (!next) return "/dashboard";
  // Must start with / and must NOT start with // (protocol-relative URL)
  if (next.startsWith("/") && !next.startsWith("//")) return next;
  return "/dashboard";
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const errorParam = requestUrl.searchParams.get("error");
  const errorDesc = requestUrl.searchParams.get("error_description");
  const next = safeRedirectPath(requestUrl.searchParams.get("next"));
  const origin = requestUrl.origin;

  // Surface explicit OAuth provider errors (e.g. user denied consent).
  if (errorParam) {
    const msg = errorDesc ?? errorParam;
    return NextResponse.redirect(
      `${origin}/auth?error=${encodeURIComponent(msg)}`
    );
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/auth?error=no_code`);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return NextResponse.redirect(`${origin}/auth?error=callback_failed`);
  }

  // Build the redirect response up-front and let supabase write session
  // cookies onto IT directly. Using `cookies()` from `next/headers` here
  // would write to the implicit response; those cookies do NOT reliably
  // propagate to a custom NextResponse.redirect() — that was the cause of
  // the post-Google sign-in redirect loop (session never lands in the
  // browser, middleware bounces /dashboard → /auth indefinitely).
  const response = NextResponse.redirect(`${origin}${next}`);

  const supabase = createServerClient<Database>(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      `${origin}/auth?error=${encodeURIComponent(error.message)}`
    );
  }

  return response;
}
