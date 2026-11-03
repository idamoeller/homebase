-- Who's where is shared: anyone in the household can change or delete any entry.
-- New entries still record who added them.
drop policy if exists schedule_write on public.schedule;
create policy schedule_insert on public.schedule for insert with check (is_member(household_id) and user_id = auth.uid());
create policy schedule_update on public.schedule for update using (is_member(household_id)) with check (is_member(household_id));
create policy schedule_delete on public.schedule for delete using (is_member(household_id));
