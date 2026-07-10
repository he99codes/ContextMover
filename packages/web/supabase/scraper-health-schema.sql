-- ──────────────────────────────────────────────────────────────────────────
-- ContextMover — Scraper Health Infrastructure
-- Adds: scraper_configs, scraper_bug_reports
-- Run this in the Supabase SQL Editor (public schema).
-- ──────────────────────────────────────────────────────────────────────────

-- ── Scraper configs (remote selector overrides pushed to all users) ─────────
create table if not exists scraper_configs (
  id           uuid primary key default gen_random_uuid(),
  platform_id  text not null unique,
  selectors    jsonb not null default '{}',
  -- { userSelector, assistantSelector, rootSelector, inputSelector,
  --   messageSelector, contentSelector, scrollContainer }
  version      integer not null default 1,
  is_active    boolean not null default true,
  notes        text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- ── Scraper bug reports (user-submitted selector fixes via Self-Heal Wizard) ─
create table if not exists scraper_bug_reports (
  id            uuid primary key default gen_random_uuid(),
  platform_id   text not null,
  error_message text,
  href          text,
  dom_snippet   text,
  user_id       uuid references auth.users(id) on delete set null,
  reviewed      boolean not null default false,
  promoted      boolean not null default false,
  created_at    timestamptz default now()
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
create index if not exists scraper_configs_platform_idx
  on scraper_configs (platform_id);

create index if not exists scraper_bug_reports_platform_idx
  on scraper_bug_reports (platform_id);


-- ── RLS — scraper_configs is public read, admin write ───────────────────────
alter table scraper_configs enable row level security;

create policy "scraper_configs: public read"
  on scraper_configs for select
  using (true);

-- Write access only via service_role key (admin API routes).
-- No INSERT/UPDATE/DELETE policy for anon or authenticated roles.

-- ── RLS — scraper_bug_reports: insert-only for authenticated users ───────────
alter table scraper_bug_reports enable row level security;

create policy "scraper_bug_reports: authenticated insert"
  on scraper_bug_reports for insert
  to authenticated
  with check (true);

create policy "scraper_bug_reports: anon insert"
  on scraper_bug_reports for insert
  to anon
  with check (true);

-- Only service_role can SELECT / UPDATE (admin review workflow).

-- ──────────────────────────────────────────────────────────────────────────
-- ContextMover — Usage & Bug Report Infrastructure
-- Required by /api/admin/stats, /api/admin/users, /api/admin/bug-reports
-- ──────────────────────────────────────────────────────────────────────────

-- ── Usage counters (per user per month) ────────────────────────────────────
create table if not exists usage_counters (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade not null,
  month         text not null,  -- 'YYYY-MM'
  tier1_count   integer not null default 0,
  tier2_count   integer not null default 0,
  tier3_count   integer not null default 0,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (user_id, month)
);

alter table usage_counters enable row level security;
create policy "usage_counters: owner read" on usage_counters for select using (auth.uid() = user_id);

-- ── Bug reports (from extension support widget) ─────────────────────────────
create table if not exists bug_reports (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  email         text,
  severity      text not null default 'medium',  -- 'critical' | 'high' | 'medium' | 'low'
  description   text not null,
  version       text,
  platform      text,
  logs          text,
  created_at    timestamptz default now()
);

alter table bug_reports enable row level security;
create policy "bug_reports: authenticated insert" on bug_reports for insert to authenticated with check (true);
create policy "bug_reports: anon insert"          on bug_reports for insert to anon          with check (true);

-- ── Usage tracking (migration event log) ───────────────────────────────────
create table if not exists usage_tracking (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  event_type    text not null,  -- 'migration_tier1' | 'migration_tier2' | 'migration_tier3'
  platform      text,
  created_at    timestamptz default now()
);

alter table usage_tracking enable row level security;
create policy "usage_tracking: owner read" on usage_tracking for select using (auth.uid() = user_id);

-- ── Payment events (webhook audit log) ─────────────────────────────────────
create table if not exists payment_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  gateway       text not null,  -- 'razorpay' | 'stripe'
  event_type    text not null,
  payload       jsonb,
  created_at    timestamptz default now()
);

alter table payment_events enable row level security;

-- ── Users table (public profile, mirrors auth.users metadata) ──────────────
create table if not exists users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  full_name     text,
  avatar_url    text,
  is_pro        boolean not null default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table users enable row level security;
create policy "users: owner all" on users for all using (auth.uid() = id) with check (auth.uid() = id);
