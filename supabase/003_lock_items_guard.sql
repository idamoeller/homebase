-- The items trigger function shouldn't be callable over the API (security advisor flag).
revoke execute on function public.items_guard() from public, anon, authenticated;
