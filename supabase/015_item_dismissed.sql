-- Homebase — dismissed items are hidden, not deleted, so the email reader remembers them
-- and doesn't add the same thing again when the next reminder email arrives.
alter table public.items add column if not exists dismissed boolean not null default false;
