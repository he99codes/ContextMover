-- Pro Seats: One Master Drive, 10 Seats licensing model
alter table public.subscriptions
  add column if not exists master_drive_email text;

create table if not exists public.pro_seats (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  seat_email text not null,
  created_at timestamptz default now(),
  unique (seat_email)
);
create index if not exists pro_seats_owner_idx on public.pro_seats(owner_user_id);

create table if not exists public.pro_violations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete cascade,
  offending_email text,
  attempted_drive_email text,
  master_drive_email text,
  created_at timestamptz default now()
);

alter table public.pro_seats enable row level security;
alter table public.pro_violations enable row level security;

drop policy if exists "owner reads seats" on public.pro_seats;
create policy "owner reads seats" on public.pro_seats
  for select using (auth.uid() = owner_user_id);

drop policy if exists "owner reads violations" on public.pro_violations;
create policy "owner reads violations" on public.pro_violations
  for select using (auth.uid() = owner_user_id);
