-- Homebase — the family dinner plan: one note per day (a meal, or a pasted recipe link), shared with the family.
create table if not exists public.meals (
  household_id uuid not null references public.households(id) on delete cascade,
  day          date not null,
  text         text not null check (length(text) between 1 and 1000),
  updated_by   uuid default auth.uid() references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (household_id, day)
);
alter table public.meals enable row level security;
drop policy if exists meals_all on public.meals;
create policy meals_all on public.meals for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));
revoke all on public.meals from anon, authenticated;
grant select, insert, update, delete on public.meals to authenticated;
grant select on public.meals to service_role;
