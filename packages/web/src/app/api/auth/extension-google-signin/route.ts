import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { idToken } = (await req.json()) as { idToken?: string };
    if (!idToken) return NextResponse.json({ error: "Missing id_token" }, { status: 400 });

    const ti = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!ti.ok) return NextResponse.json({ error: "Invalid Google token" }, { status: 401 });
    const { email, error: tiErr } = (await ti.json()) as { email?: string; error?: string };
    if (tiErr || !email) return NextResponse.json({ error: "Invalid token" }, { status: 401 });

    const admin = createAdminClient();

    // Paginate listUsers to find existing user by email.
    const target = email.toLowerCase();
    let match: { id: string; email: string | undefined } | undefined;
    {
      let page = 1;
      const perPage = 1000;
      for (;;) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
        if (error || !data?.users) break;
        const hit = data.users.find((u) => u.email?.toLowerCase() === target);
        if (hit) { match = { id: hit.id, email: hit.email ?? undefined }; break; }
        if (data.users.length < perPage) break;
        page++;
        if (page > 100) break;
      }
    }
    if (!match) {
      return NextResponse.json({
        error: "no_account",
        message: "No account found. Sign up on the web first.",
        signupUrl: "https://contextmover.com/auth?mode=signup",
      }, { status: 404 });
    }

    // signInWithIdToken exchanges the verified Google ID token for a real
    // Supabase session (access_token + refresh_token).
    // generateLink({type:"magiclink"}) in v2 returns only action_link/hashed_token,
    // not the JWT tokens — hence the original 500.
    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supaAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const anon = createClient(supaUrl, supaAnon, { auth: { persistSession: false } });
    const { data: sd, error: serr } = await anon.auth.signInWithIdToken({
      provider: "google",
      token: idToken,
    });

    if (serr || !sd?.session) {
      console.error("[extension-google-signin] signInWithIdToken failed:", serr);
      return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
    }

    return NextResponse.json({
      access_token: sd.session.access_token,
      refresh_token: sd.session.refresh_token,
      user: { id: sd.user?.id ?? match.id, email: sd.user?.email ?? match.email },
    });
  } catch (e) {
    console.error("[extension-google-signin] unexpected error:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
