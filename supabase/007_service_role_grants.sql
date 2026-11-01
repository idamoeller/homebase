-- The sync function (service role) reads connections and members and writes events.
grant select, update on public.connections to service_role;
grant select, insert, delete on public.events to service_role;
grant select on public.members to service_role;
