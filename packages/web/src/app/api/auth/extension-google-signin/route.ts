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
    let isNewUser = false;

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
      isNewUser = true;
      // Send welcome email (best-effort, never blocks signup)
      try {
        const tpl = welcomeEmail(tokenInfo.email);
        void sendEmail({ ...tpl, to: tokenInfo.email, from: SENDERS.noreply });
      } catch (e) {
        console.warn("[extension-google-signin] welcome email failed:", e);
      }
    }

    // Step 4: Create a session for the user.
    // Strategy A: Use generateLink to get an action_link, then fetch it server-side
    // to complete the verification and extract session tokens from the redirect.
    // This avoids the broken verifyOtp which fails with "Email link is invalid or
    // has expired" for newly created users.
    const MAX_ATTEMPTS = 3;
    let session: { access_token: string; refresh_token: string } | null = null;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // For new users, give Supabase time to propagate the user record
      if (isNewUser && attempt === 1) {
        await new Promise((r) => setTimeout(r, 600));
      }

      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type: "magiclink",
        email: tokenInfo.email,
      });

      if (linkErr || !linkData) {
        lastError = linkErr?.message ?? "generateLink returned no data";
        console.warn(`[extension-google-signin] generateLink failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, lastError);
        if (attempt < MAX_ATTEMPTS) { await new Promise((r) => setTimeout(r, 800)); continue; }
        break;
      }

      // --- Strategy A: Follow the action_link server-side ---
      // generateLink returns linkData.properties.action_link which is a full URL like:
      // https://project.supabase.co/auth/v1/verify?token=...&type=magiclink&redirect_to=...
      // Following it server-side with redirect:'manual' gives us a 303 redirect whose
      // Location header contains the session tokens in the URL hash/query.
      const actionLink = (linkData as any).properties?.action_link as string | undefined;
      if (actionLink) {
        try {
          const verifyRes = await fetch(actionLink, {
            redirect: "manual",
            signal: AbortSignal.timeout(8000),
          });
          const location = verifyRes.headers.get("location");
          if (location) {
            // Location can contain tokens in hash (#access_token=...) or query (?code=...)
            const url = new URL(location);
            // Check hash fragment
            const hashParams = new URLSearchParams(url.hash.slice(1));
            const accessToken = hashParams.get("access_token");
            const refreshToken = hashParams.get("refresh_token");
            if (accessToken && refreshToken) {
              session = { access_token: accessToken, refresh_token: refreshToken };
              console.log(`[extension-google-signin] action_link strategy succeeded (attempt ${attempt})`);
              break;
            }
            // Check for PKCE code in query
            const code = url.searchParams.get("code");
            if (code) {
              const anon = createClient(supaUrl, supaAnon, { auth: { persistSession: false } });
              const { data: codeData, error: codeErr } = await anon.auth.exchangeCodeForSession(code);
              if (codeData?.session) {
                session = { access_token: codeData.session.access_token, refresh_token: codeData.session.refresh_token };
                console.log(`[extension-google-signin] PKCE code exchange succeeded (attempt ${attempt})`);
                break;
              }
              lastError = codeErr?.message ?? "code exchange failed";
              console.warn(`[extension-google-signin] PKCE code exchange failed (attempt ${attempt}):`, lastError);
            }
            // Check for error in redirect
            const errorDesc = hashParams.get("error_description") || url.searchParams.get("error_description");
            if (errorDesc) {
              lastError = errorDesc;
              console.warn(`[extension-google-signin] action_link redirect error (attempt ${attempt}):`, errorDesc);
            }
          } else {
            lastError = `action_link returned status ${verifyRes.status} with no Location header`;
            console.warn(`[extension-google-signin] action_link no redirect (attempt ${attempt}): status=${verifyRes.status}`);
          }
        } catch (fetchErr) {
          lastError = fetchErr instanceof Error ? fetchErr.message : "action_link fetch failed";
          console.warn(`[extension-google-signin] action_link fetch error (attempt ${attempt}):`, lastError);
        }
      }

      // --- Strategy B (fallback): Try verifyOtp with token_hash / email_otp ---
      if (!session) {
        const props = (linkData as any).properties as Record<string, unknown> | undefined;
        const token_hash = (props?.hashed_token as string | undefined) ?? (props?.token_hash as string | undefined);
        const verificationType = (props?.verification_type as any) ?? "magiclink";

        const anon = createClient(supaUrl, supaAnon, { auth: { persistSession: false } });

        if (token_hash) {
          const res = await anon.auth.verifyOtp({ token_hash, type: verificationType });
          if (res.data?.session) {
            session = { access_token: res.data.session.access_token, refresh_token: res.data.session.refresh_token };
            console.log(`[extension-google-signin] verifyOtp(token_hash) succeeded (attempt ${attempt})`);
            break;
          }
          lastError = res.error?.message ?? "verifyOtp failed";
        }

        // email_otp fallback
        if (!session && props?.email_otp) {
          const fallbackRes = await anon.auth.verifyOtp({
            email: tokenInfo.email,
            token: props.email_otp as string,
            type: verificationType === "signup" ? "signup" : "email",
          });
          if (fallbackRes.data?.session) {
            session = { access_token: fallbackRes.data.session.access_token, refresh_token: fallbackRes.data.session.refresh_token };
            console.log(`[extension-google-signin] verifyOtp(email_otp) succeeded (attempt ${attempt})`);
            break;
          }
          lastError = fallbackRes.error?.message ?? "email_otp verify failed";
        }
      }

      console.warn(`[extension-google-signin] all strategies failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, lastError);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    if (!session) {
      console.error("[extension-google-signin] all attempts exhausted:", lastError);
      return NextResponse.json({ error: "Failed to create session", message: lastError }, { status: 500, headers: CORS });
    }

    // Verify the session is valid by getting the user
    const anon = createClient(supaUrl, supaAnon, { auth: { persistSession: false } });
    await anon.auth.setSession(session);
    const { data: { user: sessionUser } } = await anon.auth.getUser(session.access_token);

    console.log("[extension-google-signin] success for userId:", userId);
    return NextResponse.json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      user: { id: sessionUser?.id ?? userId, email: sessionUser?.email ?? tokenInfo.email },
    }, { headers: CORS });
  } catch (e) {
    console.error("[extension-google-signin] unexpected error:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500, headers: CORS });
  }
}
