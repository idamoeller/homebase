-- Kids' details for the email reader, and the reader's access to what Homebase already knows.
alter table public.people add column if not exists about text check (about is null or length(about) <= 500);
grant update (about) on public.people to authenticated;
grant select, update on public.items to service_role;
grant select on public.events to service_role;
