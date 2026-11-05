-- Run with an unrestricted database session after applying
-- 20260716113500_add-community-stats-refresh.sql. Schema-only branches do not
-- own the shared pg_cron schema, so scheduling intentionally stays out of the
-- portable migration.
--
-- pg_cron's named schedule is idempotent: rerunning this updates the existing
-- job rather than creating duplicates.
SELECT cron.schedule(
  'tokentracker-community-stats-refresh',
  '17 * * * *',
  'SELECT public.refresh_tokentracker_community_stats()'
);
