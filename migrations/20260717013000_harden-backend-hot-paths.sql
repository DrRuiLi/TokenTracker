-- Collapse the hottest edge-to-PostgREST fan-out into one RPC per request and
-- make anonymous telemetry writes atomic. Production evidence on 2026-07-17:
-- ~5k account function calls in seven minutes, 120+ 5xx responses, a saturated
-- PostgREST pool, socket resets, and repeated telemetry PK violations.

CREATE OR REPLACE FUNCTION public.account_usage_grouped_v2(
  p_user_id uuid,
  p_device_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_trunc text,
  p_tz text,
  p_offset_min integer
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET statement_timeout TO '8s'
AS $func$
  WITH active AS (
    SELECT COALESCE(array_agg(d.id ORDER BY d.id), ARRAY[]::uuid[]) AS ids
    FROM public.tokentracker_devices d
    WHERE d.user_id = p_user_id
      AND d.revoked_at IS NULL
  ), scoped AS (
    SELECT
      ids,
      CASE
        WHEN p_device_id IS NOT NULL AND p_device_id = ANY(ids)
          THEN ARRAY[p_device_id]::uuid[]
        ELSE ids
      END AS selected_ids
    FROM active
  )
  SELECT CASE
    -- Preserve the old edge behavior: users with no active device rows return
    -- no usage, including account-level sources.
    WHEN cardinality(ids) = 0 THEN '[]'::jsonb
    ELSE public.account_usage_grouped(
      p_user_id,
      selected_ids,
      p_from,
      p_to,
      p_trunc,
      p_tz,
      p_offset_min
    )
  END
  FROM scoped;
$func$;

REVOKE ALL ON FUNCTION public.account_usage_grouped_v2(
  uuid, uuid, timestamptz, timestamptz, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_usage_grouped_v2(
  uuid, uuid, timestamptz, timestamptz, text, text, integer
) TO project_admin;

-- One POST-body RPC replaces up to three waves of 25-id URL batches in the
-- leaderboard edge. Besides lowering latency, this prevents one refresh from
-- consuming nearly the whole PostgREST pool.
CREATE OR REPLACE FUNCTION public.leaderboard_user_metadata(
  p_user_ids uuid[]
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET statement_timeout TO '5s'
AS $func$
  WITH requested AS (
    SELECT DISTINCT user_id
    FROM unnest(COALESCE(p_user_ids, ARRAY[]::uuid[])) AS ids(user_id)
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'user_id', r.user_id,
        'leaderboard_public', COALESCE(s.leaderboard_public, false),
        'leaderboard_anonymous', COALESCE(s.leaderboard_anonymous, false),
        'github_url', s.github_url,
        'show_github_url', COALESCE(s.show_github_url, false),
        'display_name', CASE
          WHEN p.user_id IS NOT NULL THEN p.display_name
          ELSE previous.display_name
        END,
        'avatar_url', CASE
          WHEN p.user_id IS NOT NULL THEN p.avatar_url
          ELSE previous.avatar_url
        END
      )
      ORDER BY r.user_id
    ),
    '[]'::jsonb
  )
  FROM requested r
  LEFT JOIN public.tokentracker_user_settings s ON s.user_id = r.user_id
  LEFT JOIN public.tokentracker_user_profiles p ON p.user_id = r.user_id
  LEFT JOIN LATERAL (
    SELECT snap.display_name, snap.avatar_url
    FROM public.tokentracker_leaderboard_snapshots snap
    WHERE snap.user_id = r.user_id
    ORDER BY snap.generated_at DESC
    LIMIT 1
  ) previous ON p.user_id IS NULL;
$func$;

REVOKE ALL ON FUNCTION public.leaderboard_user_metadata(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_user_metadata(uuid[])
  TO project_admin;

-- Atomic replacement for the telemetry edge's SELECT -> INSERT/UPDATE race.
CREATE OR REPLACE FUNCTION public.upsert_tokentracker_telemetry_daily(
  p_machine_hash text,
  p_day date,
  p_app_version text,
  p_platform text,
  p_shell text,
  p_seen_at timestamptz
) RETURNS void
LANGUAGE sql VOLATILE
SET search_path TO public, pg_temp
SET statement_timeout TO '5s'
AS $func$
  INSERT INTO public.tokentracker_telemetry_daily (
    machine_hash,
    day,
    app_version,
    platform,
    shell,
    first_seen_at,
    last_seen_at
  ) VALUES (
    p_machine_hash,
    p_day,
    p_app_version,
    p_platform,
    p_shell,
    p_seen_at,
    p_seen_at
  )
  ON CONFLICT (machine_hash, day) DO UPDATE SET
    app_version = EXCLUDED.app_version,
    platform = EXCLUDED.platform,
    shell = CASE
      WHEN EXCLUDED.shell = 'cli'
           AND public.tokentracker_telemetry_daily.shell <> 'cli'
        THEN public.tokentracker_telemetry_daily.shell
      ELSE EXCLUDED.shell
    END,
    last_seen_at = EXCLUDED.last_seen_at;
$func$;

REVOKE ALL ON FUNCTION public.upsert_tokentracker_telemetry_daily(
  text, date, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_tokentracker_telemetry_daily(
  text, date, text, text, text, timestamptz
) TO project_admin;

-- The edge is the only telemetry writer. Direct table grants were inherited
-- from the original anonymous-table setup and are unnecessary with service-role
-- RPC writes plus deny-all RLS.
REVOKE ALL ON public.tokentracker_telemetry_daily FROM anon, authenticated;

-- Advisor finding: FK checks/deletes by badge_id otherwise scan all user badges.
CREATE INDEX IF NOT EXISTS tokentracker_user_badges_badge_id_idx
  ON public.tokentracker_user_badges (badge_id);

-- Existing internal RPCs should not retain PostgreSQL's default PUBLIC execute
-- privilege. Their callers use the project_admin service role after edge auth.
REVOKE ALL ON FUNCTION public.account_usage_grouped(
  uuid, uuid[], timestamptz, timestamptz, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_usage_grouped(
  uuid, uuid[], timestamptz, timestamptz, text, text, integer
) TO project_admin;

REVOKE ALL ON FUNCTION public.leaderboard_usage_grouped(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_usage_grouped(timestamptz, timestamptz)
  TO project_admin;
