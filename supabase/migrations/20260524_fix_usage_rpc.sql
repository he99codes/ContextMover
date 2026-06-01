-- =============================================================
-- RUN THIS IN SUPABASE SQL EDITOR (Project → SQL Editor → New query)
-- =============================================================
-- Atomic check-and-increment for usage_counters.
-- Uses FOR UPDATE row-level locking so concurrent migrations from
-- the same user account cannot race past the free-tier limit.
--
-- ASSUMPTIONS:
--   table: usage_counters
--   columns: user_id uuid, month text, tier1_count int,
--            tier2_count int, tier3_count int, updated_at timestamptz
--   unique constraint: (user_id, month)
--
-- After pasting, click "Run". Verify with:
--   SELECT proname FROM pg_proc WHERE proname = 'decrement_migration_safe_v2';
-- =============================================================

CREATE OR REPLACE FUNCTION decrement_migration_safe_v2(
  p_user_id     uuid,
  p_month       text,
  p_tier_column text,
  p_limit       int
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_count int;
  new_count     int;
BEGIN
  -- Ensure row exists before locking
  INSERT INTO usage_counters (user_id, month, tier1_count, tier2_count, tier3_count)
  VALUES (p_user_id, p_month, 0, 0, 0)
  ON CONFLICT (user_id, month) DO NOTHING;

  -- Row-level lock + read
  IF p_tier_column = 'tier1_count' THEN
    SELECT tier1_count INTO current_count FROM usage_counters
    WHERE user_id = p_user_id AND month = p_month FOR UPDATE;
  ELSIF p_tier_column = 'tier2_count' THEN
    SELECT tier2_count INTO current_count FROM usage_counters
    WHERE user_id = p_user_id AND month = p_month FOR UPDATE;
  ELSE
    SELECT tier3_count INTO current_count FROM usage_counters
    WHERE user_id = p_user_id AND month = p_month FOR UPDATE;
  END IF;

  IF current_count >= p_limit THEN
    RETURN jsonb_build_object('allowed', false, 'remaining', 0, 'used', current_count);
  END IF;

  new_count := current_count + 1;

  EXECUTE format(
    'UPDATE usage_counters SET %I = $1, updated_at = NOW() WHERE user_id = $2 AND month = $3',
    p_tier_column
  ) USING new_count, p_user_id, p_month;

  RETURN jsonb_build_object('allowed', true, 'remaining', p_limit - new_count, 'used', new_count);
END;
$$;

-- =============================================================
-- Bug reports table (used by Issue 4)
-- =============================================================

CREATE TABLE IF NOT EXISTS bug_reports (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  email       text,
  description text NOT NULL,
  severity    text DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  version     text,
  platform    text,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE bug_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON bug_reports FOR ALL USING (true) WITH CHECK (true);

-- =============================================================
-- Refund requests + disputes tables (used by Issue 5)
-- =============================================================

CREATE TABLE IF NOT EXISTS refund_requests (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  payment_id text,
  reason     text,
  status     text DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz DEFAULT now()
);
ALTER TABLE refund_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_select"  ON refund_requests FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users_own_insert"  ON refund_requests FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "service_role_all"  ON refund_requests FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE TABLE IF NOT EXISTS disputes (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid,
  payment_id text,
  dispute_id text UNIQUE,
  status     text DEFAULT 'open',
  evidence   jsonb,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON disputes FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
