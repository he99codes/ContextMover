/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

// packages/browser-extension/src/lib/cloud-sync.ts
//
// Syncs user prompt templates and assignments to ContextMover's Supabase.
//
// SESSION DATA IS NEVER STORED HERE.
// Sessions live ONLY in local IndexedDB and, optionally, the user's own
// personal Supabase vault (see src/lib/user-vault/connector.ts).
//
// All operations are fire-and-forget: cloud failures must NEVER break anything.

import { supabase, isSupabaseConfigured } from "./supabase";
import { getDb } from "./db";
import type { PromptTemplate, PromptAssignment } from "./prompt-engine/types";
import type { ContextSession } from "./types";

// ── Vault sync rate limiter ──────────────────────────────────────────────────
// Only fires at most once per MIN_VAULT_SYNC_INTERVAL.
// Multiple rapid captures coalesce — only the latest session is flushed.

let lastVaultSyncTime = 0;
let pendingVaultSync: ContextSession | null = null;
let vaultSyncTimer: ReturnType<typeof setTimeout> | null = null;
const MIN_VAULT_SYNC_INTERVAL = 30_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function queueVaultSync(session: ContextSession, vaultClient: any): Promise<void> {
  pendingVaultSync = session;

  const now = Date.now();
  const timeSinceLast = now - lastVaultSyncTime;

  if (timeSinceLast >= MIN_VAULT_SYNC_INTERVAL) {
    await flushVaultSync(vaultClient);
  } else {
    if (vaultSyncTimer) clearTimeout(vaultSyncTimer);
    const delay = MIN_VAULT_SYNC_INTERVAL - timeSinceLast;
    vaultSyncTimer = setTimeout(() => {
      void flushVaultSync(vaultClient);
    }, delay);
    console.log(`[ContextMover:vault] Sync queued in ${delay}ms for session ${session.id}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flushVaultSync(vaultClient: any): Promise<void> {
  if (!pendingVaultSync) return;
  const session = pendingVaultSync;
  pendingVaultSync = null;
  lastVaultSyncTime = Date.now();

  try {
    await vaultClient.from("cm_sessions").upsert({
      id: session.id,
      platform: session.platform,
      title: session.customName ?? session.title,
      messages: session.messages,
      message_count: session.messages.length,
      user_message_count: session.messages.filter((m) => m.role === "user").length,
      assistant_message_count: session.messages.filter((m) => m.role === "assistant").length,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
    console.log(`[ContextMover:vault] Synced session ${session.id} (${session.messages.length} messages)`);
  } catch (err) {
    console.warn("[ContextMover:vault] Sync failed:", err);
    // Re-queue on failure so the next interval picks it up
    pendingVaultSync = session;
  }
}

async function getUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/**
 * Returns true if the named table exists and is accessible in Supabase.
 * Uses a lightweight SELECT id LIMIT 1 probe — a table-not-found error
 * means the table is absent; any other error is treated as "inaccessible".
 * Never throws.
 */
async function tableExists(tableName: string): Promise<boolean> {
  try {
    const { error } = await supabase.from(tableName).select('id').limit(1);
    if (!error) return true;
    // Supabase returns code '42P01' (undefined_table) when the table is missing.
    // The message check is a human-readable fallback for older client versions.
    const isMissing =
      (error as unknown as { code?: string }).code === '42P01' ||
      error.message?.toLowerCase().includes('does not exist') ||
      error.message?.toLowerCase().includes('could not find');
    if (isMissing) {
      console.log(`[ContextMover:cloud] ${tableName} not found in Supabase, skipping sync`);
    } else {
      console.warn(`[ContextMover:cloud] ${tableName} probe failed:`, error.message);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Sync user prompt templates between IndexedDB and Supabase.
 * Last-write-wins by updatedAt. Never throws.
 */
export async function syncPromptTemplates(userId: string): Promise<void> {
  if (!isSupabaseConfigured || !userId) return;
  try {
    if (!await tableExists('prompt_templates')) return;
    const { data: cloudRows, error } = await supabase
      .from("prompt_templates")
      .select("*")
      .eq("user_id", userId);
    if (error) { console.warn("[ContextMover:cloud] prompt_templates fetch failed:", error.message); return; }

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

    console.log(`[ContextMover:cloud] synced ${synced} prompt templates`);
  } catch (err) {
    console.warn("[ContextMover:cloud] syncPromptTemplates threw:", err);
  }
}

/**
 * Sync prompt assignments between IndexedDB and Supabase.
 * Never throws.
 */
export async function syncPromptAssignments(userId: string): Promise<void> {
  if (!isSupabaseConfigured || !userId) return;
  try {
    if (!await tableExists('prompt_assignments')) return;
    const { data: cloudRows, error } = await supabase
      .from("prompt_assignments")
      .select("*")
      .eq("user_id", userId);
    if (error) { console.warn("[ContextMover:cloud] prompt_assignments fetch failed:", error.message); return; }

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

    console.log(`[ContextMover:cloud] synced ${synced} prompt assignments`);
  } catch (err) {
    console.warn("[ContextMover:cloud] syncPromptAssignments threw:", err);
  }
}
