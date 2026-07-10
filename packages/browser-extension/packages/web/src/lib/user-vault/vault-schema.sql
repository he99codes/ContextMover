-- ============================================================
-- ContextMover Personal Vault — Schema Migration
-- ============================================================
-- Run this in: Supabase Dashboard → your project → SQL Editor
-- One-time setup. Safe to re-run (uses IF NOT EXISTS).
-- ============================================================

create extension if not exists "uuid-ossp";

-- Sessions captured by the browser extension
create table if not exists cm_sessions (
  id                      text        primary key,
  platform                text        not null,
  title                   text,
  messages                jsonb       not null default '[]',
  message_count           integer     default 0,
  user_message_count      integer     default 0,
  assistant_message_count integer     default 0,
  captured_at             timestamptz default now(),
  updated_at              timestamptz default now()
);

-- Migration history (source → target platform)
create table if not exists cm_migrations (
  id                uuid        primary key default uuid_generate_v4(),
  session_id        text        references cm_sessions(id),
  source_platform   text,
  target_platform   text,
  tier              integer,
  compression_ratio float,
  migrated_at       timestamptz default now()
);

-- Knowledge graph nodes (Super Memory)
create table if not exists cm_nodes (
  id          text        primary key,
  type        text        not null,
  label       text        not null,
  content     text,
  metadata    jsonb       default '{}',
  importance  float       default 0.5,
  source      text        not null,
  session_id  text        references cm_sessions(id),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Knowledge graph edges (Super Memory)
create table if not exists cm_edges (
  id         text        primary key,
  source_id  text        references cm_nodes(id) on delete cascade,
  target_id  text        references cm_nodes(id) on delete cascade,
  type       text        not null,
  weight     float       default 0.5,
  created_at timestamptz default now()
);

-- IDE snapshots (Project Files feature)
create table if not exists cm_ide_snapshots (
  id         text        primary key,
  session_id text        references cm_sessions(id),
  content    jsonb       default '{}',
  created_at timestamptz default now()
);

-- GitHub repo context (Project Files feature)
create table if not exists cm_github_repos (
  id         text        primary key,
  session_id text        references cm_sessions(id),
  owner      text,
  repo       text,
  content    jsonb       default '{}',
  created_at timestamptz default now()
);

-- Prompt templates stored in vault
create table if not exists cm_prompt_templates (
  id         text        primary key,
  title      text        not null,
  content    text        not null,
  metadata   jsonb       default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Index for session list ordering
create index if not exists cm_sessions_updated_idx
  on cm_sessions (updated_at desc);

-- Enable realtime so the dashboard reflects changes live
alter publication supabase_realtime add table cm_sessions;
