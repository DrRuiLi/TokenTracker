ALTER TABLE public.tokentracker_anticheat_run_state
  ADD COLUMN IF NOT EXISTS last_queue_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_response_completed_at timestamptz;

UPDATE public.tokentracker_anticheat_run_state
SET last_queue_changed_at = (
  SELECT max(COALESCE(reviewed_at, detected_at))
  FROM public.tokentracker_leaderboard_anomaly_flags
)
WHERE id = true
  AND last_queue_changed_at IS NULL;

CREATE OR REPLACE FUNCTION public.tokentracker_anticheat_mark_queue_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $func$
BEGIN
  INSERT INTO public.tokentracker_anticheat_run_state (
    id,
    last_queue_changed_at
  )
  VALUES (true, clock_timestamp())
  ON CONFLICT (id) DO UPDATE
    SET last_queue_changed_at = EXCLUDED.last_queue_changed_at;
  RETURN NULL;
END;
$func$;

REVOKE ALL ON FUNCTION public.tokentracker_anticheat_mark_queue_changed()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tokentracker_anticheat_queue_changed
  ON public.tokentracker_leaderboard_anomaly_flags;
CREATE TRIGGER tokentracker_anticheat_queue_changed
AFTER INSERT OR DELETE OR UPDATE OF status
ON public.tokentracker_leaderboard_anomaly_flags
FOR EACH ROW
EXECUTE FUNCTION public.tokentracker_anticheat_mark_queue_changed();

CREATE OR REPLACE FUNCTION public.mark_anticheat_response_completed(
  p_queue_changed_at timestamptz
)
RETURNS TABLE(applied boolean, response_completed_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $func$
  WITH updated AS (
    UPDATE public.tokentracker_anticheat_run_state
    SET last_response_completed_at = p_queue_changed_at
    WHERE id = true
      AND last_queue_changed_at = p_queue_changed_at
    RETURNING last_response_completed_at
  )
  SELECT
    EXISTS (SELECT 1 FROM updated),
    (SELECT last_response_completed_at FROM updated);
$func$;

REVOKE ALL ON FUNCTION public.mark_anticheat_response_completed(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_anticheat_response_completed(timestamptz)
  TO project_admin;
