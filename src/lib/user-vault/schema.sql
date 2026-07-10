-- ContextMover Personal Vault Schema
-- Run this in YOUR Supabase project → SQL Editor
-- All tables are prefixed with cf_ to avoid conflicts.
-- No RLS needed — this is a single-user project.
-- ContextMover servers never touch this database.

-- Enable required extensions
create extension if not exists "uuid-ossp";
create extension if not exists "vector";

-- Sessions
create table if not exists cm_sessions (
  id text primary key,
  platform text not null,
  title text,
  messages jsonb not null default '[]',
  message_count integer default 0,
  user_message_count integer default 0,
  assistant_message_count integer default 0,
  captured_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Migration history
create table if not exists cm_migrations (
  id uuid primary key default uuid_generate_v4(),
  session_id text references cm_sessions(id),
  source_platform text,
  target_platform text,
  tier integer,
  template_id text,
  compression_ratio float,
  migrated_at timestamptz default now()
);

-- Super Memory: context graph nodes
create table if not exists cm_nodes (
  id text primary key,
  type text not null,
  label text not null,
  content text,
  embedding vector(384),
  metadata jsonb default '{}',
  tags text[] default '{}',
  importance float default 0.5,
  source text not null,
  session_id text references cm_sessions(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Super Memory: context graph edges
create table if not exists cm_edges (
  id text primary key,
  source_id text references cm_nodes(id) on delete cascade,
  target_id text references cm_nodes(id) on delete cascade,
  type text not null,
  weight float default 0.5,
  reason text,
  auto boolean default true,
  created_at timestamptz default now()
);

-- Super Memory: GitHub repos indexed
create table if not exists cm_github_repos (
  id text primary key,
  owner text not null,
  repo text not null,
  branch text default 'main',
  last_indexed_at timestamptz,
  file_count integer default 0,
  created_at timestamptz default now()
);

-- Super Memory: IDE snapshots
create table if not exists cm_ide_snapshots (
  id text primary key,
  workspace_name text,
  active_file text,
  open_files text[],
  git_branch text,
  git_diff_summary text,
  diagnostics jsonb default '[]',
  captured_at timestamptz default now()
);

-- Prompt templates (user's personal ones, mirrored from extension)
create table if not exists cm_prompt_templates (
  id text primary key,
  name text not null,
  description text,
  content text not null,
  icon text default '⚙️',
  tags text[] default '{}',
  target_platforms text[] default '{all}',
  is_default boolean default false,
  usage_count integer default 0,
  last_used_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Performance indexes
create index if not exists cm_sessions_platform_idx on cm_sessions(platform);
create index if not exists cm_sessions_updated_idx  on cm_sessions(updated_at desc);
create index if not exists cm_nodes_type_idx        on cm_nodes(type);
create index if not exists cm_nodes_source_idx      on cm_nodes(source);
create index if not exists cm_edges_source_idx      on cm_edges(source_id);
create index if not exists cm_edges_target_idx      on cm_edges(target_id);

-- Realtime (for web app live updates)
alter publication supabase_realtime add table cm_sessions;
alter publication supabase_realtime add table cm_nodes;
