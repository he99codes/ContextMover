-- ContextMover — Payments schema migration
-- Run this in the Supabase SQL editor for your project.
-- Safe to run multiple times (all statements are idempotent).

-- ─────────────────────────────────────────────────────────────────
-- 1. PUBLIC USERS PROFILE TABLE
--    References auth.users so every signup gets a row via trigger.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
  id          UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email       TEXT,
  is_pro      BOOLEAN     NOT NULL DEFAULT FALSE,
  plan        TEXT        NOT NULL DEFAULT 'free',
  pro_since   TIMESTAMPTZ,
  gateway     TEXT,
  subscription_id TEXT,
  payment_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add columns if the table already existed without them.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_pro      BOOLEAN     NOT NULL DEFAULT FALSE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS plan        TEXT        NOT NULL DEFAULT 'free';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pro_since   TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS gateway     TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS subscription_id TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS payment_id  TEXT;

-- RLS
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own profile"   ON public.users;
DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can view own profile"
  ON public.users FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile"
  ON public.users FOR UPDATE USING (auth.uid() = id);

-- Auto-create profile on signup.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.users (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────
-- 2. PAYMENTS LOG
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payments (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID        REFERENCES public.users(id) ON DELETE SET NULL,
  gateway    TEXT        NOT NULL,
  payment_id TEXT,
  order_id   TEXT,
  amount     INTEGER,
  currency   TEXT,
  plan       TEXT,
  status     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users see own payments" ON public.payments;
CREATE POLICY "Users see own payments"
  ON public.payments FOR SELECT USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────
-- 3. USAGE TRACKING (freemium limits)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.usage (
  id       UUID  DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id  UUID  REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  feature  TEXT  NOT NULL,
  month    TEXT  NOT NULL,  -- format: '2026-05'
  count    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, feature, month)
);

ALTER TABLE public.usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users see own usage" ON public.usage;
CREATE POLICY "Users see own usage"
  ON public.usage FOR SELECT USING (auth.uid() = user_id);
