-- Homebase — phone notifications (web push from the home-screen app).
-- When someone adds a Who's where entry or a Homebase-calendar event, everyone else in the household
-- whose device has notifications on gets one. Adds are queued, then a 1-minute job sends them, so a
-- burst (12 weekly events, a trip from email) arrives as one notification, and something added and
-- undone right away sends nothing. The push keys live in private.app_secrets (vapid_public / vapid_private).

-- ── Devices that turned notifications on ───────────────────────────────────
create table if not exists public.push_subs (
  endpoint     text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  p256dh       text not null,
  auth         text not null,
  device       text,
  created_at   timestamptz not null default now(),
  last_ok_at   timestamptz
);

alter table public.push_subs enable row level security;
drop policy if exists push_subs_own on public.push_subs;
create policy push_subs_own on public.push_subs for select to authenticated using (user_id = auth.uid());
revoke all on public.push_subs from anon, authenticated;
grant select on public.push_subs to authenticated;
grant select, delete on public.push_subs to service_role;

-- Turn this device on for the signed-in person (a shared iPad moves to whoever turned it on last).
create or replace function public.save_push_sub(p_endpoint text, p_p256dh text, p_auth text, p_device text)
returns void language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  select household_id into hid from public.members where user_id = auth.uid();
  if hid is null then raise exception 'not a member'; end if;
  if p_endpoint !~ '^https://' then raise exception 'bad endpoint'; end if;
  insert into public.push_subs (endpoint, user_id, household_id, p256dh, auth, device)
  values (p_endpoint, auth.uid(), hid, p_p256dh, p_auth, left(p_device, 120))
  on conflict (endpoint) do update set user_id = excluded.user_id, household_id = excluded.household_id,
    p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device;
end $$;

create or replace function public.drop_push_sub(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_subs where endpoint = p_endpoint and user_id = auth.uid();
$$;

revoke execute on function public.save_push_sub(text, text, text, text) from public, anon;
revoke execute on function public.drop_push_sub(text) from public, anon;
grant execute on function public.save_push_sub(text, text, text, text) to authenticated;
grant execute on function public.drop_push_sub(text) to authenticated;

-- ── Queue of things to announce ────────────────────────────────────────────
-- One row per added thing, ever (sent rows stay 60 days), so a re-insert, like undoing a delete, isn't announced twice.
create table if not exists private.push_queue (
  id           bigserial primary key,
  household_id uuid not null,
  kind         text not null check (kind in ('schedule', 'event')),
  row_id       uuid not null,
  actor        uuid,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  unique (kind, row_id)
);

create or replace function private.queue_schedule_push() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  insert into private.push_queue (household_id, kind, row_id, actor)
  select n.household_id, 'schedule', n.id, n.user_id from new_rows n
  on conflict do nothing;
  return null;
end $$;

-- Only events added to the Homebase calendar for the family. Synced calendars are left out (they reload
-- every 30 minutes), and so are trip events filed from email (the Who's where trip already announces them).
create or replace function private.queue_event_push() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  insert into private.push_queue (household_id, kind, row_id, actor)
  select n.household_id, 'event', n.id, n.created_by
  from new_rows n join public.connections c on c.id = n.connection_id
  where c.kind = 'homebase' and n.visibility = 'family' and coalesce(n.uid, '') not like 'hb-trip-%'
  on conflict do nothing;
  return null;
end $$;

drop trigger if exists schedule_push on public.schedule;
create trigger schedule_push after insert on public.schedule
  referencing new table as new_rows for each statement execute function private.queue_schedule_push();

drop trigger if exists events_push on public.events;
create trigger events_push after insert on public.events
  referencing new table as new_rows for each statement execute function private.queue_event_push();

-- ── For the notify function (service role only) ────────────────────────────
-- Hands over everything that's ready (nothing added in that household in the last 20 seconds) and marks it sent.
create or replace function public.push_take()
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare q bigint[]; hs uuid[];
begin
  delete from private.push_queue where sent_at < now() - interval '60 days';
  select coalesce(array_agg(id), '{}') into q from (
    select p.id from private.push_queue p
    where p.sent_at is null
      and not exists (select 1 from private.push_queue p2 where p2.household_id = p.household_id
                        and p2.sent_at is null and p2.created_at > now() - interval '20 seconds')
    for update skip locked) t;
  if cardinality(q) = 0 then return null; end if;
  update private.push_queue set sent_at = now() where id = any(q);
  select array_agg(distinct household_id) into hs from private.push_queue where id = any(q);
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('household_id', p.household_id, 'kind', p.kind, 'actor', p.actor,
        'row', case p.kind
          when 'schedule' then (select to_jsonb(s) from (select kind, place, start_date, end_date, person_ids
                                                         from public.schedule where id = p.row_id) s)
          else (select to_jsonb(e) from (select title, all_day, starts_at, start_date, person_id, location
                                         from public.events where id = p.row_id) e) end) order by p.id)
      from private.push_queue p where p.id = any(q)), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(jsonb_build_object('household_id', household_id, 'user_id', user_id, 'name', display_name))
      from public.members where household_id = any(hs)), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'user_id', user_id))
      from public.people where household_id = any(hs)), '[]'::jsonb),
    'subs', coalesce((select jsonb_agg(jsonb_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth,
        'user_id', user_id, 'household_id', household_id))
      from public.push_subs where household_id = any(hs)), '[]'::jsonb));
end $$;

create or replace function public.push_report(p_ok text[], p_gone text[])
returns void language sql security definer set search_path = public as $$
  update public.push_subs set last_ok_at = now() where endpoint = any(p_ok);
  delete from public.push_subs where endpoint = any(p_gone);
$$;

create or replace function public.push_keys()
returns jsonb language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object(
    'public', (select value from private.app_secrets where name = 'vapid_public'),
    'private', (select value from private.app_secrets where name = 'vapid_private'));
$$;

revoke execute on function public.push_take() from public, anon, authenticated;
revoke execute on function public.push_report(text[], text[]) from public, anon, authenticated;
revoke execute on function public.push_keys() from public, anon, authenticated;
grant execute on function public.push_take() to service_role;
grant execute on function public.push_report(text[], text[]) to service_role;
grant execute on function public.push_keys() to service_role;

-- ── Every minute, if anything is waiting, ask the notify function to send it ──
select cron.schedule('homebase-push', '* * * * *', $job$
  select net.http_post(
    url := 'https://dufbnditthfnnchnvauu.supabase.co/functions/v1/notify',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from private.app_secrets where name='cron')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from private.push_queue where sent_at is null)
$job$);
