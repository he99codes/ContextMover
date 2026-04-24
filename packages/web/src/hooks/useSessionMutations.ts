"use client";

import { useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

type SessionUpdate = Database["public"]["Tables"]["sessions"]["Update"];

/**
 * Hook that exposes mutating operations on the shared Supabase `sessions`
 * table. Every mutation propagates to:
 *   1. The web dashboard (via useRealtimeSessions)
 *   2. The ContextForge browser extension (via its own realtime subscription)
 * so the two stay perfectly in sync.
 */
export function useSessionMutations() {
  const deleteSession = useCallback(async (id: string) => {
    const supabase = createClient();
    const { error } = await supabase.from("sessions").delete().eq("id", id);
    if (error) throw new Error(error.message);
  }, []);

  const renameSession = useCallback(async (id: string, title: string) => {
    const supabase = createClient();
    const payload: SessionUpdate = {
      title,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("sessions")
      // Cast is required because @supabase/ssr's generic inference collapses
      // the update() parameter to `never` in some TS configurations even when
      // the Database type is correctly supplied. Payload is validated above.
      .update(payload as never)
      .eq("id", id);
    if (error) throw new Error(error.message);
  }, []);

  return { deleteSession, renameSession };
}
