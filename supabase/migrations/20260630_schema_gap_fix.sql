-- ContextMover Schema Gap Fix — safe to run multiple times

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS razorpay_subscription_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS razorpay_plan_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS current_end timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ended_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'subscriptions_razorpay_subscription_id_key') THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_razorpay_subscription_id_key UNIQUE (razorpay_subscription_id);
  END IF;
END $$;

ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS razorpay_event_id text;
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS razorpay_payment_id text;
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS razorpay_subscription_id text;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS subscription_status text DEFAULT 'free';

ALTER TABLE migrations ADD COLUMN IF NOT EXISTS tier smallint;
ALTER TABLE migrations ADD COLUMN IF NOT EXISTS message_count integer DEFAULT 0;
ALTER TABLE migrations ADD COLUMN IF NOT EXISTS char_count integer DEFAULT 0;

CREATE INDEX IF NOT EXISTS migrations_migrated_at_idx ON migrations(migrated_at DESC);
CREATE INDEX IF NOT EXISTS migrations_user_idx ON migrations(user_id);
CREATE INDEX IF NOT EXISTS migrations_target_idx ON migrations(target_platform);
CREATE INDEX IF NOT EXISTS migrations_tier_idx ON migrations(tier);

CREATE TABLE IF NOT EXISTS global_stats (
  id INT PRIMARY KEY DEFAULT 1,
  total_migrations BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT single_row_check CHECK (id = 1)
);
INSERT INTO global_stats (id, total_migrations) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION increment_total_migrations(increment_value INT)
RETURNS void AS $$
  UPDATE global_stats SET total_migrations = total_migrations + increment_value WHERE id = 1;
$$ LANGUAGE sql VOLATILE;

-- Sync global_stats with actual migrations table count
UPDATE global_stats SET total_migrations = (SELECT COUNT(*) FROM migrations) WHERE id = 1;

CREATE OR REPLACE FUNCTION get_user_plan(p_user_id uuid)
RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(
    (SELECT plan FROM subscriptions
     WHERE user_id = p_user_id
     AND (
       status IN ('active', 'authenticated', 'trialing')
       OR (status = 'cancelled'
           AND COALESCE(current_period_end, current_end) IS NOT NULL
           AND COALESCE(current_period_end, current_end) > now())
     )
     ORDER BY created_at DESC
     LIMIT 1),
    (SELECT plan FROM users WHERE id = p_user_id AND is_pro = true LIMIT 1),
    'free'
  );
$$;

NOTIFY pgrst, 'reload schema';
