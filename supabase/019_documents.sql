-- Homebase — Documents: saved links and uploaded files (calendars, forms, schedules, handbooks).
create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  created_by   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('link', 'file')),
  title        text not null check (length(title) between 1 and 200),
  url          text check (url is null or length(url) <= 2000),
  file_path    text,           -- storage path in the "documents" bucket: <household_id>/<uuid>/<file name>
  file_type    text,
  file_size    bigint,
  person_id    uuid references public.people(id) on delete set null,
  category     text check (category is null or length(category) <= 60),
  notes        text check (notes is null or length(notes) <= 2000),
  visibility   text not null default 'family' check (visibility in ('personal', 'family')),
  created_at   timestamptz not null default now(),
  check ((kind = 'link' and url is not null) or (kind = 'file' and file_path is not null))
);
create index if not exists documents_household_idx on public.documents (household_id, created_at desc);

alter table public.documents enable row level security;
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
  using (public.is_member(household_id) and (visibility = 'family' or created_by = auth.uid()));
drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated
  with check (public.is_member(household_id) and created_by = auth.uid());
drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents for update to authenticated
  using (public.is_member(household_id) and (visibility = 'family' or created_by = auth.uid()))
  with check (public.is_member(household_id) and (visibility = 'family' or created_by = auth.uid()));
drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents for delete to authenticated
  using (public.is_member(household_id) and (visibility = 'family' or created_by = auth.uid()));
revoke all on public.documents from anon, authenticated;
grant select, insert, update, delete on public.documents to authenticated;
grant select on public.documents to service_role;

-- Private bucket; each household only touches its own folder. Files open through short-lived signed links.
insert into storage.buckets (id, name, public, file_size_limit)
  values ('documents', 'documents', false, 26214400) -- 25 MB
  on conflict (id) do nothing;

drop policy if exists documents_files_read on storage.objects;
create policy documents_files_read on storage.objects for select to authenticated
  using (bucket_id = 'documents' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists documents_files_write on storage.objects;
create policy documents_files_write on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists documents_files_delete on storage.objects;
create policy documents_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.is_member(((storage.foldername(name))[1])::uuid));

-- A few links to start with.
insert into public.documents (household_id, created_by, kind, title, url, person_id, category)
select h.id, m.user_id, 'link', d.title, d.url, p.id, 'Schedules'
from public.households h
join public.members m on m.household_id = h.id and m.role = 'owner'
cross join (values
  ('RSM Milton 2026–27 calendar', 'https://static.russianschool.com/Calendar/Milton_2026.html', 'Owen'),
  ('RSM Online Middle (Grades 6–7) 2026–27 calendar', 'https://static.russianschool.com/Calendar/OnlineMiddle(Grades6-7)_2026.html', 'Piper')
) as d(title, url, who)
left join public.people p on p.household_id = h.id and p.name = d.who
where not exists (select 1 from public.documents x where x.household_id = h.id and x.url = d.url);
