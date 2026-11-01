-- Homebase — who a to-do is for (any family member, including kids without a login),
-- separate from who's doing it (assigned_to, which needs a login).
alter table public.items add column if not exists person_id uuid references public.people(id) on delete set null;

-- Email items used to say who they were for with a "Piper: " title prefix; move that into person_id.
update public.items i set person_id = p.id, title = substr(i.title, length(p.name) + 3)
  from public.people p
  where p.household_id = i.household_id and i.person_id is null
    and i.title ilike p.name || ': %';
