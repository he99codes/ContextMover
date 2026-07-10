// packages/web/src/app/api/payments/refund-request/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthUserFromRequest } from "@/lib/usage/helpers";
import { sendEmail, SENDERS, NOTIFY_EMAIL, escapeHtml } from "@/lib/mailer";
import { checkRateLimit } from "@/lib/rate-limiter";
import { refundRequestReceivedEmail } from "@/lib/emails/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUserFromRequest(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // II/UU: 3 requests per hour — allows retries without blocking legitimate use
    const rl = await checkRateLimit(req, user.id, 3, 3600);
    if (!rl.ok) return rl.response;

    const body = (await req.json()) as { payment_id?: string; reason?: string };
    if (!body.reason || body.reason.trim().length < 5)
      return NextResponse.json({ error: "Reason required" }, { status: 400 });

    const admin = createAdminClient();

    // ── Fetch user data ──────────────────────────────────────────────────
    const { data: userRow } = await admin
      .from("users")
      .select("pro_since, is_pro, plan, created_at")
      .eq("id", user.id)
      .maybeSingle();

    // ── Fetch subscription with full transaction details (RR) ────────────
    const { data: subRow } = await admin
      .from("subscriptions")
      .select(`
        current_start, current_period_start, current_period_end, current_end,
        plan, status, interval, amount, currency, gateway,
        razorpay_subscription_id, razorpay_plan_id, gateway_subscription_id,
        cancelled_at
      `)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Fix 9: If no subscription row exists, there's no payment to refund
    if (!subRow) {
      return NextResponse.json({ error: "No active subscription found for refund." }, { status: 400 });
    }

    const proSince = userRow?.pro_since ?? subRow?.current_start ?? subRow?.current_period_start;
    // Fix 11: If proSince is null, fall back to subscription created_at or
    // user created_at. If no date can be determined, reject (can't verify eligibility).
    const refundEligibilityDate = proSince ?? subRow?.current_period_start ?? userRow?.created_at;
    if (refundEligibilityDate) {
      const daysSince = (Date.now() - new Date(refundEligibilityDate).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 7) {
        return NextResponse.json({ error: "The 7-day refund window has expired." }, { status: 400 });
      }
    } else {
      return NextResponse.json({ error: "Unable to verify refund eligibility. Please contact support." }, { status: 400 });
    }

    // ── JJ: First-time users only — check previous approved refunds ──────
    const { count: approvedRefundCount } = await admin
      .from("refund_requests")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "approved");

    if ((approvedRefundCount ?? 0) > 0) {
      return NextResponse.json({ error: "Refunds are only available for first-time Pro subscribers. A refund has already been processed for your account." }, { status: 400 });
    }

    // ── JJ: Check this is the user's first subscription ─────────────────
    const { count: subCount } = await admin
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    if ((subCount ?? 0) > 1) {
      return NextResponse.json({ error: "Refunds are only available for first-time Pro subscribers." }, { status: 400 });
    }

    // ── Idempotency: one pending request per user ───────────────────────
    const { data: existing } = await admin
      .from("refund_requests")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .maybeSingle();
    if (existing)
      return NextResponse.json({ error: "A refund request is already pending for this account." }, { status: 409 });

    // ── Insert refund request ───────────────────────────────────────────
    await admin.from("refund_requests").insert({
      user_id:    user.id,
      payment_id: body.payment_id ?? null,
      reason:     body.reason.trim(),
      status:     "pending",
    });

    // ── Fetch user email ────────────────────────────────────────────────
    const { data: userData } = await admin.auth.admin.getUserById(user.id);
    const email = userData?.user?.email ?? user.id;

    // ── Fetch usage data ────────────────────────────────────────────────
    const currentMonth = new Date().toISOString().slice(0, 7);
    const { data: usageRow } = await admin
      .from("usage_counters")
      .select("tier1_count, tier2_count, tier3_count")
      .eq("user_id", user.id)
      .eq("month", currentMonth)
      .maybeSingle();

    const { count: totalMigrations } = await admin
      .from("migrations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    // ── Fetch razorpay_payment_id from payment_events (RR) ──────────────
    const razorpaySubId = subRow?.razorpay_subscription_id ?? subRow?.gateway_subscription_id;
    let razorpayPaymentId = body.payment_id ?? null;
    if (!razorpayPaymentId && razorpaySubId) {
      const { data: peRow } = await admin
        .from("payment_events")
        .select("razorpay_payment_id")
        .eq("razorpay_subscription_id", razorpaySubId)
        .not("razorpay_payment_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      razorpayPaymentId = peRow?.razorpay_payment_id ?? null;
    }

    // ── TT: Return success immediately after DB insert, then send emails ─
    // We return the response first, then await emails. On Vercel serverless,
    // the function stays alive until all awaited promises settle. Using
    // allSettled ensures one email failure doesn't block the other.
    const response = NextResponse.json({ ok: true });

    // User confirmation email (SS) + admin notification (RR/ZZ)
    if (process.env.ZEPTO_SMTP_PASSWORD) {
      const subInfo = subRow
        ? `<br><br><strong>Subscription Details:</strong><br>Razorpay Subscription ID: ${escapeHtml(subRow.razorpay_subscription_id ?? "—")}<br>Razorpay Payment ID: ${escapeHtml(razorpayPaymentId ?? "—")}<br>Razorpay Plan ID: ${escapeHtml(subRow.razorpay_plan_id ?? "—")}<br>Plan: ${escapeHtml(subRow.plan ?? "—")}<br>Interval: ${escapeHtml(subRow.interval ?? "—")}<br>Amount: ${subRow.amount ?? "—"} ${escapeHtml(subRow.currency ?? "")}<br>Gateway: ${escapeHtml(subRow.gateway ?? "—")}<br>Status: ${escapeHtml(subRow.status ?? "—")}<br>Current Period Start: ${escapeHtml(subRow.current_period_start ?? subRow.current_start ?? "—")}<br>Current Period End: ${escapeHtml(subRow.current_period_end ?? subRow.current_end ?? "—")}<br>Cancelled At: ${escapeHtml(subRow.cancelled_at ?? "—")}`
        : "";
      const userInfo = `<br><br><strong>User Details:</strong><br>Email: ${escapeHtml(email)}<br>User ID: ${escapeHtml(user.id)}<br>Pro Since: ${escapeHtml(userRow?.pro_since ?? "—")}<br>Account Created: ${escapeHtml(userRow?.created_at ?? "—")}<br>Is Pro: ${userRow?.is_pro ? "Yes" : "No"}`;
      const usageInfo = `<br><br><strong>Usage (this month):</strong><br>Tier 1 (Full Context): ${usageRow?.tier1_count ?? 0}<br>Tier 2 (Smart Summary): ${usageRow?.tier2_count ?? 0}<br>Tier 3 (Attention): ${usageRow?.tier3_count ?? 0}<br>Total Migrations (all time): ${totalMigrations ?? 0}`;
      const refundInfo = `<br><br><strong>Previous Refunds:</strong> ${approvedRefundCount ?? 0}<br><strong>Subscriptions Count:</strong> ${subCount ?? 0}`;
      const reasonInfo = `<br><br><strong>Reason:</strong> ${escapeHtml(body.reason)}`;

      // Await allSettled so the serverless function stays alive until emails
      // are sent. Response is already constructed — this just adds ~1-2s.
      await Promise.allSettled([
        sendEmail({
          from:    SENDERS.support,
          to:      NOTIFY_EMAIL,
          subject: `[REFUND REQUEST] ${email}`,
          html:    `<p><strong>User:</strong> ${escapeHtml(email)}<br><strong>User ID:</strong> ${escapeHtml(user.id)}<br><strong>Payment ID:</strong> ${escapeHtml(razorpayPaymentId ?? "—")}${subInfo}${userInfo}${usageInfo}${refundInfo}${reasonInfo}</p>`,
        }),
        sendEmail({
          from:    SENDERS.support,
          to:      email,
          ...refundRequestReceivedEmail(email),
        }),
      ]).then((results) => {
        for (const r of results) {
          if (r.status === 'rejected') console.warn("[refund-request] email failed:", r.reason);
        }
      });
    }

    return response;
  } catch (err) {
    console.error("[refund-request] error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
