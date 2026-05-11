import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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
  const next = safeRedirectPath(requestUrl.searchParams.get("next"));
  const origin = requestUrl.origin;

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(`${origin}/auth?error=callback_failed`);
    }
  } else {
    return NextResponse.redirect(`${origin}/auth?error=no_code`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
