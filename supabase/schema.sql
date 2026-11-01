-- Homebase — phase 1 schema: households, members, items (tasks + requests).
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent where possible).

-- ── Tables ────────────────────────────────────────────────────────────────

create table if not exists public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  invite_code text not null unique
              default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_at  timestamptz not null default now()
);

create table if not exists public.members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  role         text not null default 'member' check (role in ('owner', 'member')),
  ntfy_topic   text,
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id),
  unique (user_id)  -- one household per person
);

-- An "item" is a task, or a request ("need you for 5:30 pickup").
-- visibility: 'personal' = only the creator sees it; 'family' = everyone in the household.
create table if not exists public.items (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  created_by      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  assigned_to     uuid references auth.users(id) on delete set null,
  visibility      text not null default 'personal' check (visibility in ('personal', 'family')),
  kind            text not null default 'task' check (kind in ('task', 'request')),
  title           text not null,
  notes           text,
  due_date        date,
  due_time        time,
  response        text check (response in ('accepted', 'declined')),
  done            boolean not null default false,
  done_at         timestamptz,
  source          text not null default 'manual',
  source_ref      text,
  onething_sent_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- a personal item can only be assigned to its creator
  check (visibility = 'family' or assigned_to is null or assigned_to = created_by)
);

create index if not exists items_household_idx on public.items (household_id, done, due_date);
create index if not exists items_assigned_idx  on public.items (assigned_to) where not done;

-- ── Helpers (security definer so RLS policies don't recurse) ──────────────

create or replace function public.my_household()
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.members where user_id = auth.uid()
$$;

create or replace function public.is_member(hid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where household_id = hid and user_id = auth.uid())
$$;

-- Keep items honest: creator can't be changed, assignee must be in the household,
-- done_at / updated_at maintained automatically.
create or replace function public.items_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.created_by   := old.created_by;
    new.household_id := old.household_id;
  end if;
  if new.assigned_to is not null and not exists (
    select 1 from public.members where household_id = new.household_id and user_id = new.assigned_to
  ) then
    raise exception 'assignee is not in this household';
  end if;
  if new.done and (tg_op = 'INSERT' or not old.done) then new.done_at := now(); end if;
  if not new.done then new.done_at := null; end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists items_guard on public.items;
create trigger items_guard before insert or update on public.items
  for each row execute function public.items_guard();

-- ── Household setup RPCs ──────────────────────────────────────────────────

create or replace function public.create_household(p_name text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'already in a household';
  end if;
  insert into public.households (name) values (p_name) returning id into hid;
  insert into public.members (household_id, user_id, display_name, role)
    values (hid, auth.uid(), p_display_name, 'owner');
  return hid;
end $$;

create or replace function public.join_household(p_code text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'already in a household';
  end if;
  select id into hid from public.households where invite_code = upper(trim(p_code));
  if hid is null then raise exception 'invite code not found'; end if;
  insert into public.members (household_id, user_id, display_name)
    values (hid, auth.uid(), p_display_name);
  return hid;
end $$;

-- ── Row level security ────────────────────────────────────────────────────

alter table public.households enable row level security;
alter table public.members    enable row level security;
alter table public.items      enable row level security;

drop policy if exists households_select on public.households;
create policy households_select on public.households
  for select to authenticated using (public.is_member(id));

drop policy if exists households_update on public.households;
create policy households_update on public.households
  for update to authenticated using (public.is_member(id)) with check (public.is_member(id));

drop policy if exists members_select on public.members;
create policy members_select on public.members
  for select to authenticated using (public.is_member(household_id));

drop policy if exists members_update_self on public.members;
create policy members_update_self on public.members
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- See an item if you're in the household AND it's family, or it's yours.
drop policy if exists items_select on public.items;
create policy items_select on public.items
  for select to authenticated
  using (public.is_member(household_id) and (visibility = 'family' or created_by = auth.uid()));

drop policy if exists items_insert on public.items;
create policy items_insert on public.items
  for insert to authenticated
  with check (public.is_member(household_id) and created_by = auth.uid());

drop policy if exists items_update on public.items;
create policy items_update on public.items
  for update to authenticated
  using (public.is_member(household_id) and (visibility = 'family' or created_by = auth.uid()))
  with check (public.is_member(household_id) and (visibility = 'family' or created_by = auth.uid()));

drop policy if exists items_delete on public.items;
create policy items_delete on public.items
  for delete to authenticated
  using (public.is_member(household_id) and created_by = auth.uid());

-- ── Grants: signed-in users only, nothing for anonymous visitors ──────────

revoke all on public.households, public.members, public.items from anon, authenticated;
grant select, update (name)          on public.households to authenticated;
grant select, update (display_name, ntfy_topic) on public.members to authenticated;
grant select, insert, update, delete on public.items      to authenticated;

revoke execute on function public.create_household(text, text), public.join_household(text, text),
  public.my_household(), public.is_member(uuid) from public, anon;
grant execute on function public.create_household(text, text), public.join_household(text, text),
  public.my_household(), public.is_member(uuid) to authenticated;
