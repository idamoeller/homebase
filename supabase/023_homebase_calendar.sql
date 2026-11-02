-- Homebase — a built-in "Homebase" calendar: events added right in the app (not synced from a feed).
-- Each household gets one connection of kind 'homebase' (made on first use); its events are added,
-- changed and removed through the RPCs below, since people can't write to events directly.

alter table public.connections drop constraint if exists connections_kind_check;
alter table public.connections add constraint connections_kind_check check (kind in ('ics', 'gmail', 'file', 'homebase'));

-- The household's Homebase calendar, made the first time someone adds an event.
create or replace function public.homebase_calendar(p_household uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if not public.is_member(p_household) then raise exception 'not a member'; end if;
  select id into cid from public.connections where household_id = p_household and kind = 'homebase' limit 1;
  if cid is null then
    insert into public.connections (household_id, created_by, kind, name, visibility, enabled)
    values (p_household, auth.uid(), 'homebase', 'Homebase', 'family', true) returning id into cid;
  end if;
  return cid;
end $$;

-- Add (p_id null) or change an event on the Homebase calendar. Times are home time (America/New_York);
-- no start time = all day. Returns the event row.
create or replace function public.save_homebase_event(
  p_household uuid, p_id uuid, p_title text, p_date date, p_start time, p_end time,
  p_location text, p_notes text, p_person uuid, p_visibility text
) returns public.events language plpgsql security definer set search_path = public as $$
declare cid uuid; r public.events; s timestamptz; e timestamptz;
begin
  cid := public.homebase_calendar(p_household);
  if coalesce(trim(p_title), '') = '' or p_date is null then raise exception 'needs a title and a date'; end if;
  if p_person is not null and not exists (select 1 from public.people where id = p_person and household_id = p_household) then
    raise exception 'unknown person';
  end if;
  if p_start is not null then
    s := (p_date + p_start) at time zone 'America/New_York';
    e := case when p_end is not null and p_end > p_start then (p_date + p_end) at time zone 'America/New_York' else s + interval '1 hour' end;
  end if;
  if p_id is null then
    insert into public.events (household_id, connection_id, created_by, person_id, visibility, uid, title, location, description,
      all_day, starts_at, ends_at, start_date, end_date)
    values (p_household, cid, auth.uid(), p_person, case when p_visibility = 'personal' then 'personal' else 'family' end,
      'hb-' || gen_random_uuid(), left(trim(p_title), 200), nullif(trim(p_location), ''), nullif(trim(p_notes), ''),
      p_start is null, s, e, p_date, p_date)
    returning * into r;
  else
    update public.events set person_id = p_person, title = left(trim(p_title), 200), location = nullif(trim(p_location), ''),
      description = nullif(trim(p_notes), ''), all_day = p_start is null, starts_at = s, ends_at = e, start_date = p_date, end_date = p_date,
      visibility = case when p_visibility = 'personal' then 'personal' else 'family' end
    where id = p_id and connection_id = cid and (visibility = 'family' or created_by = auth.uid())
    returning * into r;
    if r.id is null then raise exception 'event not found'; end if;
  end if;
  return r;
end $$;

create or replace function public.delete_homebase_event(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.events e using public.connections c
  where e.id = p_id and c.id = e.connection_id and c.kind = 'homebase' and public.is_member(e.household_id)
    and (e.visibility = 'family' or e.created_by = auth.uid());
end $$;

revoke execute on function public.homebase_calendar(uuid) from public, anon;
revoke execute on function public.save_homebase_event(uuid, uuid, text, date, time, time, text, text, uuid, text) from public, anon;
revoke execute on function public.delete_homebase_event(uuid) from public, anon;
grant execute on function public.homebase_calendar(uuid) to authenticated;
grant execute on function public.save_homebase_event(uuid, uuid, text, date, time, time, text, text, uuid, text) to authenticated;
grant execute on function public.delete_homebase_event(uuid) to authenticated;
