"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { useCallback } from "react";
import { getUserVaultClient } from "@/lib/user-vault/web-client";

/**
 * Hook that exposes mutating operations on the user's personal vault (cm_sessions).
 * ContextMover Supabase is NOT in this data path.
 */
export function useSessionMutations() {
  const deleteSession = useCallback(async (id: string) => {
    const client = getUserVaultClient();
    if (!client) throw new Error("Vault not connected");
    const { error } = await client.from("cm_sessions").delete().eq("id", id);
    if (error) throw new Error(error.message);
  }, []);

  const renameSession = useCallback(async (id: string, title: string) => {
    const client = getUserVaultClient();
    if (!client) throw new Error("Vault not connected");
    const { error } = await client
      .from("cm_sessions")
      .update({ title, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);
  }, []);

  return { deleteSession, renameSession };
}
