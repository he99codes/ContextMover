"use client";

/**
 * Copyright © 2026 ContextMover. All rights reserved.
 * Unauthorized copying, modification, distribution, or use
 * of this software, via any medium, is strictly prohibited.
 * Proprietary and confidential.
 */
// packages/web/src/hooks/useSubscription.ts
// Loads the authenticated user's subscription + usage + limits from
// /api/payments/subscription. Refresh manually with the returned `refresh()`.

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  type Plan,
  type UsageData,
  type UsageLimits,
  FREE_LIMITS,
  PRO_LIMITS,
} from "@/lib/payments/types";

interface SubscriptionState {
  plan:    Plan;
  isPro:   boolean;
  usage:   UsageData | null;
  limits:  UsageLimits;
  loading: boolean;
  error:   string | null;
}

const INITIAL: SubscriptionState = {
  plan:    "free",
  isPro:   false,
  usage:   null,
  limits:  FREE_LIMITS,
  loading: true,
  error:   null,
};

export function useSubscription(): SubscriptionState & { refresh: () => void } {
  const [state, setState] = useState<SubscriptionState>(INITIAL);

  const refresh = useCallback(async () => {
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
      setState({
        plan:    data.subscription.plan,
        isPro:   data.isPro,
        usage:   data.usage,
        limits:  data.isPro ? PRO_LIMITS : FREE_LIMITS,
        loading: false,
        error:   null,
      });
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
