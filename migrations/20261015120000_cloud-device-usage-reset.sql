-- Rebuild one registered machine's hourly truth. The client persists the
-- operation before reset, obtains a new device token, and acknowledges refresh
-- only after its local upload queue has drained. Account session states are
-- shared across machines and are never deleted here.
CREATE TABLE public.tokentracker_cloud_usage_resets (
  operation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL,
  device_id uuid NOT NULL REFERENCES public.tokentracker_devices(id) ON DELETE CASCADE,
  machine_id uuid NOT NULL,
  device_ids uuid[] NOT NULL,
  affected_days date[] NOT NULL DEFAULT '{}',
  removed_rows bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'reset' CHECK (status IN ('reset','complete')),
  reset_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  FOREIGN KEY (user_id,environment,machine_id)
    REFERENCES public.tokentracker_cloud_machines(user_id,environment,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX tokentracker_cloud_usage_resets_pending_idx
  ON public.tokentracker_cloud_usage_resets(user_id,environment,machine_id) WHERE status='reset';
CREATE INDEX tokentracker_cloud_usage_resets_user_idx
  ON public.tokentracker_cloud_usage_resets(user_id);
ALTER TABLE public.tokentracker_cloud_usage_resets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_cloud_usage_resets FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.tokentracker_cloud_usage_resets TO project_admin;

-- A refresh may have read old totals before a reset and only reach its
-- batched snapshot upsert afterwards. Serialize each write with reset/refresh,
-- then reject snapshots whose read started before the latest reset boundary.
CREATE FUNCTION public.cloud_guard_usage_reset_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE v_pending boolean; v_boundary timestamptz;
BEGIN
  -- Never wait after an UPDATE may already have taken its row lock. Skipping
  -- this write lets the reset's DELETE finish without a row/advisory deadlock.
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(NEW.user_id::text||':cloud-device',0)) THEN
    RETURN NULL;
  END IF;
  SELECT bool_or(status='reset'),max(greatest(reset_at,completed_at)) INTO v_pending,v_boundary
    FROM public.tokentracker_cloud_usage_resets WHERE user_id=NEW.user_id;
  IF coalesce(v_pending,false) OR NEW.generated_at<v_boundary THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER cloud_guard_usage_reset_snapshot BEFORE INSERT OR UPDATE
  ON public.tokentracker_leaderboard_snapshots FOR EACH ROW
  EXECUTE FUNCTION public.cloud_guard_usage_reset_snapshot();
CREATE TRIGGER cloud_guard_usage_reset_snapshot BEFORE INSERT OR UPDATE
  ON public.agentmeter_leaderboard_snapshots FOR EACH ROW
  EXECUTE FUNCTION public.cloud_guard_usage_reset_snapshot();

-- Rebuild only this account's affected closed days in one scan. Inlining the
-- canonical SQL function pushes user_id into its hourly/session source scans;
-- a years-long queue does not require one query per historical day.
CREATE FUNCTION public.cloud_rebuild_device_usage_derived(p_user_id uuid,p_days date[])
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE v_through timestamptz; v_from timestamptz; v_to timestamptz;
BEGIN
  SELECT through INTO v_through FROM public.tokentracker_leaderboard_rollup_meta_v2 WHERE id=1;
  IF v_through IS NULL THEN RAISE EXCEPTION 'cloud_usage_reset_rollup_unavailable'; END IF;
  SELECT min(day)::timestamp AT TIME ZONE 'UTC',
    least((max(day)+1)::timestamp AT TIME ZONE 'UTC',v_through)
    INTO v_from,v_to FROM unnest(p_days) day
    WHERE day::timestamp AT TIME ZONE 'UTC'<v_through;
  IF v_from IS NOT NULL THEN
    DELETE FROM public.tokentracker_leaderboard_rollup_daily_v2
      WHERE user_id=p_user_id AND day=ANY(p_days) AND day::timestamp AT TIME ZONE 'UTC'<v_through;
    INSERT INTO public.tokentracker_leaderboard_rollup_daily_v2(user_id,source,model,pricing_tier,day,
      total_tokens,input_tokens,output_tokens,cached_input_tokens,cache_creation_input_tokens,reasoning_output_tokens)
    SELECT d.user_id,d.source,d.model,public.leaderboard_pricing_tier(d.model,d.hour_start),
      (d.hour_start AT TIME ZONE 'UTC')::date,
      sum(d.total_tokens),sum(d.input_tokens),sum(d.output_tokens),sum(d.cached_input_tokens),
      sum(d.cache_creation_input_tokens),sum(d.reasoning_output_tokens)
    FROM public.leaderboard_hourly_dedup_v2(v_from,v_to) d
    WHERE d.user_id=p_user_id AND (d.hour_start AT TIME ZONE 'UTC')::date=ANY(p_days)
    GROUP BY d.user_id,d.source,d.model,public.leaderboard_pricing_tier(d.model,d.hour_start),
      (d.hour_start AT TIME ZONE 'UTC')::date
    ON CONFLICT(user_id,source,model,pricing_tier,day) DO UPDATE SET
      total_tokens=excluded.total_tokens,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
      cached_input_tokens=excluded.cached_input_tokens,cache_creation_input_tokens=excluded.cache_creation_input_tokens,
      reasoning_output_tokens=excluded.reasoning_output_tokens;
    -- A scheduled rollup can recreate a deleted key before this INSERT.
    -- ON CONFLICT uses the canonical update trigger in that case.
    -- The existing statement-level insert/delete/update triggers update lifetime
    -- totals in the same transaction; no global rebuild is needed.
  END IF;
  DELETE FROM public.tokentracker_leaderboard_snapshots WHERE user_id=p_user_id;
  DELETE FROM public.agentmeter_leaderboard_snapshots WHERE user_id=p_user_id;
  DELETE FROM public.tokentracker_account_usage_cache WHERE split_part(cache_key,chr(31),2)=p_user_id::text;
END;
$fn$;

CREATE FUNCTION public.cloud_reset_device_usage(
  p_user_id uuid,p_environment text,p_device_id uuid,p_operation_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE
  v_operation public.tokentracker_cloud_usage_resets%ROWTYPE;
  v_slot uuid; v_devices uuid[]; v_days date[]; v_removed bigint; v_now timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_device_id IS NULL OR p_operation_id IS NULL
    OR p_environment IS NULL OR p_environment NOT IN ('live','sandbox') THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_invalid_request','status',400);
  END IF;
  -- Serialize globally unique operation IDs before taking account locks, so
  -- competing accounts receive a conflict instead of a late unique violation.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_operation_id::text||':cloud-usage-reset',0));
  -- Same order as cloud_reconcile_machines / cloud_ingest_usage. A waiting
  -- ingest rechecks its token after acquiring these locks, so revoked tokens
  -- cannot restore a deleted row after this transaction commits.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_environment,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':cloud-device',0));
  SELECT * INTO v_operation FROM public.tokentracker_cloud_usage_resets WHERE operation_id=p_operation_id;
  IF FOUND THEN
    IF v_operation.user_id<>p_user_id OR v_operation.environment<>p_environment OR v_operation.device_id<>p_device_id THEN
      RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_operation_conflict','status',409);
    END IF;
    RETURN jsonb_build_object('ok',true,'operation_id',p_operation_id,'device_id',p_device_id,
      'machine_id',v_operation.machine_id,'removed_rows',v_operation.removed_rows,'status',v_operation.status);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tokentracker_devices WHERE id=p_device_id AND user_id=p_user_id AND revoked_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_device_not_found','status',404);
  END IF;
  -- Production currently has only hot hourly truth. Refuse installations with
  -- archives until this operation can invalidate their generations atomically.
  IF to_regclass('public.tokentracker_usage_archive_manifest') IS NOT NULL
    OR to_regclass('public.tokentracker_usage_archive_generations') IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_archive_unsupported','status',409);
  END IF;
  IF (SELECT count(DISTINCT tgfoid) FROM pg_trigger
      WHERE tgrelid='public.tokentracker_leaderboard_rollup_daily_v2'::regclass AND tgenabled IN ('O','A')
        AND tgfoid IN ('public.leaderboard_rollup_total_v2_after_insert()'::regprocedure,
          'public.leaderboard_rollup_total_v2_after_delete()'::regprocedure,
          'public.leaderboard_rollup_total_v2_after_update()'::regprocedure))<>3 THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_rollup_unavailable','status',503);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tokentracker_leaderboard_rollup_meta_v2 WHERE id=1 AND through IS NOT NULL) THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_rollup_unavailable','status',503);
  END IF;
  PERFORM public.cloud_reconcile_machines(p_user_id,p_environment);
  SELECT a.machine_id INTO v_slot FROM public.tokentracker_cloud_machine_aliases a
    JOIN public.tokentracker_cloud_machines m ON m.id=a.machine_id AND m.user_id=a.user_id AND m.environment=a.environment
    WHERE a.user_id=p_user_id AND a.environment=p_environment AND a.kind='device' AND a.alias=p_device_id::text
      AND m.status='active';
  IF v_slot IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_machine_paused','status',403);
  END IF;
  IF EXISTS(SELECT 1 FROM public.tokentracker_cloud_usage_resets
    WHERE user_id=p_user_id AND environment=p_environment AND machine_id=v_slot AND status='reset') THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_in_progress','status',409);
  END IF;
  SELECT array_agg(d.id ORDER BY d.id) INTO v_devices FROM public.tokentracker_cloud_machine_aliases a
    JOIN public.tokentracker_devices d ON d.id::text=a.alias AND d.user_id=a.user_id
    WHERE a.user_id=p_user_id AND a.environment=p_environment AND a.kind='device' AND a.machine_id=v_slot;
  IF v_devices IS NULL OR NOT (p_device_id=ANY(v_devices)) THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_device_not_found','status',404);
  END IF;
  -- hourly has no environment column. Even revoked tokens from another
  -- environment make its historical rows ambiguous, so do not partially reset.
  IF EXISTS(SELECT 1 FROM public.tokentracker_device_tokens WHERE user_id=p_user_id
    AND device_id=ANY(v_devices) AND cloud_environment IS DISTINCT FROM p_environment) THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_environment_conflict','status',409);
  END IF;
  SELECT coalesce(array_agg(DISTINCT (hour_start AT TIME ZONE 'UTC')::date),'{}'::date[])
    INTO v_days FROM public.tokentracker_hourly WHERE user_id=p_user_id AND device_id=ANY(v_devices);
  v_now:=clock_timestamp();
  UPDATE public.tokentracker_device_tokens SET revoked_at=v_now
    WHERE user_id=p_user_id AND cloud_environment=p_environment AND device_id=ANY(v_devices) AND revoked_at IS NULL;
  DELETE FROM public.tokentracker_hourly WHERE user_id=p_user_id AND device_id=ANY(v_devices);
  GET DIAGNOSTICS v_removed=ROW_COUNT;
  UPDATE public.tokentracker_cloud_machines SET last_upload_at=NULL,upload_window_until=NULL,
    upload_token_id=NULL,upload_id=NULL,upload_batch_count=0
    WHERE id=v_slot AND user_id=p_user_id AND environment=p_environment;
  INSERT INTO public.tokentracker_cloud_usage_resets(operation_id,user_id,environment,device_id,machine_id,
    device_ids,affected_days,removed_rows,reset_at)
    VALUES(p_operation_id,p_user_id,p_environment,p_device_id,v_slot,v_devices,v_days,v_removed,v_now);
  PERFORM public.cloud_rebuild_device_usage_derived(p_user_id,v_days);
  RETURN jsonb_build_object('ok',true,'operation_id',p_operation_id,'device_id',p_device_id,
    'machine_id',v_slot,'removed_rows',v_removed,'status','reset');
END;
$fn$;

CREATE FUNCTION public.cloud_refresh_device_usage(
  p_token_hash text,p_environment text,p_operation_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE
  v_token public.tokentracker_device_tokens%ROWTYPE;
  v_operation public.tokentracker_cloud_usage_resets%ROWTYPE;
  v_slot uuid; v_devices uuid[]; v_days date[];
BEGIN
  SELECT * INTO v_token FROM public.tokentracker_device_tokens WHERE token_hash=p_token_hash AND revoked_at IS NULL;
  IF NOT FOUND OR v_token.cloud_environment IS DISTINCT FROM p_environment THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_device_token_rejected','status',401);
  END IF;
  PERFORM public.cloud_reconcile_machines(v_token.user_id,p_environment);
  SELECT * INTO v_token FROM public.tokentracker_device_tokens WHERE token_hash=p_token_hash AND revoked_at IS NULL;
  IF NOT FOUND OR v_token.cloud_environment IS DISTINCT FROM p_environment THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_device_token_rejected','status',401);
  END IF;
  SELECT * INTO v_operation FROM public.tokentracker_cloud_usage_resets
    WHERE operation_id=p_operation_id AND user_id=v_token.user_id AND environment=p_environment FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_operation_not_found','status',404);
  END IF;
  SELECT a.machine_id INTO v_slot FROM public.tokentracker_cloud_machine_aliases a
    JOIN public.tokentracker_devices d ON d.id=v_token.device_id AND d.id::text=a.alias AND d.user_id=a.user_id AND d.revoked_at IS NULL
    JOIN public.tokentracker_cloud_machines m ON m.id=a.machine_id AND m.user_id=a.user_id AND m.environment=a.environment
    WHERE a.user_id=v_token.user_id AND a.environment=p_environment AND a.kind='device' AND m.status='active';
  IF v_slot IS DISTINCT FROM v_operation.machine_id OR v_token.created_at<v_operation.reset_at THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_device_mismatch','status',403);
  END IF;
  IF v_operation.status='complete' THEN
    RETURN jsonb_build_object('ok',true,'operation_id',p_operation_id,'device_id',v_operation.device_id,
      'machine_id',v_slot,'removed_rows',v_operation.removed_rows,'status','complete');
  END IF;
  IF to_regclass('public.tokentracker_usage_archive_manifest') IS NOT NULL
    OR to_regclass('public.tokentracker_usage_archive_generations') IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_archive_unsupported','status',409);
  END IF;
  IF (SELECT count(DISTINCT tgfoid) FROM pg_trigger
      WHERE tgrelid='public.tokentracker_leaderboard_rollup_daily_v2'::regclass AND tgenabled IN ('O','A')
        AND tgfoid IN ('public.leaderboard_rollup_total_v2_after_insert()'::regprocedure,
          'public.leaderboard_rollup_total_v2_after_delete()'::regprocedure,
          'public.leaderboard_rollup_total_v2_after_update()'::regprocedure))<>3 THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_rollup_unavailable','status',503);
  END IF;
  SELECT array_agg(d.id ORDER BY d.id) INTO v_devices FROM public.tokentracker_cloud_machine_aliases a
    JOIN public.tokentracker_devices d ON d.id::text=a.alias AND d.user_id=a.user_id
    WHERE a.user_id=v_token.user_id AND a.environment=p_environment AND a.kind='device' AND a.machine_id=v_slot;
  IF EXISTS(SELECT 1 FROM public.tokentracker_device_tokens WHERE user_id=v_token.user_id
    AND device_id=ANY(v_devices) AND cloud_environment IS DISTINCT FROM p_environment) THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_environment_conflict','status',409);
  END IF;
  SELECT coalesce(array_agg(DISTINCT day),'{}'::date[]) INTO v_days FROM (
    SELECT unnest(v_operation.affected_days) AS day
    UNION SELECT (hour_start AT TIME ZONE 'UTC')::date FROM public.tokentracker_hourly
      WHERE user_id=v_token.user_id AND device_id=ANY(v_devices)
  ) affected;
  IF NOT EXISTS(SELECT 1 FROM public.tokentracker_leaderboard_rollup_meta_v2 WHERE id=1 AND through IS NOT NULL) THEN
    RETURN jsonb_build_object('ok',false,'code','cloud_usage_reset_rollup_unavailable','status',503);
  END IF;
  PERFORM public.cloud_rebuild_device_usage_derived(v_token.user_id,v_days);
  UPDATE public.tokentracker_cloud_usage_resets SET status='complete',completed_at=clock_timestamp(),affected_days=v_days
    WHERE operation_id=p_operation_id;
  RETURN jsonb_build_object('ok',true,'operation_id',p_operation_id,'device_id',v_operation.device_id,
    'machine_id',v_slot,'removed_rows',v_operation.removed_rows,'status','complete');
END;
$fn$;

REVOKE ALL ON FUNCTION public.cloud_guard_usage_reset_snapshot(),
  public.cloud_rebuild_device_usage_derived(uuid,date[]),
  public.cloud_reset_device_usage(uuid,text,uuid,uuid),
  public.cloud_refresh_device_usage(text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cloud_guard_usage_reset_snapshot(),
  public.cloud_rebuild_device_usage_derived(uuid,date[]),
  public.cloud_reset_device_usage(uuid,text,uuid,uuid),
  public.cloud_refresh_device_usage(text,text,uuid) TO project_admin;

CREATE OR REPLACE FUNCTION public.account_usage_grouped_cached(p_user_id uuid, p_device_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_trunc text, p_tz text, p_offset_min integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_cache_key text;
  v_result jsonb;
BEGIN
  -- Hold the account read lock through both aggregation and cache insertion.
  -- Reset waits for earlier readers and clears their entries before committing.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_user_id::text||':cloud-device',0));
  v_cache_key := concat_ws(
    chr(31), 'v2-deepseek-time-pricing', p_user_id::text,
    COALESCE(p_device_id::text, ''),
    to_char(p_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    to_char(p_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    p_trunc, COALESCE(p_tz, ''), COALESCE(p_offset_min::text, '')
  );

  SELECT c.result INTO v_result
  FROM public.tokentracker_account_usage_cache c
  WHERE c.cache_key = v_cache_key
    AND c.fetched_at >= clock_timestamp() - interval '30 seconds';
  IF FOUND THEN RETURN v_result; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_cache_key, 0));
  SELECT c.result INTO v_result
  FROM public.tokentracker_account_usage_cache c
  WHERE c.cache_key = v_cache_key
    AND c.fetched_at >= clock_timestamp() - interval '30 seconds';
  IF FOUND THEN RETURN v_result; END IF;

  v_result := public.account_usage_grouped_v2(
    p_user_id, p_device_id, p_from, p_to, p_trunc, p_tz, p_offset_min
  );

  INSERT INTO public.tokentracker_account_usage_cache AS c (cache_key, fetched_at, result)
  VALUES (v_cache_key, clock_timestamp(), v_result)
  ON CONFLICT (cache_key) DO UPDATE
  SET fetched_at = EXCLUDED.fetched_at, result = EXCLUDED.result;

  IF random() < 0.01 THEN
    WITH stale AS (
      SELECT s.cache_key
      FROM public.tokentracker_account_usage_cache s
      WHERE s.fetched_at < clock_timestamp() - interval '5 minutes'
      ORDER BY s.fetched_at, s.cache_key
      FOR UPDATE SKIP LOCKED
      LIMIT 256
    )
    DELETE FROM public.tokentracker_account_usage_cache c
    USING stale WHERE c.cache_key = stale.cache_key;
  END IF;
  RETURN v_result;
END
$function$;
