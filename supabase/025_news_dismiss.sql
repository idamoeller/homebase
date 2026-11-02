-- Homebase — dismiss school news for yourself only; newer news from the same school still shows.
alter table public.school_news add column if not exists hidden_by uuid[] not null default '{}';

create or replace function public.hide_school_news(p_household uuid, p_source text, p_hide boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_household) then raise exception 'not a member'; end if;
  if p_hide then
    update public.school_news set hidden_by = array_append(hidden_by, auth.uid())
    where household_id = p_household and source = p_source and not (auth.uid() = any(hidden_by));
  else
    update public.school_news set hidden_by = array_remove(hidden_by, auth.uid())
    where household_id = p_household and source = p_source;
  end if;
end $$;
revoke execute on function public.hide_school_news(uuid, text, boolean) from public, anon;
grant execute on function public.hide_school_news(uuid, text, boolean) to authenticated;
