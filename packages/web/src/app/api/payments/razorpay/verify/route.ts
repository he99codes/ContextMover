// packages/web/src/app/api/payments/razorpay/verify/route.ts
// Called client-side after Razorpay checkout completes.
// [SECURITY] Signature is verified server-side before updating Supabase.
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

type VerifyBody = {
  razorpay_order_id:   string;
  razorpay_payment_id: string;
  razorpay_signature:  string;
  plan?:               string;
  billing?:            string;
};

export async function POST(req: NextRequest) {
  try {
    // ── Auth check ──────────────────────────────────────────────────────────
    const supabase = createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── Parse body ───────────────────────────────────────────────────────────
    const body = (await req.json()) as VerifyBody;
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      plan    = "pro",
      billing = "monthly",
    } = body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return NextResponse.json(
        { error: "Missing payment fields" },
        { status: 400 }
      );
    }

    // ── Signature verification ───────────────────────────────────────────────
    // Razorpay standard: HMAC-SHA256(order_id + "|" + payment_id, key_secret)
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return NextResponse.json(
        { error: "Payment gateway not configured" },
        { status: 503 }
      );
    }

    const generated = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (
      generated.length !== razorpay_signature.length ||
      !crypto.timingSafeEqual(
        Buffer.from(generated),
        Buffer.from(razorpay_signature)
      )
    ) {
      console.warn("[verify] Signature mismatch for payment", razorpay_payment_id);
      return NextResponse.json(
        { error: "Invalid payment signature" },
        { status: 400 }
      );
    }

    // ── Update Supabase (admin client bypasses RLS) ─────────────────────────
    const admin = createAdminClient();

    await admin.from("payments").insert({
      user_id:    user.id,
      gateway:    "razorpay",
      payment_id: razorpay_payment_id,
      order_id:   razorpay_order_id,
      plan,
      status:     "verified",
    });

    await admin.from("users").upsert(
      {
        id:         user.id,
        is_pro:     true,
        plan,
        pro_since:  new Date().toISOString(),
        gateway:    "razorpay",
        payment_id: razorpay_payment_id,
      },
      { onConflict: "id" }
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[verify]", err);
    return NextResponse.json(
      { error: "Payment verification failed" },
      { status: 500 }
    );
  }
}
