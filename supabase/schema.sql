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
-- Row Level Security
-- ============================================================

alter table sessions enable row level security;
alter table migrations enable row level security;
alter table custom_agents enable row level security;

-- Sessions policies
create policy "Users can view their own sessions"
  on sessions for select
  using (auth.uid() = user_id);

create policy "Users can insert their own sessions"
  on sessions for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own sessions"
  on sessions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own sessions"
  on sessions for delete
  using (auth.uid() = user_id);

-- Migrations policies
create policy "Users can view their own migrations"
  on migrations for select
  using (auth.uid() = user_id);

create policy "Users can insert their own migrations"
  on migrations for insert
  with check (auth.uid() = user_id);

create policy "Users can delete their own migrations"
  on migrations for delete
  using (auth.uid() = user_id);

-- Custom agents policies
create policy "Users can view their own agents"
  on custom_agents for select
  using (auth.uid() = user_id);

create policy "Users can insert their own agents"
  on custom_agents for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own agents"
  on custom_agents for update
  using (auth.uid() = user_id);

create policy "Users can delete their own agents"
  on custom_agents for delete
  using (auth.uid() = user_id);

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
