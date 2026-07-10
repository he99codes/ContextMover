-- ContextMover — Migrations table schema (ALTER version for existing table)
-- The migrations table already exists with: id, user_id, session_id, source_platform, target_platform, migrated_at
-- This script adds the missing columns for admin analytics. Safe to run multiple times.

alter table migrations add column if not exists tier smallint;
alter table migrations add column if not exists message_count integer default 0;
alter table migrations add column if not exists char_count integer default 0;

create index if not exists migrations_migrated_at_idx on migrations(migrated_at desc);
create index if not exists migrations_user_idx on migrations(user_id);
create index if not exists migrations_target_idx on migrations(target_platform);
create index if not exists migrations_tier_idx on migrations(tier);

alter table migrations enable row level security;
drop policy if exists "migrations: owner read" on migrations;
create policy "migrations: owner read" on migrations for select using (auth.uid() = user_id);
