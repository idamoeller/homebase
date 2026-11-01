-- Homebase — Connections (calendar links now, Gmail next) and the events synced from them.

create table if not exists public.connections (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households(id) on delete cascade,
  created_by     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind           text not null default 'ics' check (kind in ('ics', 'gmail')),
  name           text not null,
  url            text,
  person_id      uuid references public.people(id) on delete set null,
  visibility     text not null default 'family' check (visibility in ('personal', 'family')),
  enabled        boolean not null default true,
  last_synced_at timestamptz,
  last_error     text,
  event_count    int,
  created_at     timestamptz not null default now()
);

alter table public.connections enable row level security;

drop policy if exists connections_select on public.connections;
create policy connections_select on public.connections
  for select to authenticated
  using (public.is_member(household_id) and (visibility = 'family' or created_by = auth.uid()));

drop policy if exists connections_insert on public.connections;
create policy connections_insert on public.connections
  for insert to authenticated
  with check (public.is_member(household_id) and created_by = auth.uid());

drop policy if exists connections_update on public.connections;
create policy connections_update on public.connections
  for update to authenticated
  using (public.is_member(household_id) and created_by = auth.uid())
  with check (public.is_member(household_id) and created_by = auth.uid());

drop policy if exists connections_delete on public.connections;
create policy connections_delete on public.connections
  for delete to authenticated
  using (public.is_member(household_id) and created_by = auth.uid());

revoke all on public.connections from anon, authenticated;
grant select, delete on public.connections to authenticated;
grant insert (household_id, kind, name, url, person_id, visibility, enabled) on public.connections to authenticated;
grant update (name, url, person_id, visibility, enabled) on public.connections to authenticated;

-- Events are written only by the sync function (service role); people just read them.
create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  connection_id uuid not null references public.connections(id) on delete cascade,
  created_by    uuid not null references auth.users(id) on delete cascade,
  person_id     uuid references public.people(id) on delete set null,
  visibility    text not null check (visibility in ('personal', 'family')),
  uid           text,
  title         text not null,
  location      text,
  all_day       boolean not null default false,
  starts_at     timestamptz,
  ends_at       timestamptz,
  start_date    date not null,
  end_date      date not null
);

create index if not exists events_range_idx on public.events (household_id, start_date, end_date);
create index if not exists events_conn_idx on public.events (connection_id);

alter table public.events enable row level security;

drop policy if exists events_select on public.events;
create policy events_select on public.events
  for select to authenticated
  using (public.is_member(household_id) and (visibility = 'family' or created_by = auth.uid()));

revoke all on public.events from anon, authenticated;
grant select on public.events to authenticated;

-- Shared secret so the 30-minute cron job can ask the sync function to run.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.app_secrets (name text primary key, value text not null);
insert into private.app_secrets (name, value)
  values ('cron', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
  on conflict (name) do nothing;

create or replace function public.cron_secret_ok(p text)
returns boolean language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from private.app_secrets where name = 'cron' and value = p)
$$;
revoke execute on function public.cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.cron_secret_ok(text) to service_role;

create extension if not exists pg_net;
create extension if not exists pg_cron;
