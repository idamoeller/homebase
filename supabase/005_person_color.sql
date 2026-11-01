-- Each person can pick their own color (hex). Null = the default palette color for their place in the list.
alter table public.people add column if not exists color text;
alter table public.people drop constraint if exists people_color_check;
alter table public.people add constraint people_color_check check (color is null or color ~ '^#[0-9A-Fa-f]{6}$');
