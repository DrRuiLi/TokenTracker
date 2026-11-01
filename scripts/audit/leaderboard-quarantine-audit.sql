-- Leaderboard moderation self-audit.
--
-- This file lives outside scripts/ops on purpose. It contains no thresholds,
-- no detection heuristics and no identities -- only a contradiction check that
-- is useless to an attacker: "whose data did we quarantine without banning
-- them?" Publishing it costs nothing and makes the self-audit reviewable.
--
-- Why this exists: on 2026-07-21 a batch quarantine keyed on a spike heuristic
-- moved rows for 40 users while only 8 of them were added to the block list.
-- The other 32 had 51.1B tokens withheld for five weeks. Nobody noticed until
-- one of them (issue #534) asked why their device flow returned 403. The
-- detector at the time only answered "is this account cheating?", never
-- "does the data we withheld still match the accounts we banned?".
--
-- Counts only, never user_ids: the caller is a public GitHub Actions log, and
-- naming an account there before human review accuses someone the review may
-- yet clear. Operators pull identities from the table directly.

CREATE OR REPLACE FUNCTION public.leaderboard_quarantine_audit(p_blocked uuid[])
RETURNS TABLE (
  orphan_users bigint,
  orphan_rows bigint,
  orphan_tokens numeric,
  oldest_orphan_quarantined_at timestamptz,
  blocked_total integer,
  blocked_without_flags integer
)
LANGUAGE sql
STABLE
AS $$
  WITH blocked AS (
    SELECT DISTINCT unnest(coalesce(p_blocked, ARRAY[]::uuid[])) AS user_id
  ),
  orphans AS (
    SELECT q.user_id, q.total_tokens, q.quarantined_at
    FROM public.tokentracker_hourly_quarantine q
    -- coalesce is load-bearing: `NULL NOT LIKE '%RESTORED%'` is NULL, not
    -- true, so an unannotated row would be dropped by the filter and the
    -- orphan would go unreported. Under-reporting is the one failure this
    -- audit must not have.
    WHERE coalesce(q.quarantine_reason, '') NOT LIKE '%RESTORED%'
      AND NOT EXISTS (SELECT 1 FROM blocked b WHERE b.user_id = q.user_id)
  )
  SELECT
    (SELECT count(DISTINCT user_id) FROM orphans),
    (SELECT count(*) FROM orphans),
    (SELECT coalesce(sum(total_tokens), 0) FROM orphans),
    (SELECT min(quarantined_at) FROM orphans),
    (SELECT count(*)::int FROM blocked),
    -- No flag row means the ban was entered by hand and was never checked
    -- against the automated criteria. Those are the ones worth re-reviewing
    -- first; it is a signal, not a verdict (a slow-drip cheater can sit far
    -- below every peak threshold and still be correctly banned).
    (SELECT count(*)::int FROM blocked b
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.tokentracker_leaderboard_anomaly_flags f
        WHERE f.user_id = b.user_id))
$$;
