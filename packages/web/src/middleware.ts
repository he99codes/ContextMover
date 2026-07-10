/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public GET access only to scraper config endpoint
  if (pathname === '/api/scraper-admin/configs' && request.method === 'GET') {
    return NextResponse.next();
  }
  // Allow public read access to exported config JSON used by the extension
  if (pathname.startsWith('/config/') && request.method === 'GET') {
    return NextResponse.next();
  }
  // Admin API routes use Bearer token auth via requireAdmin() — skip cookie check entirely.
  // The middleware cookie-auth has no cookies from the admin frontend fetch calls,
  // so it would always see user=null and redirect/block them incorrectly.
  if (pathname.startsWith('/api/admin/') || pathname.startsWith('/api/scraper-admin/')) {
    return NextResponse.next();
  }
  // Extension-facing API routes use Bearer token auth (Authorization header),
  // not browser cookies. Middleware sees no session and would 307 → /auth,
  // which causes the fetch to follow the redirect and hit the HTML page instead
  // of the JSON API. Skip cookie-auth for all these routes entirely.
  if (
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/payments/') ||
    pathname.startsWith('/api/usage/') ||
    pathname.startsWith('/api/migrate/') ||
    pathname.startsWith('/api/summarize/') ||
    pathname.startsWith('/api/telemetry/') ||
    pathname.startsWith('/api/config/') ||
    pathname.startsWith('/api/attention/') ||
    pathname.startsWith('/api/support/') ||
    pathname.startsWith('/api/contact') ||
    pathname.startsWith('/api/feedback') ||
    pathname.startsWith('/api/health') ||
    pathname.startsWith('/api/selector-fix')
    // NOTE: /api/webhooks/ is excluded at the matcher level (see config below)
    // so the middleware never runs for it — preserving the raw request body.
  ) {
    return NextResponse.next();
  }
  // Skip auth checks if env vars aren't configured yet
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Public paths — no auth required
  const PUBLIC_PATHS = ["/", "/auth", "/pricing", "/privacy", "/docs", "/terms", "/login", "/signup", "/support", "/contact", "/feedback", "/build-with-me"];
  const isPublic =
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/")) ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico";

  // Redirect unauthenticated users to /auth (except public paths)
  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth";
    return NextResponse.redirect(url);
  }

  // Redirect authenticated users away from /auth
  if (user && pathname === "/auth") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - any other static assets (e.g., svg, png, jpg, etc.)
     */
    // [CM-RZP-FIX] Exclude /api/webhooks/ from middleware entirely — Edge
    // Runtime can buffer/reconstruct the request body, corrupting the raw
    // bytes that HMAC-SHA256 signature verification depends on.
    '/((?!_next/static|_next/image|favicon.ico|api/webhooks|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
