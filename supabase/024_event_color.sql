-- Homebase — a color for one event (your own pick, over the person/family color).
alter table public.event_notes add column if not exists color text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$');
