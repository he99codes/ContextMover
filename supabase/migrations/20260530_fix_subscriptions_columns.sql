-- Fix missing columns in subscriptions table
-- Run this in Supabase SQL Editor

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz,
  ADD COLUMN IF NOT EXISTS current_period_end   timestamptz,
  ADD COLUMN IF NOT EXISTS trial_end            timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at         timestamptz,
  ADD COLUMN IF NOT EXISTS gateway_customer_id     text,
  ADD COLUMN IF NOT EXISTS gateway_subscription_id text,
  ADD COLUMN IF NOT EXISTS interval             text DEFAULT 'month',
  ADD COLUMN IF NOT EXISTS amount               integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency             text DEFAULT 'usd';

-- Refresh schema cache so Supabase recognizes new columns immediately
NOTIFY pgrst, 'reload schema';

-- Ensure indexes exist
CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions(status);
