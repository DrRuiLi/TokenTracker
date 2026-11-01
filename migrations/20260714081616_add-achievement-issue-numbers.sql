-- Stable global acquisition numbers for every cloud badge tier.

ALTER TABLE public.tokentracker_user_badges
  ADD COLUMN IF NOT EXISTS bronze_no  bigint,
  ADD COLUMN IF NOT EXISTS silver_no  bigint,
  ADD COLUMN IF NOT EXISTS gold_no    bigint,
  ADD COLUMN IF NOT EXISTS diamond_no bigint;

CREATE OR REPLACE FUNCTION public.user_badges_assign_serials()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $func$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tokentracker-badge-issue-numbers', 0)
  );

  WITH maxima AS (
    SELECT badge_id, COALESCE(MAX(bronze_no), 0) AS max_no
    FROM public.tokentracker_user_badges GROUP BY badge_id
  ), numbered AS (
    SELECT b.user_id, b.badge_id,
           m.max_no + ROW_NUMBER() OVER (
             PARTITION BY b.badge_id ORDER BY b.bronze_at, b.user_id
           ) AS issue_no
    FROM public.tokentracker_user_badges b
    JOIN maxima m USING (badge_id)
    WHERE b.bronze_at IS NOT NULL AND b.bronze_no IS NULL
  )
  UPDATE public.tokentracker_user_badges b
  SET bronze_no = n.issue_no
  FROM numbered n
  WHERE b.user_id = n.user_id AND b.badge_id = n.badge_id;

  WITH maxima AS (
    SELECT badge_id, COALESCE(MAX(silver_no), 0) AS max_no
    FROM public.tokentracker_user_badges GROUP BY badge_id
  ), numbered AS (
    SELECT b.user_id, b.badge_id,
           m.max_no + ROW_NUMBER() OVER (
             PARTITION BY b.badge_id ORDER BY b.silver_at, b.user_id
           ) AS issue_no
    FROM public.tokentracker_user_badges b
    JOIN maxima m USING (badge_id)
    WHERE b.silver_at IS NOT NULL AND b.silver_no IS NULL
  )
  UPDATE public.tokentracker_user_badges b
  SET silver_no = n.issue_no
  FROM numbered n
  WHERE b.user_id = n.user_id AND b.badge_id = n.badge_id;

  WITH maxima AS (
    SELECT badge_id, COALESCE(MAX(gold_no), 0) AS max_no
    FROM public.tokentracker_user_badges GROUP BY badge_id
  ), numbered AS (
    SELECT b.user_id, b.badge_id,
           m.max_no + ROW_NUMBER() OVER (
             PARTITION BY b.badge_id ORDER BY b.gold_at, b.user_id
           ) AS issue_no
    FROM public.tokentracker_user_badges b
    JOIN maxima m USING (badge_id)
    WHERE b.gold_at IS NOT NULL AND b.gold_no IS NULL
  )
  UPDATE public.tokentracker_user_badges b
  SET gold_no = n.issue_no
  FROM numbered n
  WHERE b.user_id = n.user_id AND b.badge_id = n.badge_id;

  WITH maxima AS (
    SELECT badge_id, COALESCE(MAX(diamond_no), 0) AS max_no
    FROM public.tokentracker_user_badges GROUP BY badge_id
  ), numbered AS (
    SELECT b.user_id, b.badge_id,
           m.max_no + ROW_NUMBER() OVER (
             PARTITION BY b.badge_id ORDER BY b.diamond_at, b.user_id
           ) AS issue_no
    FROM public.tokentracker_user_badges b
    JOIN maxima m USING (badge_id)
    WHERE b.diamond_at IS NOT NULL AND b.diamond_no IS NULL
  )
  UPDATE public.tokentracker_user_badges b
  SET diamond_no = n.issue_no
  FROM numbered n
  WHERE b.user_id = n.user_id AND b.badge_id = n.badge_id;
END
$func$;

-- Backfill every historical issuance before enforcing uniqueness.
SELECT public.user_badges_assign_serials();

CREATE UNIQUE INDEX IF NOT EXISTS tokentracker_user_badges_bronze_no_uq
  ON public.tokentracker_user_badges (badge_id, bronze_no)
  WHERE bronze_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tokentracker_user_badges_silver_no_uq
  ON public.tokentracker_user_badges (badge_id, silver_no)
  WHERE silver_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tokentracker_user_badges_gold_no_uq
  ON public.tokentracker_user_badges (badge_id, gold_no)
  WHERE gold_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tokentracker_user_badges_diamond_no_uq
  ON public.tokentracker_user_badges (badge_id, diamond_no)
  WHERE diamond_no IS NOT NULL;

CREATE OR REPLACE FUNCTION public.user_badges_assign_serials_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $func$
BEGIN
  -- Lock before the writer takes row locks; the AFTER pass then assigns the
  -- batch without a cross-writer deadlock window.
  IF TG_WHEN = 'BEFORE' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('tokentracker-badge-issue-numbers', 0)
    );
    RETURN NULL;
  END IF;
  IF pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  PERFORM public.user_badges_assign_serials();
  RETURN NULL;
END
$func$;

DROP TRIGGER IF EXISTS tokentracker_user_badges_lock_serials
  ON public.tokentracker_user_badges;
CREATE TRIGGER tokentracker_user_badges_lock_serials
BEFORE INSERT OR UPDATE ON public.tokentracker_user_badges
FOR EACH STATEMENT EXECUTE FUNCTION public.user_badges_assign_serials_trigger();

DROP TRIGGER IF EXISTS tokentracker_user_badges_assign_serials
  ON public.tokentracker_user_badges;
CREATE TRIGGER tokentracker_user_badges_assign_serials
AFTER INSERT OR UPDATE ON public.tokentracker_user_badges
FOR EACH STATEMENT EXECUTE FUNCTION public.user_badges_assign_serials_trigger();

REVOKE EXECUTE ON FUNCTION public.user_badges_assign_serials() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.user_badges_assign_serials_trigger() FROM anon, authenticated, PUBLIC;

-- Expose all four tier numbers; the modal selects the current tier.
CREATE OR REPLACE FUNCTION public.user_badges_full(p_user_id uuid, p_include_unearned boolean)
RETURNS jsonb
LANGUAGE sql STABLE
SET statement_timeout TO '5s'
AS $func$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.badge_id,
    'tier', b.tier,
    'metric_value', b.metric_value,
    'thresholds', jsonb_build_array(c.bronze, c.silver, c.gold, c.diamond),
    'lower_is_better', c.lower_is_better,
    'next_threshold', CASE b.tier
      WHEN 4 THEN NULL
      WHEN 3 THEN c.diamond
      WHEN 2 THEN c.gold
      WHEN 1 THEN c.silver
      ELSE c.bronze END,
    'achieved', jsonb_build_object(
      'bronze', b.bronze_at, 'silver', b.silver_at,
      'gold', b.gold_at, 'diamond', b.diamond_at),
    'serials', jsonb_build_object(
      'bronze', b.bronze_no, 'silver', b.silver_no,
      'gold', b.gold_no, 'diamond', b.diamond_no),
    'meta', b.meta,
    'updated_at', b.updated_at
  ) ORDER BY b.tier DESC, c.sort_order ASC), '[]'::jsonb)
  FROM public.tokentracker_user_badges b
  JOIN public.tokentracker_badge_catalog c USING (badge_id)
  WHERE b.user_id = p_user_id
    AND (p_include_unearned OR b.tier >= 1);
$func$;

REVOKE EXECUTE ON FUNCTION public.user_badges_full(uuid, boolean) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_badges_full(uuid, boolean) TO project_admin;
