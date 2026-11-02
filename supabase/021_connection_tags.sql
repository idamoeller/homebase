-- Homebase — tag events from a shared team calendar to the right kid by a word in the title
-- (Seacoast: "… South Shore - Boys - U10 …" is Owen, "… Mass Elite - Girls - U13 …" is Piper).
create table if not exists public.connection_tags (
  connection_id uuid not null references public.connections(id) on delete cascade,
  keyword       text not null check (length(keyword) between 2 and 60),
  person_id     uuid not null references public.people(id) on delete cascade,
  primary key (connection_id, keyword)
);
alter table public.connection_tags enable row level security;
drop policy if exists connection_tags_all on public.connection_tags;
create policy connection_tags_all on public.connection_tags for all to authenticated
  using (exists (select 1 from public.connections c where c.id = connection_id and public.is_member(c.household_id)))
  with check (exists (select 1 from public.connections c where c.id = connection_id and public.is_member(c.household_id)));
revoke all on public.connection_tags from anon, authenticated;
grant select, insert, update, delete on public.connection_tags to authenticated;

-- Initial ("O RSM", "P piano") first, then the calendar's keywords; only tag when exactly one kid matches.
create or replace function public.events_tag_initial()
returns trigger language plpgsql security definer set search_path = public as $$
declare ini text; pid uuid; n int;
begin
  if new.person_id is null and new.title ~ '^[A-Za-z][ :]' and new.title !~* '^[a-z]\s*(&|/|\+|and)\s*[a-z]\M' then
    ini := upper(left(new.title, 1));
    select count(*), min(id::text)::uuid into n, pid from public.people
      where household_id = new.household_id and kind = 'kid' and upper(left(name, 1)) = ini;
    if n = 1 then new.person_id := pid; end if;
  end if;
  if new.person_id is null then
    select count(distinct person_id), min(person_id::text)::uuid into n, pid from public.connection_tags
      where connection_id = new.connection_id and new.title ~* ('\m' || regexp_replace(keyword, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g') || '\M');
    if n = 1 then new.person_id := pid; end if;
  end if;
  return new;
end $$;
revoke execute on function public.events_tag_initial() from public, anon, authenticated;

insert into public.connection_tags (connection_id, keyword, person_id)
select c.id, k.keyword, p.id from public.connections c
join (values ('Boys', 'Owen'), ('Girls', 'Piper'), ('Mass Elite', 'Piper')) as k(keyword, who) on true
join public.people p on p.household_id = c.household_id and p.name = k.who
where c.name = 'Seacoast'
on conflict do nothing;

-- Tag what's already synced.
update public.events e set person_id = t.person_id
from (select e2.id, min(ct.person_id::text)::uuid person_id
      from public.events e2 join public.connection_tags ct on ct.connection_id = e2.connection_id
      where e2.person_id is null and e2.title ~* ('\m' || regexp_replace(ct.keyword, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g') || '\M')
      group by e2.id having count(distinct ct.person_id) = 1) t
where e.id = t.id;
