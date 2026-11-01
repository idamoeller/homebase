-- Homebase — your own details on synced calendar events: who's driving, who's picking up, a note,
-- a clearer title, or "hide this". Synced events are rebuilt on every sync, so details are keyed
-- by the calendar and the event's stable id (uid), not the events row.
create table if not exists public.event_notes (
  household_id  uuid not null references public.households(id) on delete cascade,
  connection_id uuid not null references public.connections(id) on delete cascade,
  uid           text not null,
  title         text check (title is null or length(title) <= 200),
  note          text check (note is null or length(note) <= 2000),
  drop_off      uuid references public.people(id) on delete set null,
  pick_up       uuid references public.people(id) on delete set null,
  hidden        boolean not null default false,
  updated_by    uuid default auth.uid() references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now(),
  primary key (connection_id, uid)
);

alter table public.event_notes enable row level security;
drop policy if exists event_notes_all on public.event_notes;
create policy event_notes_all on public.event_notes
  for all to authenticated
  -- only for calendars you can see (a personal calendar's details stay with its owner)
  using (public.is_member(household_id) and exists (select 1 from public.connections c where c.id = connection_id
    and c.household_id = event_notes.household_id and (c.visibility = 'family' or c.created_by = auth.uid())))
  with check (public.is_member(household_id) and exists (select 1 from public.connections c where c.id = connection_id
    and c.household_id = event_notes.household_id and (c.visibility = 'family' or c.created_by = auth.uid())));
revoke all on public.event_notes from anon, authenticated;
grant select, insert, update, delete on public.event_notes to authenticated;
grant select on public.event_notes to service_role;
