-- ContextForge — DROP session data tables from OUR Supabase
-- Run this manually in the ContextForge Supabase SQL Editor.
-- After running, ContextForge servers will NEVER store session content.
--
-- SAFE TO RUN: Sessions still live in local IndexedDB in every user's browser.
-- Users who want cross-device sync connect their own personal Supabase vault.

-- Drop session-related tables (ContextForge no longer stores these)
drop table if exists public.migrations cascade;
drop table if exists public.sessions cascade;

-- Keep these tables (ContextForge legitimately stores these):
-- auth.users          — managed by Supabase Auth
-- public.subscriptions     — payment status only, no content
-- public.prompt_templates  — public marketplace templates, no personal content
-- public.prompt_assignments — template→session references, no content
-- public.custom_agents     — agent config, no conversation content
