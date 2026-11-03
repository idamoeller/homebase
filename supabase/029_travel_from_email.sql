-- Travel itineraries from email: the Gmail reader fills in Who's where and the Homebase calendar.
-- source_ref ties a trip (and its calendar events, uid 'hb-trip-<ref>-…') to its booking, so a
-- re-sent or changed itinerary updates the same trip instead of adding another.
alter table public.schedule add column if not exists source_ref text;
create index if not exists schedule_source_ref on public.schedule (household_id, source_ref) where source_ref is not null;
grant select, insert, update on public.schedule to service_role;
grant insert, update, delete on public.event_notes to service_role;
grant insert on public.connections to service_role;
grant select on public.connections to service_role;
