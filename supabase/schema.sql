-- ============================================================
-- ContextForge Supabase Schema
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Sessions table
create table if not exists sessions (
  id text primary key,
  user_id uuid references auth.users(id) on delete cascade,
  platform text not null,
  title text,
  messages jsonb not null default '[]',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Migrations table
create table if not exists migrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  session_id text references sessions(id) on delete cascade,
  source_platform text,
  target_platform text,
  migrated_at timestamptz default now()
);

-- Custom agents table
create table if not exists custom_agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  url text not null,
  input_selector text,
  message_selector text,
  role_detection text,
  output_format text default 'markdown',
  created_at timestamptz default now()
);

-- ============================================================
-- [SECURITY] Row Level Security
-- Every table is locked down so each authenticated user can
-- only read/write rows where user_id = auth.uid().
-- The anon key CANNOT bypass these policies.
-- service_role key CAN bypass them — never expose it client-side.
-- ============================================================

alter table sessions enable row level security;
alter table migrations enable row level security;
alter table custom_agents enable row level security;

-- [SECURITY] Sessions — owner-only access for ALL operations.
-- Single FOR ALL policy avoids gaps between individual per-operation policies.
drop policy if exists "Users can view their own sessions" on sessions;
drop policy if exists "Users can insert their own sessions" on sessions;
drop policy if exists "Users can update their own sessions" on sessions;
drop policy if exists "Users can delete their own sessions" on sessions;

create policy "sessions_owner_only"
  on sessions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- [SECURITY] Migrations — owner-only access for ALL operations.
-- Migrations records are append-only in practice but we still lock every op.
drop policy if exists "Users can view their own migrations" on migrations;
drop policy if exists "Users can insert their own migrations" on migrations;
drop policy if exists "Users can delete their own migrations" on migrations;

create policy "migrations_owner_only"
  on migrations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- [SECURITY] Custom agents — owner-only access for ALL operations.
drop policy if exists "Users can view their own agents" on custom_agents;
drop policy if exists "Users can insert their own agents" on custom_agents;
drop policy if exists "Users can update their own agents" on custom_agents;
drop policy if exists "Users can delete their own agents" on custom_agents;

create policy "custom_agents_owner_only"
  on custom_agents for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- [SECURITY] Supabase Realtime — channel-level security
-- Postgres Changes subscriptions are filtered through RLS automatically.
-- The filter `user_id=eq.<uid>` in realtime-sync.ts ensures each client
-- only receives events for their own rows.  RLS is the backstop — even
-- if the filter were removed, the user would only receive rows where
-- auth.uid() = user_id due to the policy above.
-- ============================================================
-- Enable realtime for the sessions table (run once):
--   alter publication supabase_realtime add table sessions;
--
-- Do NOT add migrations or custom_agents to the realtime publication
-- unless needed — keep the realtime surface area minimal.

-- ============================================================
-- Auto-update updated_at trigger
-- ============================================================

create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger update_sessions_updated_at
  before update on sessions
  for each row
  execute function update_updated_at_column();

-- ============================================================
-- Realtime: enable for sessions table
-- ============================================================
-- Run this to enable realtime on the sessions table:
-- alter publication supabase_realtime add table sessions;
