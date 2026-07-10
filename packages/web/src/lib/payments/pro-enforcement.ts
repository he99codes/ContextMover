import type { AdminClient } from "@/lib/supabase/admin";

// packages/web/src/lib/payments/pro-enforcement.ts
// Core enforcement for the "One Master Drive, 10 Seats" licensing model.
// All seats must connect the SAME master Drive account. Mismatch = revoke + flag.

export interface ProCheckResult {
  isPro: boolean;
  plan: "free" | "pro";
  reason?: "drive_mismatch" | "no_subscription" | "master_locked" | "ok";
  masterDriveEmail?: string | null;
}

interface SubscriptionRow {
  user_id: string;
  master_drive_email: string | null;
  plan: string;
  status: string;
  current_period_end: string | null;
  current_end: string | null;
}

function isSubActive(sub: SubscriptionRow): boolean {
  if (sub.status === "active" || sub.status === "authenticated") return true;
  if (sub.status === "cancelled" && sub.current_period_end) {
    return new Date(sub.current_period_end).getTime() > Date.now();
  }
  if (sub.status === "cancelled" && sub.current_end) {
    return new Date(sub.current_end).getTime() > Date.now();
  }
  return false;
}

/**
 * Resolve pro status for a given login email + connected Drive email.
 *
 * 1. Find the owning subscription: where loginEmail = owner's auth email
 *    OR loginEmail is in pro_seats.seat_email.
 * 2. No active sub → free.
 * 3. master_drive_email null → lock it to driveEmail (first connect) → pro.
 * 4. driveEmail === master_drive_email → pro.
 * 5. Mismatch → log violation, return free + drive_mismatch.
 *
 * If loginEmail is null (extension not signed in), falls back to
 * looking up pro_seats by driveEmail alone (the drive email might
 * itself be a seat email).
 */
export async function resolveProForDrive(
  admin: AdminClient,
  opts: { loginEmail?: string | null; driveEmail: string; ownerUserId?: string | null }
): Promise<ProCheckResult> {
  const driveEmail = opts.driveEmail.toLowerCase().trim();
  const loginEmail = opts.loginEmail?.toLowerCase().trim() ?? null;
  // The caller (authed route) already resolved the signed-in Supabase user id.
  // Passing it here avoids re-resolving the owner by email — which is both
  // fragile (public.users.email may be unset) and impossible for the auth
  // schema, since supabase-js cannot query `auth.users` via `.from()`.
  const ownerUserIdHint = opts.ownerUserId ?? null;

  // ── Step 1: Find owning subscription ──────────────────────────────────────
  let ownerUserId: string | null = null;

  if (loginEmail) {
    // Seat roster first — seat users have their own auth account, so we must
    // not treat loginEmail as the subscription owner without checking seats.
    const { data: seatRow } = await admin
      .from("pro_seats")
      .select("owner_user_id")
      .eq("seat_email", loginEmail)
      .maybeSingle();

    if (seatRow?.owner_user_id) {
      ownerUserId = seatRow.owner_user_id;
      console.log("[CM:pro-enforcement] found owner via seat:", loginEmail, "->", ownerUserId);
    }
  }

  // Owner path: the signed-in user is the subscription holder. Use the id the
  // route already authenticated — Step 2 still verifies they actually hold an
  // active subscription (or admin is_pro), so this cannot grant false pro.
  if (!ownerUserId && ownerUserIdHint) {
    ownerUserId = ownerUserIdHint;
    console.log("[CM:pro-enforcement] using authenticated owner id:", ownerUserId);
  }

  // Email fallback (e.g. drive-license check without a bearer token): map the
  // login email to a public.users row.
  if (!ownerUserId && loginEmail) {
    const { data: userRow } = await admin
      .from("users")
      .select("id")
      .ilike("email", loginEmail)
      .maybeSingle();

    if (userRow?.id) {
      ownerUserId = userRow.id;
      console.log("[CM:pro-enforcement] found owner via public.users:", loginEmail, "->", ownerUserId);
    }
  }

  // Unsigned-in fallback: drive email may itself be a seat login email.
  if (!ownerUserId) {
    const { data: seatRow } = await admin
      .from("pro_seats")
      .select("owner_user_id")
      .eq("seat_email", driveEmail)
      .maybeSingle();

    if (seatRow?.owner_user_id) {
      ownerUserId = seatRow.owner_user_id;
    }
  }

  if (!ownerUserId) {
    return { isPro: false, plan: "free", reason: "no_subscription" };
  }

  // ── Step 2: Get the owner's active subscription ───────────────────────────
  const { data: subs } = await admin
    .from("subscriptions")
    .select("user_id, master_drive_email, plan, status, current_period_end, current_end")
    .eq("user_id", ownerUserId)
    .in("status", ["active", "authenticated", "cancelled"])
    .order("created_at", { ascending: false });

  const activeSub = (subs ?? []).find(s => isSubActive(s as SubscriptionRow)) as SubscriptionRow | undefined;

  if (!activeSub) {
    // Also check is_pro flag as fallback (admin-granted pro)
    const { data: userRow } = await admin
      .from("users")
      .select("is_pro")
      .eq("id", ownerUserId)
      .maybeSingle();

    if (userRow?.is_pro === true) {
      // Admin-granted pro — no drive lock enforcement
      return { isPro: true, plan: "pro", reason: "ok", masterDriveEmail: null };
    }
    return { isPro: false, plan: "free", reason: "no_subscription" };
  }

  const masterDrive = activeSub.master_drive_email;

  // ── Step 3: First connect — lock the master Drive ─────────────────────────
  if (!masterDrive) {
    const { error: lockErr } = await admin
      .from("subscriptions")
      .update({ master_drive_email: driveEmail })
      .eq("user_id", ownerUserId);

    if (lockErr) {
      console.error("[CM:pro-enforcement] failed to lock master_drive_email:", lockErr);
    } else {
      console.log("[CM:pro-enforcement] locked master_drive_email:", driveEmail, "for owner:", ownerUserId);
    }

    return { isPro: true, plan: "pro", reason: "master_locked", masterDriveEmail: driveEmail };
  }

  // ── Step 4: Match check ───────────────────────────────────────────────────
  if (driveEmail === masterDrive) {
    return { isPro: true, plan: "pro", reason: "ok", masterDriveEmail: masterDrive };
  }

  // ── Step 5: Mismatch — flag + revoke ──────────────────────────────────────
  const offendingEmail = loginEmail ?? driveEmail;
  try {
    await admin.from("pro_violations").insert({
      owner_user_id: ownerUserId,
      offending_email: offendingEmail,
      attempted_drive_email: driveEmail,
      master_drive_email: masterDrive,
    });
    console.warn("[CM:pro-enforcement] DRIVE MISMATCH — revoked pro for", offendingEmail,
      "(connected:", driveEmail, "≠ master:", masterDrive, ")");
  } catch (err) {
    console.error("[CM:pro-enforcement] failed to log violation:", err);
  }

  return { isPro: false, plan: "free", reason: "drive_mismatch", masterDriveEmail: masterDrive };
}
