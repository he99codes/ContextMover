"use client";

import { useCallback } from "react";
import { getUserVaultClient } from "@/lib/user-vault/web-client";

/**
 * Hook that exposes mutating operations on the user's personal vault (cf_sessions).
 * ContextForge Supabase is NOT in this data path.
 */
export function useSessionMutations() {
  const deleteSession = useCallback(async (id: string) => {
    const client = getUserVaultClient();
    if (!client) throw new Error("Vault not connected");
    const { error } = await client.from("cf_sessions").delete().eq("id", id);
    if (error) throw new Error(error.message);
  }, []);

  const renameSession = useCallback(async (id: string, title: string) => {
    const client = getUserVaultClient();
    if (!client) throw new Error("Vault not connected");
    const { error } = await client
      .from("cf_sessions")
      .update({ title, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);
  }, []);

  return { deleteSession, renameSession };
}
