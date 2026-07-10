import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/payments/auth";
import { checkRateLimit } from "@/lib/rate-limiter";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export const dynamic = "force-dynamic";

const MAX_SEATS = 9;

function normalizeEmail(raw: string): string | null {
  const email = raw.toLowerCase().trim();
  if (!email.includes("@") || email.length > 254) return null;
  return email;
}

// ── GET: list owner's seats, master drive, violations ───────────────────────
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
  }

  const rl = await checkRateLimit(req, user.id);
  if (!rl.ok) return rl.response;

  try {
    const admin = createAdminClient();

    const { data: seats } = await admin
      .from("pro_seats")
      .select("seat_email, created_at")
      .eq("owner_user_id", user.id)
      .order("created_at", { ascending: true });

    const { data: sub } = await admin
      .from("subscriptions")
      .select("master_drive_email, plan, status")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: violations } = await admin
      .from("pro_violations")
      .select("offending_email, attempted_drive_email, master_drive_email, created_at")
      .eq("owner_user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20);

    return NextResponse.json({
      seats: seats ?? [],
      seatCount: seats?.length ?? 0,
      maxSeats: MAX_SEATS,
      masterDriveEmail: sub?.master_drive_email ?? null,
      violations: violations ?? [],
    }, { headers: CORS });
  } catch (err) {
    console.error("[CM:api:pro-seats:GET] error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500, headers: CORS });
  }
}

// ── POST: add a seat email ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
  }

  const rl = await checkRateLimit(req, user.id, 20, 60);
  if (!rl.ok) return rl.response;

  const body = await req.json().catch(() => ({}));
  const rawEmail = body?.email as string | undefined;
  const email = normalizeEmail(rawEmail ?? "");
  if (!email) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400, headers: CORS });
  }

  try {
    const admin = createAdminClient();

    // Check seat count
    const { count } = await admin
      .from("pro_seats")
      .select("*", { count: "exact", head: true })
      .eq("owner_user_id", user.id);

    if ((count ?? 0) >= MAX_SEATS) {
      return NextResponse.json(
        { error: `Seat limit reached (${MAX_SEATS}). Remove an email to add another.` },
        { status: 409, headers: CORS }
      );
    }

    // Don't allow adding own login email (owner is auto-included)
    const { data: ownerUser } = await admin.auth.admin.getUserById(user.id);
    const ownerEmail = ownerUser?.user?.email?.toLowerCase().trim();
    if (ownerEmail && email === ownerEmail) {
      return NextResponse.json(
        { error: "Your own account is already included as a seat." },
        { status: 409, headers: CORS }
      );
    }

    // unique(seat_email) prevents an email from being on multiple subscriptions
    const { error } = await admin
      .from("pro_seats")
      .insert({ owner_user_id: user.id, seat_email: email });

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "This email is already authorized on a subscription." },
          { status: 409, headers: CORS }
        );
      }
      console.error("[CM:api:pro-seats:POST] insert error:", error);
      return NextResponse.json({ error: "Failed to add seat" }, { status: 500, headers: CORS });
    }

    console.log("[CM:api:pro-seats] added seat:", email, "for owner:", user.id);
    return NextResponse.json({ ok: true, email }, { headers: CORS });
  } catch (err) {
    console.error("[CM:api:pro-seats:POST] exception:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500, headers: CORS });
  }
}

// ── DELETE: remove a seat email ─────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
  }

  const rl = await checkRateLimit(req, user.id, 20, 60);
  if (!rl.ok) return rl.response;

  const body = await req.json().catch(() => ({}));
  const rawEmail = body?.email as string | undefined;
  const email = normalizeEmail(rawEmail ?? "");
  if (!email) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400, headers: CORS });
  }

  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("pro_seats")
      .delete()
      .eq("owner_user_id", user.id)
      .eq("seat_email", email);

    if (error) {
      console.error("[CM:api:pro-seats:DELETE] error:", error);
      return NextResponse.json({ error: "Failed to remove seat" }, { status: 500, headers: CORS });
    }

    console.log("[CM:api:pro-seats] removed seat:", email, "for owner:", user.id);
    return NextResponse.json({ ok: true }, { headers: CORS });
  } catch (err) {
    console.error("[CM:api:pro-seats:DELETE] exception:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500, headers: CORS });
  }
}
