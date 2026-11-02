-- Homebase — "Later": a to-do stays out of the way (To-dos page, Today) until its start date.
alter table public.items add column if not exists start_date date;
