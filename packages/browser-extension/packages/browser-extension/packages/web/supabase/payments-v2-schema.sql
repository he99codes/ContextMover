-- ──────────────────────────────────────────────────────────────────────────
-- ContextMover — Payment Infrastructure v2
-- Adds: subscriptions, usage_tracking, payment_events
-- Compatible with the legacy users.is_pro / usage tables (kept untouched).
-- Run this in the Supabase SQL Editor.
-- ──────────────────────────────────────────────────────────────────────────

-- ── Subscriptions ──────────────────────────────────────────────────────────
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  plan text not null default 'free',
    -- 'free' | 'pro' | 'team'
  status text not null default 'active',
    -- 'active' | 'cancelled' | 'past_due' | 'trialing'
  gateway text,
    -- 'razorpay' | 'stripe' | null (free)
  gateway_customer_id text,
  gateway_subscription_id text,
  currency text default 'usd',
    -- 'inr' or 'usd'
  amount integer default 0,
    -- amount in smallest unit (paise or cents)
  interval text default 'month',
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_end timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id)
);

create index if not exists subscriptions_user_id_idx on subscriptions(user_id);
create index if not exists subscriptions_status_idx on subscriptions(status);

-- ── Usage tracking ─────────────────────────────────────────────────────────
create table if not exists usage_tracking (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  month text not null,
    -- format: '2026-05' (YYYY-MM)
  simple_migrations integer default 0,
  smart_migrations integer default 0,
  attention_migrations integer default 0,
  sessions_count integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, month)
);

create index if not exists usage_tracking_user_month_idx
  on usage_tracking(user_id, month);

-- ── Payment events log (audit trail) ───────────────────────────────────────
create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  gateway text not null,
  event_type text not null,
    -- 'subscription.created' | 'subscription.cancelled'
    -- | 'payment.success' | 'payment.failed' | 'subscription.renewed'
  gateway_event_id text,
  payload jsonb,
  processed_at timestamptz default now()
);

create index if not exists payment_events_user_idx on payment_events(user_id);
create index if not exists payment_events_gateway_event_idx
  on payment_events(gateway, gateway_event_id);

-- ── Row Level Security ─────────────────────────────────────────────────────
alter table subscriptions enable row level security;
alter table usage_tracking enable row level security;
alter table payment_events enable row level security;

drop policy if exists "Users read own subscription" on subscriptions;
create policy "Users read own subscription"
  on subscriptions for select
  using (auth.uid() = user_id);

drop policy if exists "Users read own usage" on usage_tracking;
create policy "Users read own usage"
  on usage_tracking for select
  using (auth.uid() = user_id);

-- Service role bypasses RLS for webhook writes (no policy needed).

-- ── Helper function: get user plan ─────────────────────────────────────────
create or replace function get_user_plan(p_user_id uuid)
returns text
language sql security definer
as $$
  select coalesce(
    (select plan from subscriptions
     where user_id = p_user_id
     and status in ('active', 'trialing')
     limit 1),
    'free'
  );
$$;

-- ── Helper function: increment usage (atomic check + bump) ─────────────────
create or replace function increment_usage(
  p_user_id uuid,
  p_type text,  -- 'simple' | 'smart' | 'attention'
  p_month text  -- '2026-05'
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_plan text;
  v_usage record;
  v_limit integer;
  v_current integer;
begin
  -- Get user plan
  v_plan := get_user_plan(p_user_id);

  -- Pro or Team = unlimited
  if v_plan = 'pro' or v_plan = 'team' then
    return jsonb_build_object(
      'allowed', true,
      'plan', v_plan,
      'unlimited', true
    );
  end if;

  -- Ensure usage row exists for this month
  insert into usage_tracking (user_id, month)
  values (p_user_id, p_month)
  on conflict (user_id, month) do nothing;

  select * into v_usage
  from usage_tracking
  where user_id = p_user_id and month = p_month;

  -- Resolve limits per type
  if p_type = 'simple' then
    v_limit := 50;
    v_current := v_usage.simple_migrations;
  elsif p_type = 'smart' then
    v_limit := 50;
    v_current := v_usage.smart_migrations;
  elsif p_type = 'attention' then
    v_limit := 10;
    v_current := v_usage.attention_migrations;
  else
    return jsonb_build_object(
      'allowed', false,
      'error', 'unknown_type',
      'type', p_type
    );
  end if;

  if v_current >= v_limit then
    return jsonb_build_object(
      'allowed', false,
      'plan', 'free',
      'limit', v_limit,
      'used', v_current,
      'type', p_type
    );
  end if;

  -- Increment counter
  if p_type = 'simple' then
    update usage_tracking
    set simple_migrations = simple_migrations + 1,
        updated_at = now()
    where user_id = p_user_id and month = p_month;
  elsif p_type = 'smart' then
    update usage_tracking
    set smart_migrations = smart_migrations + 1,
        updated_at = now()
    where user_id = p_user_id and month = p_month;
  elsif p_type = 'attention' then
    update usage_tracking
    set attention_migrations = attention_migrations + 1,
        updated_at = now()
    where user_id = p_user_id and month = p_month;
  end if;

  return jsonb_build_object(
    'allowed', true,
    'plan', 'free',
    'limit', v_limit,
    'used', v_current + 1,
    'remaining', v_limit - v_current - 1,
    'type', p_type
  );
end;
$$;

-- ── Touch updated_at trigger ───────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists subscriptions_updated_at on subscriptions;
create trigger subscriptions_updated_at
  before update on subscriptions
  for each row execute function set_updated_at();

drop trigger if exists usage_tracking_updated_at on usage_tracking;
create trigger usage_tracking_updated_at
  before update on usage_tracking
  for each row execute function set_updated_at();
