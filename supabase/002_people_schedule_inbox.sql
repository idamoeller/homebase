-- Homebase — phase 1, part 2: people (incl. kids without logins), your schedule,
-- and the "Tell Mom" inbox. Run once in the Supabase SQL editor after schema.sql.

-- ── People: everyone in the family, with or without a login ───────────────

create table if not exists public.people (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name         text not null,
  kind         text not null default 'kid' check (kind in ('adult', 'kid', 'helper')),
  user_id      uuid references auth.users(id) on delete set null,
  sort         int not null default 0,
  created_at   timestamptz not null default now()
);

alter table public.people enable row level security;

drop policy if exists people_all on public.people;
create policy people_all on public.people
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

revoke all on public.people from anon, authenticated;
grant select, insert, update, delete on public.people to authenticated;

-- ── Schedule: travel, office (drive / boat), WFH — shared with the household ─

create table if not exists public.schedule (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  start_date   date not null,
  end_date     date not null,
  kind         text not null check (kind in ('travel', 'office_drive', 'office_boat', 'wfh', 'off')),
  place        text,
  note         text,
  created_at   timestamptz not null default now(),
  check (end_date >= start_date)
);

create index if not exists schedule_range_idx on public.schedule (household_id, start_date, end_date);

alter table public.schedule enable row level security;

drop policy if exists schedule_select on public.schedule;
create policy schedule_select on public.schedule
  for select to authenticated using (public.is_member(household_id));

drop policy if exists schedule_write on public.schedule;
create policy schedule_write on public.schedule
  for all to authenticated
  using (public.is_member(household_id) and user_id = auth.uid())
  with check (public.is_member(household_id) and user_id = auth.uid());

revoke all on public.schedule from anon, authenticated;
grant select, insert, update, delete on public.schedule to authenticated;

-- ── Tell Mom inbox ────────────────────────────────────────────────────────
-- Requests land as personal items for the household owner, flagged inbox=true,
-- until she triages them.

alter table public.items add column if not exists inbox     boolean not null default false;
alter table public.items add column if not exists from_name text;

alter table public.households add column if not exists request_token text not null unique
  default replace(gen_random_uuid()::text, '-', '');

grant update (request_token) on public.households to authenticated;

-- Names for the request page's "who's asking?" buttons (everyone except the owner,
-- since requests go to her). Needs the secret link token.
create or replace function public.request_page(p_token text)
returns table (household_name text, names text[])
language sql stable security definer set search_path = public as $$
  select h.name,
         coalesce(array_agg(p.name order by p.sort, p.created_at)
                  filter (where p.id is not null), '{}')
  from public.households h
  left join public.people p on p.household_id = h.id
    and p.user_id is distinct from (
      select m.user_id from public.members m where m.household_id = h.id and m.role = 'owner' limit 1)
  where h.request_token = p_token
  group by h.id
$$;

create or replace function public.submit_request(p_token text, p_from text, p_text text)
returns boolean language plpgsql security definer set search_path = public as $$
declare hid uuid; owner_id uuid;
begin
  if coalesce(trim(p_text), '') = '' then raise exception 'empty request'; end if;
  if length(p_text) > 1000 or length(coalesce(p_from, '')) > 60 then raise exception 'too long'; end if;
  select h.id, m.user_id into hid, owner_id
    from public.households h
    join public.members m on m.household_id = h.id and m.role = 'owner'
    where h.request_token = p_token
    limit 1;
  if hid is null then raise exception 'link not found'; end if;
  -- simple flood guard
  if (select count(*) from public.items
        where household_id = hid and inbox and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'too many requests, try again later';
  end if;
  insert into public.items (household_id, created_by, assigned_to, visibility, title, inbox, from_name, source)
    values (hid, owner_id, owner_id, 'personal', trim(p_text), true, nullif(trim(p_from), ''), 'request_page');
  return true;
end $$;

revoke execute on function public.request_page(text), public.submit_request(text, text, text) from public;
grant execute on function public.request_page(text), public.submit_request(text, text, text) to anon, authenticated;
