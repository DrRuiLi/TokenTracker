CREATE TABLE IF NOT EXISTS public.tokentracker_anticheat_run_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_completed_at timestamptz
);

ALTER TABLE public.tokentracker_anticheat_run_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_anticheat_run_state
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tokentracker_anticheat_run_state TO project_admin;

INSERT INTO public.tokentracker_anticheat_run_state (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.tokentracker_anticheat_mark_scan_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
BEGIN
  INSERT INTO public.tokentracker_anticheat_run_state (id, last_completed_at)
  VALUES (true, clock_timestamp())
  ON CONFLICT (id) DO UPDATE
    SET last_completed_at = EXCLUDED.last_completed_at;
  RETURN NULL;
END;
$func$;

REVOKE ALL ON FUNCTION public.tokentracker_anticheat_mark_scan_completed()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tokentracker_anticheat_scan_completed
  ON public.tokentracker_leaderboard_anomaly_flags;
CREATE TRIGGER tokentracker_anticheat_scan_completed
AFTER INSERT ON public.tokentracker_leaderboard_anomaly_flags
FOR EACH STATEMENT
EXECUTE FUNCTION public.tokentracker_anticheat_mark_scan_completed();
