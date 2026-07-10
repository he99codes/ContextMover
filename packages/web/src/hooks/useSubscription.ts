"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  type Plan,
  type UsageLimits,
  FREE_LIMITS,
  PRO_LIMITS,
} from "@/lib/payments/types";

interface SubscriptionState {
  plan:      Plan;
  isPro:     boolean;
  limits:    UsageLimits;
  loading:   boolean;
  error:     string | null;
  interval:  string | null;
  status:    string;
  currentEnd: string | null;
}

const INITIAL: SubscriptionState = {
  plan:      "free",
  isPro:     false,
  limits:    FREE_LIMITS,
  loading:   true,
  error:     null,
  interval:  null,
  status:    "free",
  currentEnd: null,
};

// VV: Client-side cache to deduplicate /api/payments/subscription calls
// across multiple components using useSubscription simultaneously.
let _cache: { data: SubscriptionState; ts: number } | null = null;
const CACHE_TTL_MS = 30_000; // 30 seconds

export function useSubscription(): SubscriptionState & { refresh: (force?: boolean) => Promise<void> } {
  const [state, setState] = useState<SubscriptionState>(
    _cache && Date.now() - _cache.ts < CACHE_TTL_MS ? _cache.data : INITIAL
  );

  const refresh = useCallback(async (force?: boolean) => {
    // Return cached data if fresh and not forced
    if (!force && _cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
      setState(_cache.data);
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setState({ ...INITIAL, loading: false });
        return;
      }

      const res = await fetch("/api/payments/subscription", {
        headers: { authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error("Failed to fetch subscription");

      const data = await res.json();
      const next: SubscriptionState = {
        plan:       (data.plan as Plan) ?? "free",
        isPro:      data.isPro ?? false,
        limits:     data.isPro ? PRO_LIMITS : FREE_LIMITS,
        loading:    false,
        error:      null,
        interval:   data.interval ?? null,
        status:     data.status ?? "free",
        currentEnd: data.currentEnd ?? null,
      };
      _cache = { data: next, ts: Date.now() };
      setState(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, loading: false, error: msg }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}
