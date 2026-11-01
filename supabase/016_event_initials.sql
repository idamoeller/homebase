-- Homebase — family calendars often start a title with a kid's initial ("O RSM Milton", "P piano").
-- Tag those events to that kid when exactly one kid in the household has that initial.
create or replace function public.events_tag_initial()
returns trigger language plpgsql security definer set search_path = public as $$
declare ini text; pid uuid; n int;
begin
  -- "P & O …" / "O/P …" is about both kids, so leave it untagged.
  if new.person_id is null and new.title ~ '^[A-Za-z][ :]' and new.title !~* '^[a-z]\s*(&|/|\+|and)\s*[a-z]\M' then
    ini := upper(left(new.title, 1));
    select count(*), min(id::text)::uuid into n, pid from public.people
      where household_id = new.household_id and kind = 'kid' and upper(left(name, 1)) = ini;
    if n = 1 then new.person_id := pid; end if;
  end if;
  return new;
end $$;
revoke execute on function public.events_tag_initial() from public, anon, authenticated;

drop trigger if exists events_tag_initial on public.events;
create trigger events_tag_initial before insert on public.events
  for each row execute function public.events_tag_initial();

-- Tag what's already synced.
update public.events e set person_id = p.id
  from public.people p
  where e.person_id is null and e.title ~ '^[A-Za-z][ :]' and e.title !~* '^[a-z]\s*(&|/|\+|and)\s*[a-z]\M'
    and p.household_id = e.household_id and p.kind = 'kid' and upper(left(p.name, 1)) = upper(left(e.title, 1))
    and (select count(*) from public.people q where q.household_id = e.household_id and q.kind = 'kid'
         and upper(left(q.name, 1)) = upper(left(e.title, 1))) = 1;
