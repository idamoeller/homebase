-- Homebase — arrival time, uniform and drive time for calendar events.
-- The sync reads "Arrival Time: 5:30 PM" / "Arrival: 15 Mins Early" / "Uniform: Grey" from each event's
-- title and details, and works out the drive from home to each place (cached in places).
alter table public.events add column if not exists description text;
alter table public.events add column if not exists arrive_at  timestamptz;
alter table public.events add column if not exists uniform    text;
alter table public.events add column if not exists drive_min  int;

-- Your own corrections, kept across syncs.
alter table public.event_notes add column if not exists arrive_at timestamptz;
alter table public.event_notes add column if not exists uniform   text check (uniform is null or length(uniform) <= 80);

-- Where home is, for drive times (a town is fine; a street address is more exact).
alter table public.households add column if not exists home_address text;

-- Looked-up places and the drive from home (filled by the sync; not read by the app directly).
create table if not exists public.places (
  household_id uuid not null references public.households(id) on delete cascade,
  query        text not null,
  home         text not null,
  lat          double precision,
  lon          double precision,
  drive_min    int,
  found        boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (household_id, query, home)
);
alter table public.places enable row level security;
revoke all on public.places from anon, authenticated;
grant select, insert, update, delete on public.places to service_role;
