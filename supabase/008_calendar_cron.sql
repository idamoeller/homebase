-- Re-read every calendar link every 30 minutes (job id 1). The secret never leaves the database.
select cron.schedule('homebase-sync-calendars', '*/30 * * * *', $job$
  select net.http_post(
    url := 'https://dufbnditthfnnchnvauu.supabase.co/functions/v1/sync-calendars',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from private.app_secrets where name='cron')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$job$);
