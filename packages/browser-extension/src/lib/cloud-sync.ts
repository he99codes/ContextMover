// packages/browser-extension/src/lib/cloud-sync.ts
//
// Mirrors local IndexedDB sessions into the shared Supabase `sessions` table
// so the web dashboard sees them in realtime. All operations are
// fire-and-forget: cloud failures must NEVER break local capture.

import { supabase, isSupabaseConfigured } from "./supabase";
import { getDb } from "./db";
import type { ContextSession } from "./types";
import type { PromptTemplate, PromptAssignment } from "./prompt-engine/types";

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

  const userId = await getUserId();
  if (!userId) return;

  try {
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
  // Fire-and-forget prompt data sync after session sync
  void syncPromptTemplates(userId);
  void syncPromptAssignments(userId);
}

/**
 * Sync user prompt templates between IndexedDB and Supabase.
 * Last-write-wins by updatedAt. Never throws.
 */
export async function syncPromptTemplates(userId: string): Promise<void> {
  if (!isSupabaseConfigured || !userId) return;
  try {
    const { data: cloudRows, error } = await supabase
      .from("prompt_templates")
      .select("*")
      .eq("user_id", userId);
    if (error) { console.warn("[ContextForge:cloud] prompt_templates fetch failed:", error.message); return; }

    const db = await getDb();
    const localTemplates: PromptTemplate[] = await db.getAll("prompt_templates");
    const localMap = new Map(localTemplates.map((t) => [t.id, t]));

    let synced = 0;
    for (const row of cloudRows ?? []) {
      const local = localMap.get(row.id);
      const cloudUpdatedAt = new Date(row.updated_at).getTime();
      if (!local || cloudUpdatedAt > local.updatedAt) {
        const t: PromptTemplate = {
          id: row.id,
          userId: row.user_id,
          name: row.name,
          description: row.description ?? "",
          content: row.content,
          icon: row.icon ?? "⚙️",
          tags: row.tags ?? [],
          targetPlatforms: row.target_platforms ?? ["all"],
          isDefault: row.is_default ?? false,
          isSystem: false,
          usageCount: row.usage_count ?? 0,
          lastUsedAt: row.last_used_at ? new Date(row.last_used_at).getTime() : null,
          createdAt: new Date(row.created_at).getTime(),
          updatedAt: cloudUpdatedAt,
        };
        await db.put("prompt_templates", t);
        synced++;
      }
    }

    // Push local-only templates to cloud
    const cloudIds = new Set((cloudRows ?? []).map((r) => r.id));
    for (const local of localTemplates) {
      if (!cloudIds.has(local.id)) {
        const row = {
          id: local.id, user_id: userId, name: local.name, description: local.description,
          content: local.content, icon: local.icon, tags: local.tags,
          target_platforms: local.targetPlatforms, is_default: local.isDefault,
          is_system: false, usage_count: local.usageCount,
          last_used_at: local.lastUsedAt ? new Date(local.lastUsedAt).toISOString() : null,
          updated_at: new Date(local.updatedAt).toISOString(),
        };
        await supabase.from("prompt_templates").upsert(row, { onConflict: "id" });
        synced++;
      }
    }

    console.log(`[ContextForge:cloud] synced ${synced} prompt templates`);
  } catch (err) {
    console.warn("[ContextForge:cloud] syncPromptTemplates threw:", err);
  }
}

/**
 * Sync prompt assignments between IndexedDB and Supabase.
 * Never throws.
 */
export async function syncPromptAssignments(userId: string): Promise<void> {
  if (!isSupabaseConfigured || !userId) return;
  try {
    const { data: cloudRows, error } = await supabase
      .from("prompt_assignments")
      .select("*")
      .eq("user_id", userId);
    if (error) { console.warn("[ContextForge:cloud] prompt_assignments fetch failed:", error.message); return; }

    const db = await getDb();
    const localAssignments: PromptAssignment[] = await db.getAll("prompt_assignments");
    const localIds = new Set(localAssignments.map((a) => a.id));

    let synced = 0;
    for (const row of cloudRows ?? []) {
      if (!localIds.has(row.id)) {
        const a: PromptAssignment = {
          id: row.id, userId: row.user_id, templateId: row.template_id,
          sessionId: row.session_id ?? undefined, platform: row.platform ?? undefined,
          createdAt: new Date(row.created_at).getTime(),
        };
        await db.put("prompt_assignments", a);
        synced++;
      }
    }

    // Push local-only assignments to cloud
    const cloudIds = new Set((cloudRows ?? []).map((r) => r.id));
    for (const local of localAssignments) {
      if (!cloudIds.has(local.id)) {
        await supabase.from("prompt_assignments").upsert({
          id: local.id, user_id: userId, template_id: local.templateId,
          session_id: local.sessionId ?? null, platform: local.platform ?? null,
          created_at: new Date(local.createdAt).toISOString(),
        }, { onConflict: "id" });
        synced++;
      }
    }

    console.log(`[ContextForge:cloud] synced ${synced} prompt assignments`);
  } catch (err) {
    console.warn("[ContextForge:cloud] syncPromptAssignments threw:", err);
  }
}
