// packages/web/src/lib/payments/subscription.ts
// Server-side subscription + usage helpers.
// Uses the Supabase service-role client (bypasses RLS).
// NEVER import in a client component — service-role key must stay server-only.

import { createClient } from "@supabase/supabase-js";
import { type Plan, type Subscription, type UsageData } from "./types";

// Lazy service-role client — environment is validated on first call.
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "[CF:payments] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Subscription read ───────────────────────────────────────────────────────
export async function getUserSubscription(
  userId: string
): Promise<Subscription> {
  const supabase = getServiceClient();

  const { data } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) {
    return {
      plan:             "free",
      status:           "active",
      gateway:          null,
      currentPeriodEnd: null,
      cancelledAt:      null,
      trialEnd:         null,
    };
  }

  return {
    plan:             data.plan as Plan,
    status:           data.status,
    gateway:          data.gateway,
    currentPeriodEnd: data.current_period_end ? new Date(data.current_period_end) : null,
    cancelledAt:      data.cancelled_at        ? new Date(data.cancelled_at)        : null,
    trialEnd:         data.trial_end           ? new Date(data.trial_end)           : null,
  };
}

// ── Subscription upsert (webhook target) ────────────────────────────────────
export interface UpsertSubscriptionInput {
  plan:                   Plan;
  status:                 string;
  gateway:                string;
  gatewayCustomerId?:     string;
  gatewaySubscriptionId?: string;
  currency?:              string;
  amount?:                number;
  currentPeriodStart?:    Date;
  currentPeriodEnd?:      Date;
  cancelledAt?:           Date | null;
  trialEnd?:              Date | null;
}

export async function upsertSubscription(
  userId: string,
  data:   UpsertSubscriptionInput
): Promise<void> {
  const supabase = getServiceClient();

  const { error } = await supabase
    .from("subscriptions")
    .upsert(
      {
        user_id:                 userId,
        plan:                    data.plan,
        status:                  data.status,
        gateway:                 data.gateway,
        gateway_customer_id:     data.gatewayCustomerId,
        gateway_subscription_id: data.gatewaySubscriptionId,
        currency:                data.currency,
        amount:                  data.amount,
        current_period_start:    data.currentPeriodStart?.toISOString(),
        current_period_end:      data.currentPeriodEnd?.toISOString(),
        cancelled_at:            data.cancelledAt?.toISOString() ?? null,
        trial_end:               data.trialEnd?.toISOString()    ?? null,
        updated_at:              new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

  if (error) {
    console.error("[CF:payments] upsertSubscription failed:", error);
  }
}

// ── Idempotency check (webhook replay protection) ───────────────────────────
// [SECURITY] Returns true if (gateway, gatewayEventId) was already processed.
// Webhook handlers MUST call this before mutating subscription state to
// prevent replay attacks and double-billing-state on gateway retry storms.
export async function isDuplicateEvent(
  gateway:        string,
  gatewayEventId: string
): Promise<boolean> {
  if (!gatewayEventId || gatewayEventId === "razorpay-unknown") return false;
  const supabase = getServiceClient();
  const { data } = await supabase
    .from("payment_events")
    .select("id")
    .eq("gateway",          gateway)
    .eq("gateway_event_id", gatewayEventId)
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

// ── Payment events log (audit trail) ────────────────────────────────────────
export async function logPaymentEvent(
  userId:         string | null,
  gateway:        string,
  eventType:      string,
  gatewayEventId: string,
  payload:        unknown
): Promise<void> {
  const supabase = getServiceClient();

  const { error } = await supabase.from("payment_events").insert({
    user_id:          userId,
    gateway,
    event_type:       eventType,
    gateway_event_id: gatewayEventId,
    payload,
  });

  if (error) {
    console.error("[CF:payments] logPaymentEvent failed:", error);
  }
}

// ── Usage read ──────────────────────────────────────────────────────────────
export async function getUserUsage(
  userId: string,
  month:  string
): Promise<UsageData> {
  const supabase = getServiceClient();

  const { data } = await supabase
    .from("usage_tracking")
    .select("*")
    .eq("user_id", userId)
    .eq("month",   month)
    .maybeSingle();

  return {
    month,
    simpleMigrations:    data?.simple_migrations    ?? 0,
    smartMigrations:     data?.smart_migrations     ?? 0,
    attentionMigrations: data?.attention_migrations ?? 0,
    sessionsCount:       data?.sessions_count       ?? 0,
  };
}

// ── Month key helper ────────────────────────────────────────────────────────
export function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
