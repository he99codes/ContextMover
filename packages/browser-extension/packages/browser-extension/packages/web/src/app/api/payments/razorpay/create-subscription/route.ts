/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/payments/razorpay/create-subscription/route.ts
// Creates a Razorpay subscription (autopay) for the authenticated user.
// [SECURITY] Server-only. RAZORPAY_KEY_SECRET is never sent to the client.

import { NextRequest, NextResponse } from "next/server";
import Razorpay from "razorpay";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const PLAN_ID_MAP: Record<string, string | undefined> = {
  pro_monthly: process.env.RAZORPAY_PRO_MONTHLY_PLAN_ID,
  pro_annual:  process.env.RAZORPAY_PRO_ANNUAL_PLAN_ID,
};

export async function POST(req: NextRequest) {
  try {
    // ── Auth via Bearer token ───────────────────────────────────────────────
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── Parse + validate body ────────────────────────────────────────────────
    const body = (await req.json()) as {
      plan?:    string;
      billing?: string;
    };
    const { plan, billing } = body;

    if (
      !plan ||
      !billing ||
      !["pro"].includes(plan) ||
      !["monthly", "annual"].includes(billing)
    ) {
      return NextResponse.json(
        { error: "Invalid plan or billing period" },
        { status: 400 }
      );
    }

    // ── Look up Razorpay plan ID ─────────────────────────────────────────────
    const planKey = `${plan}_${billing}`;
    const planId  = PLAN_ID_MAP[planKey];
    if (!planId) {
      return NextResponse.json(
        { error: "Create plans in Razorpay Dashboard first and add plan IDs to env" },
        { status: 400 }
      );
    }

    // ── Razorpay SDK ─────────────────────────────────────────────────────────
    const keyId     = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      console.error("[create-subscription] Razorpay env vars not configured");
      return NextResponse.json(
        { error: "Payment gateway not configured" },
        { status: 503 }
      );
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

    const subscription = await razorpay.subscriptions.create({
      plan_id:         planId,
      customer_notify: 1,
      total_count:     0,
      quantity:        1,
      notes: {
        userId:    user.id,
        userEmail: user.email ?? "",
        plan,
        billing,
      },
    });

    return NextResponse.json({
      subscriptionId: subscription.id,
      planId,
      status:         subscription.status,
      keyId:          process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("[create-subscription]", err);
    const message = err instanceof Error ? err.message : "Failed to create subscription";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
