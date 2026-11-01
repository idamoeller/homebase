-- FYI highlights from school and activity newsletters, for the "School news this week" card.
create table if not exists public.school_news (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  connection_id uuid references public.connections(id) on delete cascade,
  message_id   text not null,
  source       text not null,
  person       text,
  subject      text,
  bullets      jsonb not null default '[]'::jsonb,
  link         text,
  email_date   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (household_id, message_id)
);
create index if not exists school_news_recent_idx on public.school_news (household_id, email_date desc);

alter table public.school_news enable row level security;
drop policy if exists school_news_select on public.school_news;
create policy school_news_select on public.school_news
  for select to authenticated using (public.is_member(household_id));
revoke all on public.school_news from anon, authenticated;
grant select on public.school_news to authenticated;
grant select, insert on public.school_news to service_role;
