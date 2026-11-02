-- Homebase — "always" drivers for a repeating event: the same calendar, title, weekday and start time
-- (team calendars list each practice separately, so this is how a weekly practice is recognized).
-- A driver set on one date (event_notes) still wins over the rule.
create table if not exists public.event_rules (
  household_id  uuid not null references public.households(id) on delete cascade,
  connection_id uuid not null references public.connections(id) on delete cascade,
  title         text not null,
  dow           int  not null check (dow between 0 and 6),   -- 0 = Sunday, home time zone
  start_time    text not null check (start_time ~ '^\d{2}:\d{2}$'),
  drop_off      uuid references public.people(id) on delete set null,
  pick_up       uuid references public.people(id) on delete set null,
  updated_by    uuid default auth.uid() references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now(),
  primary key (connection_id, title, dow, start_time)
);
alter table public.event_rules enable row level security;
drop policy if exists event_rules_all on public.event_rules;
create policy event_rules_all on public.event_rules for all to authenticated
  using (public.is_member(household_id) and exists (select 1 from public.connections c where c.id = connection_id
    and c.household_id = event_rules.household_id and (c.visibility = 'family' or c.created_by = auth.uid())))
  with check (public.is_member(household_id) and exists (select 1 from public.connections c where c.id = connection_id
    and c.household_id = event_rules.household_id and (c.visibility = 'family' or c.created_by = auth.uid())));
revoke all on public.event_rules from anon, authenticated;
grant select, insert, update, delete on public.event_rules to authenticated;
grant select on public.event_rules to service_role;
