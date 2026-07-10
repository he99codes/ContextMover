create table if not exists public.contact_submissions (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'contact',
  name text, email text, subject text, message text, rating integer,
  created_at timestamptz not null default now()
);
create index if not exists contact_submissions_created_at_idx on public.contact_submissions(created_at desc);
alter table public.contact_submissions enable row level security;
drop policy if exists "cs_anon_ins" on public.contact_submissions;
create policy "cs_anon_ins" on public.contact_submissions for insert to anon, authenticated with check (true);
