-- ContextForge Prompt Engine — Phase 1
-- Run this in the Supabase SQL editor or via supabase db push

-- ── Prompt templates ─────────────────────────────────────────────────────────
create table if not exists prompt_templates (
  id            text        primary key,
  user_id       uuid        references auth.users(id) on delete cascade,
  name          text        not null,
  description   text        default '',
  content       text        not null,
  icon          text        default '⚙️',
  tags          text[]      default '{}',
  target_platforms text[]   default '{all}',
  is_default    boolean     default false,
  is_system     boolean     default false,
  usage_count   integer     default 0,
  last_used_at  timestamptz,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ── Prompt assignments ────────────────────────────────────────────────────────
create table if not exists prompt_assignments (
  id          text        primary key,
  user_id     uuid        references auth.users(id) on delete cascade,
  template_id text        references prompt_templates(id) on delete cascade,
  session_id  text,
  platform    text,
  created_at  timestamptz default now(),
  -- One assignment per (user, session_or_platform) pair
  unique (user_id, coalesce(session_id, ''), coalesce(platform, ''))
);

-- ── Row-level security ────────────────────────────────────────────────────────
alter table prompt_templates   enable row level security;
alter table prompt_assignments enable row level security;

create policy "Users manage own templates"
  on prompt_templates for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users manage own assignments"
  on prompt_assignments for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Realtime ──────────────────────────────────────────────────────────────────
alter publication supabase_realtime add table prompt_templates;
alter publication supabase_realtime add table prompt_assignments;

-- ── updated_at trigger ────────────────────────────────────────────────────────
create or replace function update_updated_at_column()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger prompt_templates_updated_at
  before update on prompt_templates
  for each row execute function update_updated_at_column();
