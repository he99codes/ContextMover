-- Migration: add drive_email column to users table
-- Stores the Google Drive account email for pro license binding.
alter table public.users add column if not exists drive_email text;
create index if not exists users_drive_email_idx on public.users(drive_email);
