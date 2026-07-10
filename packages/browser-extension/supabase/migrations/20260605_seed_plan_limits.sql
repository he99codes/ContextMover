-- Migration: seed plan_limits rows for all pro plan variants.
-- Table already exists in production. This is idempotent — safe to re-run.
-- 'pro'            = admin-granted via admin panel (manual gateway)
-- 'monthly'        = Razorpay monthly billing
-- 'annual'         = Razorpay annual billing
-- 'monthly_earlybird' / 'annual_earlybird' = early-bird Razorpay plans
-- Without matching rows, getUserPlan() falls back to the table defaults (50/20/10)
-- but is_unlimited stays false → pro users hit the migration gate.

-- Seed free plan (ensure baseline row exists — never unlimited)
INSERT INTO public.plan_limits (plan, tier1_limit, tier2_limit, tier3_limit, is_unlimited)
VALUES ('free', 8, 3, 3, false)
ON CONFLICT (plan) DO UPDATE SET
  tier1_limit  = 8,
  tier2_limit  = 3,
  tier3_limit  = 3,
  is_unlimited = false;

-- Seed all pro plan variants as unlimited
INSERT INTO public.plan_limits (plan, tier1_limit, tier2_limit, tier3_limit, is_unlimited)
VALUES
  ('pro',                999999, 999999, 999999, true),
  ('monthly',            999999, 999999, 999999, true),
  ('annual',             999999, 999999, 999999, true),
  ('monthly_earlybird',  999999, 999999, 999999, true),
  ('annual_earlybird',   999999, 999999, 999999, true),
  ('team',               999999, 999999, 999999, true)
ON CONFLICT (plan) DO UPDATE SET
  tier1_limit  = EXCLUDED.tier1_limit,
  tier2_limit  = EXCLUDED.tier2_limit,
  tier3_limit  = EXCLUDED.tier3_limit,
  is_unlimited = EXCLUDED.is_unlimited;

-- RLS: publicly readable (limits are not secret), service role writes only.
-- Drop first to make this idempotent.
ALTER TABLE public.plan_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "plan_limits_read"          ON public.plan_limits;
DROP POLICY IF EXISTS "plan_limits_service_write" ON public.plan_limits;

CREATE POLICY "plan_limits_read" ON public.plan_limits
  FOR SELECT USING (true);

CREATE POLICY "plan_limits_service_write" ON public.plan_limits
  FOR ALL USING (false) WITH CHECK (false);

NOTIFY pgrst, 'reload schema';
