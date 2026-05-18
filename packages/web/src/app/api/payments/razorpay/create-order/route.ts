/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/payments/razorpay/create-order/route.ts
// [SECURITY] Server-only. RAZORPAY_KEY_SECRET is never sent to the client.
import { NextRequest, NextResponse } from "next/server";
import Razorpay from "razorpay";
import { createClient } from "@/lib/supabase/server";

// Amount in paise (1 INR = 100 paise).
const AMOUNTS: Record<string, Record<string, number>> = {
  pro:  { monthly: 19900,  annual: 189900 },
  team: { monthly: 99900,  annual: 999000 },
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

    // ── Parse + validate body ────────────────────────────────────────────────
    const body = (await req.json()) as {
      plan?:    string;
      billing?: string;
    };
    const { plan, billing } = body;

    if (!plan || !billing || !AMOUNTS[plan]?.[billing]) {
      return NextResponse.json(
        { error: "Invalid plan or billing period" },
        { status: 400 }
      );
    }

    // ── Razorpay SDK ─────────────────────────────────────────────────────────
    const keyId     = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      console.error("[create-order] Razorpay env vars not configured");
      return NextResponse.json(
        { error: "Payment gateway not configured" },
        { status: 503 }
      );
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

    const order = await razorpay.orders.create({
      amount:   AMOUNTS[plan][billing],
      currency: "INR",
      receipt:  `cf_${plan}_${billing}_${Date.now()}`,
      notes:    { userId: user.id, plan, billing },
    });

    // [SECURITY] Return NEXT_PUBLIC_RAZORPAY_KEY_ID (key_id only), never key_secret.
    return NextResponse.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      keyId:    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("[create-order]", err);
    return NextResponse.json(
      { error: "Failed to create Razorpay order" },
      { status: 500 }
    );
  }
}
