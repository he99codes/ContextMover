import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limiter";
import { sendEmail, SENDERS } from "@/lib/mailer";
import { welcomeEmail } from "@/lib/emails/templates";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export const runtime = "nodejs";

const EXPECTED_CLIENT_ID = "537316078537-hcpqdq1jsh3eh748071u0q4id7j1iivd.apps.googleusercontent.com";

export async function POST(req: NextRequest) {
  // [SECURITY] Rate limit: 10/min per IP — public endpoint, prevents token spray + email enumeration.
  const rl = await checkRateLimit(req, undefined, 10);
  if (!rl.ok) return rl.response;

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supaAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supaServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  try {
    const { idToken } = (await req.json()) as { idToken?: string; nonce?: string };
    if (!idToken) return NextResponse.json({ error: "Missing id_token" }, { status: 400, headers: CORS });

    // Step 1: Verify the id_token with Google's tokeninfo endpoint.
    // This bypasses Supabase signInWithIdToken which rejects tokens whose aud
    // doesn't match the client_id registered in Supabase's Google provider settings.
    const tokenInfoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!tokenInfoRes.ok) {
      console.error("[extension-google-signin] Google tokeninfo rejected:", tokenInfoRes.status);
      return NextResponse.json({ error: "Invalid Google token" }, { status: 401, headers: CORS });
    }
    const tokenInfo = (await tokenInfoRes.json()) as {
      sub?: string;
      email?: string;
      email_verified?: string;
      aud?: string;
      error_description?: string;
    };

    if (tokenInfo.error_description) {
      console.error("[extension-google-signin] tokeninfo error:", tokenInfo.error_description);
      return NextResponse.json({ error: "Invalid Google token" }, { status: 401, headers: CORS });
    }

    // Step 2: Validate audience matches our Web OAuth client ID.
    if (tokenInfo.aud !== EXPECTED_CLIENT_ID) {
      console.error("[extension-google-signin] aud mismatch:", tokenInfo.aud);
      return NextResponse.json({ error: "Token audience mismatch" }, { status: 401, headers: CORS });
    }
    if (!tokenInfo.email || tokenInfo.email_verified !== "true") {
      return NextResponse.json({ error: "Email not verified" }, { status: 401, headers: CORS });
    }

    // Step 3: Find or create the user via Supabase admin REST API.
    const admin = createAdminClient();
    let userId: string;

    const searchRes = await fetch(
      `${supaUrl}/auth/v1/admin/users?email=${encodeURIComponent(tokenInfo.email)}`,
      {
        headers: {
          Authorization: `Bearer ${supaServiceKey}`,
          apikey: supaServiceKey,
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    const searchJson = searchRes.ok
      ? (await searchRes.json() as { users?: { id: string }[] })
      : null;
    const foundUser = searchJson?.users?.[0];

    if (foundUser?.id) {
      userId = foundUser.id;
    } else {
      const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
        email: tokenInfo.email,
        email_confirm: true,
        user_metadata: { provider: "google", sub: tokenInfo.sub, email: tokenInfo.email },
      });
      if (createErr || !newUser?.user) {
        console.error("[extension-google-signin] createUser failed:", createErr?.message);
        return NextResponse.json({ error: "Failed to create user account" }, { status: 500, headers: CORS });
      }
      userId = newUser.user.id;
      // Send welcome email (best-effort, never blocks signup)
      try {
        const tpl = welcomeEmail(tokenInfo.email);
        void sendEmail({ ...tpl, to: tokenInfo.email, from: SENDERS.noreply });
      } catch (e) {
        console.warn("[extension-google-signin] welcome email failed:", e);
      }
    }

    // Step 4: Generate a magic-link token and immediately exchange it for a session.
    // This gives us a real access_token + refresh_token without sending any email.
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: tokenInfo.email,
    });
    if (linkErr || !linkData?.properties) {
      console.error("[extension-google-signin] generateLink failed:", linkErr?.message);
      return NextResponse.json({ error: "Failed to create session" }, { status: 500, headers: CORS });
    }

    // Supabase exposes hashed_token directly on properties.
    // The action_link URL puts token_hash in the hash fragment (#), not query params.
    const token_hash = (linkData.properties as Record<string, unknown>).hashed_token as string | undefined
      ?? (linkData.properties as Record<string, unknown>).token_hash as string | undefined;

    if (!token_hash) {
      console.error("[extension-google-signin] generateLink properties:", JSON.stringify(linkData.properties));
      return NextResponse.json({ error: "Failed to create session" }, { status: 500, headers: CORS });
    }

    const anon = createClient(supaUrl, supaAnon, { auth: { persistSession: false } });
    const { data: sd, error: verifyErr } = await anon.auth.verifyOtp({
      token_hash,
      type: "magiclink",
    });
    if (verifyErr || !sd?.session) {
      console.error("[extension-google-signin] verifyOtp failed:", verifyErr?.message);
      return NextResponse.json({ error: "Failed to create session" }, { status: 500, headers: CORS });
    }

    console.log("[extension-google-signin] success for userId:", userId);
    return NextResponse.json({
      access_token: sd.session.access_token,
      refresh_token: sd.session.refresh_token,
      user: { id: sd.user?.id ?? userId, email: sd.user?.email ?? tokenInfo.email },
    }, { headers: CORS });
  } catch (e) {
    console.error("[extension-google-signin] unexpected error:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500, headers: CORS });
  }
}
