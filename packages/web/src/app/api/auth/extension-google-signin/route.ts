import { NextRequest, NextResponse } from "next/server";
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
    const { data: users } = await admin.auth.admin.listUsers();
    const match = users?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!match) {
      return NextResponse.json({
        error: "no_account",
        message: "No account found. Sign up on the web first.",
        signupUrl: "https://contextmover.com/auth?mode=signup",
      }, { status: 404 });
    }

    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink", email: match.email!,
    });
    const props = link?.properties as unknown as { access_token?: string; refresh_token?: string };
    if (linkErr || !props?.access_token) {
      return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
    }

    return NextResponse.json({
      access_token: props.access_token,
      refresh_token: props.refresh_token,
      user: { id: match.id, email: match.email },
    });
  } catch (e) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
