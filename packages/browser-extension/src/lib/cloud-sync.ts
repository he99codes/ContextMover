// packages/browser-extension/src/lib/cloud-sync.ts
//
// Mirrors local IndexedDB sessions into the shared Supabase `sessions` table
// so the web dashboard sees them in realtime. All operations are
// fire-and-forget: cloud failures must NEVER break local capture.

import { supabase, isSupabaseConfigured } from "./supabase";
import type { ContextSession } from "./types";

function toCloudRow(session: ContextSession, userId: string) {
  return {
    id: session.id,
    user_id: userId,
    platform: session.platform,
    title: session.title,
    messages: session.messages,
    created_at: new Date(session.createdAt).toISOString(),
    updated_at: new Date(session.updatedAt).toISOString(),
  };
}

async function getUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/**
 * Upsert a session to Supabase. Silent-fails if not configured / not signed in.
 */
export async function upsertSessionToCloud(session: ContextSession): Promise<void> {
  if (!isSupabaseConfigured) return;

  try {
    const userId = await getUserId();
    if (!userId) {
      console.log("[ContextForge:cloud] skip upsert — user not signed in");
      return;
    }

    const row = toCloudRow(session, userId);
    const { error } = await supabase.from("sessions").upsert(row, { onConflict: "id" });
    if (error) {
      console.warn("[ContextForge:cloud] upsert failed:", error.message);
    } else {
      console.log(
        `[ContextForge:cloud] upserted session ${session.id} (${session.messages.length} messages)`
      );
    }
  } catch (err) {
    console.warn("[ContextForge:cloud] upsert threw:", err);
  }
}

/**
 * Delete a session from Supabase. Silent-fails if not configured / not signed in.
 */
export async function deleteSessionFromCloud(sessionId: string): Promise<void> {
  if (!isSupabaseConfigured) return;

  try {
    const userId = await getUserId();
    if (!userId) return;

    const { error } = await supabase
      .from("sessions")
      .delete()
      .eq("id", sessionId)
      .eq("user_id", userId);
    if (error) console.warn("[ContextForge:cloud] delete failed:", error.message);
  } catch (err) {
    console.warn("[ContextForge:cloud] delete threw:", err);
  }
}

/**
 * One-shot bulk sync of every local session to the cloud — runs on sign-in so
 * previously-captured sessions still end up in the web dashboard.
 */
export async function bulkSyncToCloud(sessions: ContextSession[]): Promise<void> {
  if (!isSupabaseConfigured || sessions.length === 0) return;

  try {
    const userId = await getUserId();
    if (!userId) return;

    const rows = sessions.map((s) => toCloudRow(s, userId));
    const { error } = await supabase.from("sessions").upsert(rows, { onConflict: "id" });
    if (error) {
      console.warn("[ContextForge:cloud] bulk sync failed:", error.message);
    } else {
      console.log(`[ContextForge:cloud] bulk synced ${rows.length} sessions`);
    }
  } catch (err) {
    console.warn("[ContextForge:cloud] bulk sync threw:", err);
  }
}
