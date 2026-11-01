-- The Tell Mom flood guard counts only Tell Mom requests, not items the email reader files.
create or replace function public.submit_request(p_token text, p_from text, p_text text)
returns boolean language plpgsql security definer set search_path = public as $$
declare hid uuid; owner_id uuid;
begin
  if coalesce(trim(p_text), '') = '' then raise exception 'empty request'; end if;
  if length(p_text) > 1000 or length(coalesce(p_from, '')) > 60 then raise exception 'too long'; end if;
  select h.id, m.user_id into hid, owner_id
    from public.households h
    join public.members m on m.household_id = h.id and m.role = 'owner'
    where h.request_token = p_token
    limit 1;
  if hid is null then raise exception 'link not found'; end if;
  if (select count(*) from public.items
        where household_id = hid and source = 'request_page' and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'too many requests, try again later';
  end if;
  insert into public.items (household_id, created_by, assigned_to, visibility, title, inbox, from_name, source)
    values (hid, owner_id, owner_id, 'personal', trim(p_text), true, nullif(trim(p_from), ''), 'request_page');
  return true;
end $$;
