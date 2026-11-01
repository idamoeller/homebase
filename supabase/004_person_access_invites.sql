-- Homebase — one Family list: each person is Spouse/Partner, Kid or Grandparent/Helper,
-- with either "requests" access (Tell Mom page only, no login) or "full" access
-- (their own login, joined with a personal invite code).

alter table public.people drop constraint if exists people_kind_check;
alter table public.people add constraint people_kind_check
  check (kind in ('adult', 'partner', 'kid', 'helper'));

alter table public.people add column if not exists access text not null default 'requests';
alter table public.people drop constraint if exists people_access_check;
alter table public.people add constraint people_access_check check (access in ('requests', 'full'));
alter table public.people add column if not exists invite_code text unique;

update public.people set access = 'full' where user_id is not null;

-- Join with a person's invite code: links the new login to that person's row.
create or replace function public.join_household(p_code text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare pid uuid; hid uuid; pname text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'already in a household';
  end if;
  select id, household_id, name into pid, hid, pname
    from public.people
    where invite_code = upper(trim(p_code)) and user_id is null and access = 'full';
  if pid is null then raise exception 'invite code not found'; end if;
  insert into public.members (household_id, user_id, display_name)
    values (hid, auth.uid(), coalesce(nullif(trim(p_display_name), ''), pname));
  update public.people set user_id = auth.uid(), invite_code = null where id = pid;
  return hid;
end $$;
