-- Color for "Whole family" calendars and events.
alter table public.households add column if not exists family_color text;
alter table public.households drop constraint if exists households_family_color_check;
alter table public.households add constraint households_family_color_check check (family_color is null or family_color ~ '^#[0-9A-Fa-f]{6}$');
grant update (family_color) on public.households to authenticated;
