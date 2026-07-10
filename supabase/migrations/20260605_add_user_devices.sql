-- Migration: user_devices
-- Tracks per-profile extension installations for pro account sharing abuse prevention.
-- A single pro account is limited to PRO_DEVICE_LIMIT (5) concurrent install IDs.
-- Safe to run against an existing table — uses IF NOT EXISTS / DO NOTHING guards.

create table if not exists public.user_devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  install_id  text not null,
  last_seen   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- Add the unique constraint if it doesn't already exist.
-- The upsert in /api/payments/subscription uses ON CONFLICT (user_id, install_id)
-- and will fail silently without this constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_devices_unique'
      AND conrelid = 'public.user_devices'::regclass
  ) THEN
    ALTER TABLE public.user_devices
      ADD CONSTRAINT user_devices_unique UNIQUE (user_id, install_id);
  END IF;
END $$;

-- Fast lookup: "how many devices does this user have?"
create index if not exists user_devices_user_id_idx on public.user_devices (user_id);

-- RLS: only service-role (admin client) may read/write.
alter table public.user_devices enable row level security;

-- Drop old policy first so re-running is idempotent.
drop policy if exists "service_role_only" on public.user_devices;

create policy "service_role_only" on public.user_devices
  using (false)
  with check (false);
