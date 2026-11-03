-- Who's where: who an entry is for (anyone in the family, one or more people).
-- Empty means whoever added it.
alter table public.schedule add column if not exists person_ids uuid[] not null default '{}';
update public.schedule s set person_ids = array[p.id] from public.people p
  where p.household_id = s.household_id and p.user_id = s.user_id and s.person_ids = '{}';
