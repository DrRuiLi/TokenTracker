-- Maintain the public global metrics from the existing daily leaderboard
-- rollup plus its small live tail. This avoids materializing every
-- (user, source, model) group as JSON in an edge request.

CREATE OR REPLACE FUNCTION public.refresh_tokentracker_community_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
SET work_mem TO '96MB'
SET hash_mem_multiplier TO '4'
SET statement_timeout TO '60s'
AS $func$
DECLARE
  v_through timestamptz;
  v_to timestamptz :=
    date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day';
  v_total bigint := 0;
  v_top_models jsonb := '[]'::jsonb;
BEGIN
  SELECT m.through
  INTO v_through
  FROM public.tokentracker_leaderboard_rollup_meta m
  WHERE m.id = 1;

  -- If the nightly rollup has not been initialized yet, correctness wins: the
  -- live side falls back to the complete range. Normal production calls only
  -- deduplicate the one- or two-day tail after v_through.
  v_through := COALESCE(v_through, '1970-01-01'::timestamptz);

  WITH model_parts AS MATERIALIZED (
    SELECT r.model, SUM(r.total_tokens)::bigint AS tokens
    FROM public.tokentracker_leaderboard_rollup_daily r
    WHERE trim(r.model) <> '' AND lower(trim(r.model)) <> 'auto'
    GROUP BY r.model

    UNION ALL

    SELECT d.model, SUM(d.total_tokens)::bigint AS tokens
    FROM public.leaderboard_hourly_dedup(v_through, v_to) d
    WHERE trim(d.model) <> '' AND lower(trim(d.model)) <> 'auto'
    GROUP BY d.model
  ),
  model_totals AS MATERIALIZED (
    SELECT trim(p.model) AS model, SUM(p.tokens)::bigint AS tokens
    FROM model_parts p
    GROUP BY trim(p.model)
  ),
  totals AS (
    SELECT COALESCE(SUM(m.tokens), 0)::bigint AS total_tokens
    FROM model_totals m
  ),
  top_models AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'name', ranked.model,
          'tokens', ranked.tokens,
          'share', CASE
            WHEN ranked.total_tokens > 0
              THEN round((ranked.tokens::numeric / ranked.total_tokens) * 1000) / 10
            ELSE 0
          END
        ) ORDER BY ranked.tokens DESC
      ),
      '[]'::jsonb
    ) AS value
    FROM (
      SELECT m.model, m.tokens, t.total_tokens
      FROM model_totals m
      CROSS JOIN totals t
      ORDER BY m.tokens DESC
      LIMIT 15
    ) ranked
  )
  SELECT t.total_tokens, top.value
  INTO v_total, v_top_models
  FROM totals t
  CROSS JOIN top_models top;

  INSERT INTO public.tokentracker_community_stats (
    id, total_tokens, top_models, from_day, to_day, generated_at
  ) VALUES (
    'total', v_total, v_top_models, DATE '1970-01-01', (v_to - interval '1 day')::date, now()
  )
  ON CONFLICT (id) DO UPDATE SET
    total_tokens = EXCLUDED.total_tokens,
    top_models = EXCLUDED.top_models,
    from_day = EXCLUDED.from_day,
    to_day = EXCLUDED.to_day,
    generated_at = EXCLUDED.generated_at;

  RETURN jsonb_build_object(
    'total_tokens', v_total,
    'model_count', jsonb_array_length(v_top_models)
  );
END
$func$;

REVOKE ALL ON FUNCTION public.refresh_tokentracker_community_stats()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_tokentracker_community_stats()
  TO project_admin;
