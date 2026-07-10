"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Auto-refreshes the page after `delayMs` milliseconds.
 * Used in the dashboard layout's loading state to retry getUser()
 * when a session cookie exists but hasn't propagated yet.
 */
export function AutoRefresh({ delayMs = 2000 }: { delayMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setTimeout(() => router.refresh(), delayMs);
    return () => clearTimeout(t);
  }, [router, delayMs]);
  return null;
}
