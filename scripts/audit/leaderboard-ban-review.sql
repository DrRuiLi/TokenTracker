-- Re-review of standing leaderboard bans against the CURRENT automated criteria.
--
-- Lives outside scripts/ops because it hardcodes no thresholds: it reports the
-- raw signals and reads the cut-offs from tokentracker_anticheat_config at call
-- time, so the numbers an evader would want stay in the database.
--
-- This produces CANDIDATES, never verdicts. A ban is a judgement someone made
-- with context this query cannot see, and at least one standing ban is
-- deliberately correct while scoring below every threshold here (a slow-drip
-- injector spread over 215 days never produces a large peak). Read a low
-- cohort_ratio as "the stated reason no longer reproduces -- go look", not as
-- "this person is innocent".
--
-- cohort_ratio matches what detect_leaderboard_anomalies() actually computes:
-- rank-2, i.e. the account's own peak half-hour bucket divided by the biggest
-- bucket the NEXT-largest account reached that same day on the same
-- source+model. (The `exclude_cohort_ratio` note in the config table still says
-- "P95"; the deployed function has used ranking since -- a percentile over a
-- thin cohort gets dominated by the cheater's own row, rank-2 never is. Trust
-- the code.) Banned accounts are excluded from the comparison here because
-- their rows have usually been quarantined out of the live table anyway. It is what separates a real K8s farm
-- (which sits alongside comparable users) from fabricated volume (which towers
-- over its entire cohort). A ratio at or below 1 means an ordinary user out-ran
-- the banned account that day, which is very hard to call cheating.
--
-- Usage:
--   select * from leaderboard_ban_review(ARRAY['<uuid>', ...]::uuid[]);
-- Pass the current LEADERBOARD_BLOCKED_USER_IDS secret. Identities are returned
-- on purpose -- this is an operator tool, never wired to a public log.

CREATE OR REPLACE FUNCTION public.leaderboard_ban_review(p_blocked uuid[])
RETURNS TABLE (
  user_id uuid,
  peak_source text,
  peak_model text,
  peak_day date,
  peak_tokens bigint,
  rival_peak_tokens bigint,
  cohort_ratio numeric,
  has_detector_flag boolean,
  quarantine_reason text,
  meets_auto_exclude boolean,
  meets_review boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH blocked AS (
    SELECT DISTINCT unnest(coalesce(p_blocked, ARRAY[]::uuid[])) AS uid
  ),
  -- Thresholds come from the database, never from this file: the numbers are
  -- the part an evader would want. Key names mirror detect_leaderboard_anomalies().
  cfg AS (
    SELECT
      max(value) FILTER (WHERE key = 'exclude_cohort_ratio') AS c_cohort,
      max(value) FILTER (WHERE key = 'exclude_peak_hard') AS c_peak_hard,
      max(value) FILTER (WHERE key = 'exclude_peak_soft') AS c_peak_soft,
      max(value) FILTER (WHERE key = 'exclude_ratio') AS c_ratio,
      max(value) FILTER (WHERE key = 'review_peak') AS c_rev_peak
    FROM public.tokentracker_anticheat_config
  ),
  -- A partially quarantined account has rows in both tables; union so the peak
  -- reflects everything it ever uploaded, not just what is still visible.
  all_rows AS (
    SELECT user_id, source, model, hour_start, total_tokens
    FROM public.tokentracker_hourly
    WHERE user_id IN (SELECT uid FROM blocked)
    UNION ALL
    SELECT user_id, source, model, hour_start, total_tokens
    FROM public.tokentracker_hourly_quarantine
    WHERE user_id IN (SELECT uid FROM blocked)
  ),
  ranked AS (
    SELECT user_id, source, model, hour_start::date AS d, total_tokens,
           row_number() OVER (PARTITION BY user_id ORDER BY total_tokens DESC) AS rn
    FROM all_rows
  ),
  top_peak AS (
    SELECT user_id, source, model, d, total_tokens AS peak FROM ranked WHERE rn = 1
  )
  SELECT
    t.user_id,
    t.source,
    t.model,
    t.d,
    t.peak,
    coalesce(c.rival_peak, 0)::bigint,
    CASE WHEN coalesce(c.rival_peak, 0) > 0
      THEN round(t.peak::numeric / c.rival_peak, 2) END,
    EXISTS (
      SELECT 1 FROM public.tokentracker_leaderboard_anomaly_flags f
      WHERE f.user_id = t.user_id
    ),
    (SELECT max(q.quarantine_reason)
       FROM public.tokentracker_hourly_quarantine q
      WHERE q.user_id = t.user_id),
    -- Mirrors detect_leaderboard_anomalies()'s exclusion gate on its hard arm
    -- (cohort AND peak_hard). The soft arm additionally needs the 14-day
    -- self-baseline ratio, which is deliberately NOT recomputed here: ratio
    -- cannot separate a farm from a cheat on its own -- a hand-verified real
    -- farm scored 28.2, squarely inside the cheat band -- so surfacing it as a
    -- standalone column would invite exactly the misreading that caused the
    -- 2026-07-21 batch. cohort_ratio is the discriminating signal; check the
    -- soft arm by hand for anything that scores near the gate.
    coalesce(c.rival_peak, 0) > 0
      AND (t.peak::numeric / c.rival_peak) >= (SELECT c_cohort FROM cfg)
      AND t.peak >= (SELECT c_peak_hard FROM cfg),
    t.peak >= (SELECT c_rev_peak FROM cfg)
  FROM top_peak t
  LEFT JOIN LATERAL (
    SELECT max(h.total_tokens) AS rival_peak
    FROM public.tokentracker_hourly h
    WHERE h.source = t.source
      AND h.model = t.model
      AND h.hour_start >= t.d::timestamptz
      AND h.hour_start < (t.d + 1)::timestamptz
      AND h.user_id <> t.user_id
      AND h.user_id NOT IN (SELECT uid FROM blocked)
  ) c ON true
  ORDER BY t.peak DESC
$$;
