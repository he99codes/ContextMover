/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/web/src/app/api/payments/redeem/route.ts
// Redeems a promo code and grants the authenticated user a 2-month Pro subscription.
// Codes can be configured via the PROMO_CODES env var (comma-separated list).
// Falls back to a hardcoded default list when the env var is absent (local dev).
// Each code grants a 60-day Pro subscription with gateway="promo".

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser }         from "@/lib/payments/auth";
import { getUserSubscription, upsertSubscription } from "@/lib/payments/subscription";
import { checkRateLimit }      from "@/lib/rate-limiter";

// ── Valid promo codes ────────────────────────────────────────────────────────
// Configure via PROMO_CODES="CODE1,CODE2" in .env.local for production.
// Codes are compared case-insensitively and trimmed.
function getValidCodes(): Set<string> {
  const raw = process.env.PROMO_CODES ?? "FREE2MONTHS,CONTEXTMOVER2026,EARLYBIRD60";
  return new Set(
    raw.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean)
  );
}

const PROMO_DURATION_DAYS = 60; // 2 months

export async function POST(req: NextRequest) {
  // Auth
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit: max 15 redemption attempts per user per window
  const rl = await checkRateLimit(req, user.id, 15);
  if (!rl.ok) return rl.response;

  // Parse body
  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const submittedCode = (body.code ?? "").trim().toUpperCase();
  if (!submittedCode) {
    return NextResponse.json({ error: "No promo code provided" }, { status: 400 });
  }

  // Validate code
  const validCodes = getValidCodes();
  if (!validCodes.has(submittedCode)) {
    return NextResponse.json({ error: "Invalid or expired promo code" }, { status: 400 });
  }

  // Check if user already has an active paid subscription
  const existing = await getUserSubscription(user.id);
  if (existing.plan === "pro" && existing.status === "active") {
    // Allow if they are already on promo (re-apply extends it), block if paid gateway
    if (existing.gateway && existing.gateway !== "promo" && existing.gateway !== "mock") {
      return NextResponse.json(
        { error: "You already have an active Pro subscription" },
        { status: 409 }
      );
    }
  }

  // Apply 60-day Pro subscription
  const now      = new Date();
  const periodEnd = new Date(now.getTime() + PROMO_DURATION_DAYS * 24 * 60 * 60 * 1000);

  try {
    await upsertSubscription(user.id, {
      plan:                    "pro",
      status:                  "active",
      gateway:                 "promo",
      gatewaySubscriptionId:   `promo_${submittedCode}_${Date.now()}`,
      currency:                "usd",
      amount:                  0,
      currentPeriodStart:      now,
      currentPeriodEnd:        periodEnd,
    });

    console.log(
      `[CM:payments] Promo code "${submittedCode}" redeemed by ${user.id} — Pro until ${periodEnd.toISOString()}`
    );

    return NextResponse.json({
      success:    true,
      plan:       "pro",
      expiresAt:  periodEnd.toISOString(),
      durationDays: PROMO_DURATION_DAYS,
      message:    `🎉 Pro activated for ${PROMO_DURATION_DAYS} days!`,
    });
  } catch (err) {
    console.error("[CM:api:redeem] error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
