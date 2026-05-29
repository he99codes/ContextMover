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
  plan:    Plan;
  isPro:   boolean;
  limits:  UsageLimits;
  loading: boolean;
  error:   string | null;
}

const INITIAL: SubscriptionState = {
  plan:    "free",
  isPro:   false,
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
        plan:    (data.plan as Plan) ?? "free",
        isPro:   data.isPro ?? false,
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
