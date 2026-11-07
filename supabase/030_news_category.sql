-- Homebase — announcements come in two kinds: the kids' schools, and everything outside school (music, camps, sports, RSM…).
alter table public.school_news add column if not exists category text not null default 'school'
  check (category in ('school', 'activity'));
update public.school_news set category = 'activity'
  where source !~* 'eames|\mews\M|furnace|\mfbms\M|marshfield|\mmpsd\M|\mpto\M';
