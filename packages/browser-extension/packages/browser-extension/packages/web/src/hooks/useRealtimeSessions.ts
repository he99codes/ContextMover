"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Session } from "@/types";

export function useRealtimeSessions(
  userId: string,
  initialSessions: Session[] = []
) {
  const [sessions, setSessions] = useState<Session[]>(initialSessions);
  // Track whether the server-rendered prop has changed without JSON.stringify
  // (which serialises the full messages array on every render — O(n) expensive).
  const prevInitialRef = useRef<Session[]>(initialSessions);

  useEffect(() => {
    if (prevInitialRef.current !== initialSessions) {
      prevInitialRef.current = initialSessions;
      setSessions(initialSessions);
    }
  }, [initialSessions]);

  useEffect(() => {
    if (!userId) return;

    const supabase = createClient();

    const channel = supabase
      .channel("sessions-realtime")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "sessions",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setSessions((prev) => [payload.new as Session, ...prev]);
          } else if (payload.eventType === "UPDATE") {
            setSessions((prev) =>
              prev.map((s) =>
                s.id === (payload.new as Session).id
                  ? (payload.new as Session)
                  : s
              )
            );
          } else if (payload.eventType === "DELETE") {
            setSessions((prev) =>
              prev.filter((s) => s.id !== (payload.old as Partial<Session>).id)
            );
          }
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  return { sessions, setSessions };
}
