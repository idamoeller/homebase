-- Homebase — Gmail: a watch list that builds the Gmail search, a log of emails already read,
-- and a private key per Gmail account (only its hash is stored).

-- 'file' = a dropped-in .ics file (a one-time snapshot, not refreshed).
alter table public.connections drop constraint if exists connections_kind_check;
alter table public.connections add constraint connections_kind_check check (kind in ('ics', 'gmail', 'file'));

alter table public.connections add column if not exists token_hash text;
alter table public.connections add column if not exists emails_read int not null default 0;
alter table public.connections add column if not exists last_email_at timestamptz;

create table if not exists public.email_watch (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  kind         text not null check (kind in ('from', 'words')),
  value        text not null check (length(value) between 1 and 120),
  created_at   timestamptz not null default now(),
  unique (household_id, kind, value)
);

alter table public.email_watch enable row level security;
drop policy if exists email_watch_all on public.email_watch;
create policy email_watch_all on public.email_watch
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));
revoke all on public.email_watch from anon, authenticated;
grant select, insert, delete on public.email_watch to authenticated;

create table if not exists public.email_seen (
  connection_id uuid not null references public.connections(id) on delete cascade,
  message_id    text not null,
  items_found   int not null default 0,
  seen_at       timestamptz not null default now(),
  primary key (connection_id, message_id)
);
alter table public.email_seen enable row level security;
revoke all on public.email_seen from anon, authenticated;

-- The function (service role) reads the watch list, family names and connections, logs emails,
-- and writes suggested items into the owner's Requests inbox.
grant select on public.email_watch, public.people, public.households to service_role;
grant select, insert on public.email_seen to service_role;
grant insert on public.items to service_role;
grant select, update on public.connections to service_role;

-- Add a Gmail account: returns the key to paste into the Gmail script (shown once).
create or replace function public.create_gmail_connection(p_name text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare hid uuid; tok text; cid uuid;
begin
  select household_id into hid from public.members where user_id = auth.uid();
  if hid is null then raise exception 'not in a household'; end if;
  tok := encode(gen_random_bytes(24), 'hex');
  insert into public.connections (household_id, created_by, kind, name, visibility, token_hash)
    values (hid, auth.uid(), 'gmail', left(trim(p_name), 120), 'personal', encode(digest(tok, 'sha256'), 'hex'))
    returning id into cid;
  return json_build_object('id', cid, 'token', tok);
end $$;

-- Make a new key for a Gmail account (the old one stops working).
create or replace function public.rotate_gmail_key(p_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare tok text;
begin
  tok := encode(gen_random_bytes(24), 'hex');
  update public.connections set token_hash = encode(digest(tok, 'sha256'), 'hex')
    where id = p_id and kind = 'gmail' and created_by = auth.uid();
  if not found then raise exception 'not your Gmail connection'; end if;
  return tok;
end $$;

revoke execute on function public.create_gmail_connection(text), public.rotate_gmail_key(uuid) from public, anon;
grant execute on function public.create_gmail_connection(text), public.rotate_gmail_key(uuid) to authenticated;

-- Starting watch list for the Moellers' schools and activities.
insert into public.email_watch (household_id, kind, value)
select h.id, w.kind, w.value from public.households h
cross join (values
  ('from','mpsd.org'), ('from','teamsnap.com'), ('from','playmetrics.com'), ('from','playerfirsttech.com'), ('from','scouting.org'),
  ('words','Furnace Brook'), ('words','FBMS'), ('words','Marshfield Public Schools'), ('words','Marshfield schools'),
  ('words','Eames Way'), ('words','EWS'), ('words','Marshfield PTO'),
  ('words','Carrie Lindsay'), ('words','Jessie Stiglich'), ('words','Russian School of Math'), ('words','RSM'),
  ('words','Boy Scouts'), ('words','Scouts BSA'), ('words','PlayerFirst'), ('words','Seacoast'), ('words','TeamSnap'),
  ('words','PlayMetrics'), ('words','Mamba Futsal'),
  ('words','field trip'), ('words','early release'), ('words','permission slip'), ('words','recital'), ('words','camp registration')
) as w(kind, value)
on conflict do nothing;
