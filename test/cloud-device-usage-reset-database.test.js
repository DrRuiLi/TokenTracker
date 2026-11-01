const test = require("node:test");
const { before, after } = test;
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setup, migration } = require("./helpers/cloud-usage-archive-fixture");
let db;
before(async () => {
  // This fixture installs the actual dedup/rollup functions and lifetime
  // triggers, but does not apply the unpublished archive migration.
  db = await setup();
  await db.exec(migration("20261003120000_cloud-subscriptions.sql"));
  await db.exec(migration("20261004120000_cloud-machine-access.sql"));
  await db.exec("ALTER TABLE tokentracker_leaderboard_snapshots ADD COLUMN generated_at timestamptz NOT NULL DEFAULT clock_timestamp(); ALTER TABLE agentmeter_leaderboard_snapshots ADD COLUMN generated_at timestamptz NOT NULL DEFAULT clock_timestamp()");
  await db.exec(migration("20261015120000_cloud-device-usage-reset.sql"));
  await db.exec("INSERT INTO tokentracker_leaderboard_rollup_meta_v2 VALUES(1,'2027-01-01Z','2026-01-01',now())");
});
after(async () => { await db?.close(); });
async function rpc(name, args) {
  return (await db.query(`SELECT ${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) AS result`, args)).rows[0].result;
}
async function user() {
  const id = randomUUID(); await db.query("INSERT INTO auth.users VALUES($1)", [id]); return id;
}
async function issue(id, machine = randomUUID(), environment = "live") {
  const token = randomUUID();
  const result = await rpc("cloud_issue_device_token", [id, environment, "Device " + machine, "web", machine,
    ["Device " + machine], randomUUID(), token, false, null]);
  assert.equal(result.ok, true);
  return { ...result, token, machine };
}
const row = (tokens, hour = "2026-10-01T12:00:00Z", source = "codex") => ({ hour_start: hour, source, model: "gpt-6",
  input_tokens: tokens, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0,
  reasoning_output_tokens: 0, total_tokens: tokens, billable_total_tokens: tokens, total_cost_usd: 0, conversations: 1 });
const ingest = (device, rows) => rpc("cloud_ingest_usage", [device.token, "live", JSON.stringify(rows), "[]", null]);
const reset = (id, device, operation = randomUUID(), environment = "live") => rpc("cloud_reset_device_usage", [id, environment, device.device_id, operation]);
const refresh = (device, operation, environment = "live") => rpc("cloud_refresh_device_usage", [device.token, environment, operation]);
const hourly = async id => (await db.query("SELECT device_id,total_tokens::integer AS tokens FROM tokentracker_hourly WHERE user_id=$1 ORDER BY device_id", [id])).rows;
const total = async id => (await db.query("SELECT coalesce(sum(total_tokens),0)::integer AS n FROM tokentracker_leaderboard_rollup_total_v2 WHERE user_id=$1", [id])).rows[0].n;

test("reset scopes aliases to one user and machine; refresh preserves other devices and shared account sessions", async () => {
  const id = await user(), stranger = await user();
  const a = await issue(id), alias = await issue(id), other = await issue(id), foreign = await issue(stranger);
  await db.query("INSERT INTO tokentracker_device_machine VALUES($1,'same-cluster'),($2,'same-cluster'),($3,'same-cluster')",
    [a.device_id, alias.device_id, foreign.device_id]);
  await ingest(a, [row(10)]); await ingest(alias, [row(20)]); await ingest(other, [row(40)]); await ingest(foreign, [row(80)]);
  await rpc("tokentracker_upsert_account_session_states", [id, JSON.stringify([{ source: "trae-cn", session_id: "shared-session",
    model: "gpt-6", bucket_start: "2026-10-01T12:00:00Z", input_tokens: 100, output_tokens: 0,
    cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 100,
    snapshot_verified_at: "2026-10-15T00:00:00Z" }])]);
  await rpc("leaderboard_rollup_daily_replace_v2", ["2026-10-01Z", "2026-10-02Z"]);
  assert.equal(await total(id), 160); assert.equal(await total(stranger), 80);
  const op = randomUUID(); const result = await reset(id, a, op);
  assert.equal(result.removed_rows, 2); assert.equal(result.status, "reset");
  assert.deepEqual(await hourly(id), [{ device_id: other.device_id, tokens: 40 }]);
  assert.equal((await hourly(stranger))[0].tokens, 80);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_account_session_states WHERE user_id=$1", [id])).rows[0].n, 1);
  assert.equal((await ingest(a, [row(900)])).code, "cloud_device_token_rejected");
  assert.equal((await ingest(alias, [row(900)])).code, "cloud_device_token_rejected");
  assert.equal((await refresh(a, op)).code, "cloud_device_token_rejected");
  assert.equal((await refresh(other, op)).code, "cloud_usage_reset_device_mismatch");
  assert.equal((await refresh(foreign, op)).code, "cloud_usage_reset_operation_not_found");
  const renewed = await issue(id, a.machine);
  await ingest(renewed, [row(5)]);
  assert.deepEqual(await reset(id, a, op), result);
  assert.equal((await reset(id, a)).code, "cloud_usage_reset_in_progress");
  await db.query("INSERT INTO tokentracker_account_usage_cache VALUES($1,now(),'[]'),($2,now(),'[]')",
    ["v2" + String.fromCharCode(31) + id + String.fromCharCode(31) + "range", "v2" + String.fromCharCode(31) + stranger + String.fromCharCode(31) + "range"]);
  for (const table of ["tokentracker_leaderboard_snapshots", "agentmeter_leaderboard_snapshots"]) {
    await db.query(`INSERT INTO ${table}(user_id,period,from_day,to_day,rank,total_tokens) VALUES($1,'total','2026-01-01','2026-10-15',1,160),($2,'total','2026-01-01','2026-10-15',2,80)`, [id, stranger]);
  }
  assert.equal((await refresh(renewed, op)).status, "complete");
  assert.equal(await total(id), 145); assert.equal(await total(stranger), 80);
  for (const table of ["tokentracker_leaderboard_snapshots", "agentmeter_leaderboard_snapshots"]) {
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table} WHERE user_id=$1`, [id])).rows[0].n, 0);
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table} WHERE user_id=$1`, [stranger])).rows[0].n, 1);
  }
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_account_usage_cache WHERE split_part(cache_key,chr(31),2)=$1", [id])).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_account_usage_cache WHERE split_part(cache_key,chr(31),2)=$1", [stranger])).rows[0].n, 1);
  await ingest(renewed, [row(7)]);
  const beforeRetry = await hourly(id);
  assert.equal((await refresh(renewed, op)).status, "complete");
  assert.equal((await reset(id, a, op)).status, "complete");
  assert.deepEqual(await hourly(id), beforeRetry);
  assert.equal(await total(id), 145, "completed refresh does not overwrite later ingest/rollup state");
});

test("refresh includes removed dates and new uploaded dates, including a correction to zero", async () => {
  const id = await user(), a = await issue(id), other = await issue(id);
  await ingest(a, [row(100)]); await ingest(other, [row(20)]);
  await rpc("leaderboard_rollup_daily_replace_v2", ["2026-10-01Z", "2026-10-02Z"]);
  const operation = randomUUID(); await reset(id, a, operation);
  const renewed = await issue(id, a.machine);
  await ingest(renewed, [row(0), row(30, "2026-10-03T00:00:00Z")]);
  assert.equal((await refresh(renewed, operation)).status, "complete");
  assert.equal(await total(id), 50);
  const daily = (await db.query("SELECT day::text,total_tokens::integer AS tokens FROM tokentracker_leaderboard_rollup_daily_v2 WHERE user_id=$1 ORDER BY day", [id])).rows;
  assert.deepEqual(daily, [{ day: "2026-10-01", tokens: 20 }, { day: "2026-10-03", tokens: 30 }]);
});

test("cross-user IDs, reused operation IDs and historical cross-environment tokens fail closed", async () => {
  const id = await user(), stranger = await user(), a = await issue(id), other = await issue(stranger);
  await ingest(a, [row(10)]);
  assert.equal((await reset(stranger, a)).code, "cloud_device_not_found");
  const op = randomUUID(); await reset(id, a, op);
  assert.equal((await reset(stranger, other, op)).code, "cloud_usage_reset_operation_conflict");
  assert.equal((await reset(id, a, op, "sandbox")).code, "cloud_usage_reset_operation_conflict");
  const conflict = await issue(id);
  await ingest(conflict, [row(15)]);
  await db.query("INSERT INTO tokentracker_device_tokens(id,user_id,device_id,token_hash,cloud_environment,revoked_at) VALUES($1,$2,$3,$4,'sandbox',now())",
    [randomUUID(), id, conflict.device_id, randomUUID()]);
  assert.equal((await reset(id, conflict)).code, "cloud_usage_reset_environment_conflict");
  assert.equal((await hourly(id)).find(r => r.device_id === conflict.device_id).tokens, 15);
  assert.equal((await ingest(conflict, [row(16)])).ok, true);
});

test("archive presence rejects reset before token revocation or hourly deletion", async () => {
  const id = await user(), a = await issue(id); await ingest(a, [row(10)]);
  await db.exec("CREATE TABLE tokentracker_usage_archive_manifest(id integer)");
  try { assert.equal((await reset(id, a)).code, "cloud_usage_reset_archive_unsupported"); }
  finally { await db.exec("DROP TABLE tokentracker_usage_archive_manifest"); }
  assert.equal((await hourly(id))[0].tokens, 10);
  assert.equal((await ingest(a, [row(11)])).ok, true);
});

test("a failed reset rolls back token revocation, row deletion and the operation marker", async () => {
  const id = await user(), a = await issue(id), op = randomUUID(); await ingest(a, [row(10)]);
  await db.exec("CREATE FUNCTION fail_reset_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected reset failure'; END $$; CREATE TRIGGER fail_reset AFTER DELETE ON tokentracker_hourly FOR EACH STATEMENT EXECUTE FUNCTION fail_reset_delete()");
  try { await assert.rejects(reset(id, a, op), /injected reset failure/); }
  finally { await db.exec("DROP TRIGGER fail_reset ON tokentracker_hourly; DROP FUNCTION fail_reset_delete()"); }
  assert.equal((await hourly(id))[0].tokens, 10);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_cloud_usage_resets WHERE operation_id=$1", [op])).rows[0].n, 0);
  assert.equal((await ingest(a, [row(11)])).ok, true);
});

test("a failed refresh rolls back both rollup levels and remains retryable", async () => {
  const id = await user(), a = await issue(id), op = randomUUID(); await ingest(a, [row(90)]);
  await rpc("leaderboard_rollup_daily_replace_v2", ["2026-10-01Z", "2026-10-02Z"]);
  await reset(id, a, op); const renewed = await issue(id, a.machine); await ingest(renewed, [row(9)]);
  await db.exec("CREATE FUNCTION fail_refresh_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected refresh failure'; END $$; CREATE TRIGGER fail_refresh AFTER DELETE ON tokentracker_leaderboard_snapshots FOR EACH STATEMENT EXECUTE FUNCTION fail_refresh_delete()");
  try { await assert.rejects(refresh(renewed, op), /injected refresh failure/); }
  finally { await db.exec("DROP TRIGGER fail_refresh ON tokentracker_leaderboard_snapshots; DROP FUNCTION fail_refresh_delete()"); }
  assert.equal(await total(id), 0);
  assert.equal((await db.query("SELECT status FROM tokentracker_cloud_usage_resets WHERE operation_id=$1", [op])).rows[0].status, "reset");
  assert.equal((await refresh(renewed, op)).status, "complete");
  assert.equal(await total(id), 9);
});

test("reset functions and markers are unavailable to low-privilege client roles", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.transaction(async tx => {
      await tx.exec("SET LOCAL ROLE " + role);
      const privileges = (await tx.query(`SELECT
        has_function_privilege(current_user,'cloud_reset_device_usage(uuid,text,uuid,uuid)','EXECUTE') AS reset,
        has_function_privilege(current_user,'cloud_refresh_device_usage(text,text,uuid)','EXECUTE') AS refresh,
        has_table_privilege(current_user,'tokentracker_cloud_usage_resets','SELECT') AS read,
        has_table_privilege(current_user,'tokentracker_cloud_usage_resets','INSERT') AS write`)).rows[0];
      assert.deepEqual(privileges, { reset: false, refresh: false, read: false, write: false });
    });
  }
});

test("canonical dedup pushes the user filter into hourly and account-session scans", async () => {
  const id = randomUUID();
  const explained = (await db.query("EXPLAIN (FORMAT JSON) SELECT * FROM leaderboard_hourly_dedup_v2('2026-10-01Z','2026-10-02Z') WHERE user_id=$1", [id])).rows[0]["QUERY PLAN"];
  const scans = [];
  function visit(node) { if (node["Relation Name"] === "tokentracker_hourly" || node["Relation Name"] === "tokentracker_account_session_states") scans.push(node); for (const child of node.Plans || []) visit(child); }
  visit(explained[0].Plan);
  assert.equal(scans.length, 3);
  for (const scan of scans) assert.match(JSON.stringify(scan), new RegExp(id));
});

test("reset immediately removes stale derived statistics and only the affected user's cached results", async () => {
  const id = await user(), stranger = await user(), a = await issue(id), other = await issue(id), op = randomUUID();
  await ingest(a, [row(100)]); await ingest(other, [row(20)]);
  await rpc("leaderboard_rollup_daily_replace_v2", ["2026-10-01Z", "2026-10-02Z"]);
  await db.query("INSERT INTO tokentracker_account_usage_cache VALUES($1,now(),'[]'),($2,now(),'[]')",
    ["v2" + String.fromCharCode(31) + id + String.fromCharCode(31) + "range", "v2" + String.fromCharCode(31) + stranger + String.fromCharCode(31) + "range"]);
  for (const table of ["tokentracker_leaderboard_snapshots", "agentmeter_leaderboard_snapshots"]) {
    await db.query(`INSERT INTO ${table}(user_id,period,from_day,to_day,rank,total_tokens) VALUES($1,'total','2026-01-01','2026-10-15',1,120),($2,'total','2026-01-01','2026-10-15',2,0)`, [id, stranger]);
  }
  assert.equal((await reset(id, a, op)).ok, true);
  assert.equal(await total(id), 20, "a failed or throttled re-upload cannot leave the original 120-token total visible");
  for (const table of ["tokentracker_leaderboard_snapshots", "agentmeter_leaderboard_snapshots"]) {
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table} WHERE user_id=$1`, [id])).rows[0].n, 0);
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table} WHERE user_id=$1`, [stranger])).rows[0].n, 1);
  }
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_account_usage_cache WHERE split_part(cache_key,chr(31),2)=$1", [id])).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int n FROM tokentracker_account_usage_cache WHERE split_part(cache_key,chr(31),2)=$1", [stranger])).rows[0].n, 1);
  const renewed = await issue(id, a.machine);
  const rows = Array.from({ length: 1001 }, (_, i) => row(1, new Date(Date.UTC(2026, 8, 1) + i * 1800000).toISOString()));
  for (let i = 0; i < rows.length; i += 500) {
    assert.equal((await ingest(renewed, rows.slice(i, i + 500))).ok, true);
    assert.equal((await db.query("SELECT status FROM tokentracker_cloud_usage_resets WHERE operation_id=$1", [op])).rows[0].status, "reset");
  }
  assert.equal((await refresh(renewed, op)).ok, true);
  assert.equal(await total(id), 1021);
});

test("missing rollup metadata and revoked devices fail closed before reset or completion", async () => {
  const id = await user(), a = await issue(id), op = randomUUID(); await ingest(a, [row(10)]);
  await db.exec("UPDATE tokentracker_leaderboard_rollup_meta_v2 SET through=NULL WHERE id=1");
  try { assert.equal((await reset(id, a, op)).code, "cloud_usage_reset_rollup_unavailable"); }
  finally { await db.exec("UPDATE tokentracker_leaderboard_rollup_meta_v2 SET through='2027-01-01Z' WHERE id=1"); }
  assert.equal((await hourly(id))[0].tokens, 10); assert.equal((await ingest(a, [row(11)])).ok, true);
  await reset(id, a, op); const renewed = await issue(id, a.machine);
  await db.query("UPDATE tokentracker_devices SET revoked_at=now() WHERE id=$1", [renewed.device_id]);
  assert.equal((await refresh(renewed, op)).code, "cloud_usage_reset_device_mismatch");
  assert.equal((await db.query("SELECT status FROM tokentracker_cloud_usage_resets WHERE operation_id=$1", [op])).rows[0].status, "reset");
});

test("the derived rebuild helper is unavailable to client roles", async () => {
  for (const role of ["anon", "authenticated"]) {
    const result = (await db.query("SELECT has_function_privilege($1,'cloud_rebuild_device_usage_derived(uuid,date[])','EXECUTE') AS allowed", [role])).rows[0];
    assert.equal(result.allowed, false);
  }
});

test("three years of half-hour history rebuild in one account-scoped scan", async t => {
  const id = await user(), a = await issue(id), other = await issue(id), op = randomUUID();
  await db.query(`INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,output_tokens,
    cached_input_tokens,cache_creation_input_tokens,reasoning_output_tokens,total_tokens,conversations)
    SELECT $1,device_id,'codex','gpt-6',hour,1,0,0,0,0,1,1
    FROM generate_series('2023-01-01Z'::timestamptz,'2025-12-31T23:30:00Z'::timestamptz,interval '30 minutes') hour
    CROSS JOIN (VALUES($2::uuid),($3::uuid)) devices(device_id)`, [id, a.device_id, other.device_id]);
  const count = (await db.query("SELECT count(*)::int n FROM tokentracker_hourly WHERE user_id=$1", [id])).rows[0].n;
  const started = performance.now();
  assert.equal((await reset(id, a, op)).removed_rows, count / 2);
  const resetMs = performance.now() - started;
  assert.equal(await total(id), count / 2);
  const renewed = await issue(id, a.machine); await ingest(renewed, [row(3, "2024-01-01Z")]);
  const refreshStarted = performance.now(); assert.equal((await refresh(renewed, op)).status, "complete");
  assert.equal(await total(id), count / 2 + 3);
  t.diagnostic(`${count} raw rows across 1096 dates; local PGlite reset ${Math.round(resetMs)}ms, refresh ${Math.round(performance.now() - refreshStarted)}ms; hosted latency remains to be measured`);
});

test("derived replacement tolerates a rollup writer recreating a deleted key", async () => {
  const id = await user(), a = await issue(id), other = await issue(id);
  await ingest(a, [row(10)]); await ingest(other, [row(20)]);
  await rpc("leaderboard_rollup_daily_replace_v2", ["2026-10-01Z", "2026-10-02Z"]);
  // Recreate exactly the key a concurrent scheduled writer could insert after
  // the scoped DELETE. This also runs the actual lifetime insert trigger.
  await db.exec(`CREATE FUNCTION recreate_rollup_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO tokentracker_leaderboard_rollup_daily_v2 SELECT * FROM removed_keys;
    RETURN NULL; END $$;
    CREATE TRIGGER recreate_rollup_key AFTER DELETE ON tokentracker_leaderboard_rollup_daily_v2
    REFERENCING OLD TABLE AS removed_keys FOR EACH STATEMENT EXECUTE FUNCTION recreate_rollup_key()`);
  try { assert.equal((await reset(id, a)).ok, true); }
  finally { await db.exec("DROP TRIGGER recreate_rollup_key ON tokentracker_leaderboard_rollup_daily_v2; DROP FUNCTION recreate_rollup_key()"); }
  assert.equal(await total(id), 20);
});

test("late snapshot inserts and updates cannot restore statistics read before reset", async () => {
  const id = await user(), stranger = await user(), a = await issue(id), op = randomUUID();
  await ingest(a, [row(100)]);
  await rpc("leaderboard_rollup_daily_replace_v2", ["2026-10-01Z", "2026-10-02Z"]);
  const oldReadStarted = (await db.query("SELECT clock_timestamp() AS stamp")).rows[0].stamp;
  await reset(id, a, op);
  for (const table of ["tokentracker_leaderboard_snapshots", "agentmeter_leaderboard_snapshots"]) {
    const pending = await db.query(`INSERT INTO ${table}(user_id,period,from_day,to_day,rank,total_tokens,generated_at)
      VALUES($1,'total','2026-01-01','2026-10-15',1,100,clock_timestamp()) RETURNING user_id`, [id]);
    assert.equal(pending.rows.length, 0, "even a newly started writer skips an in-progress reset");
  }
  const renewed = await issue(id, a.machine); await ingest(renewed, [row(5)]); await refresh(renewed, op);
  assert.equal(await total(id), 5);
  for (const table of ["tokentracker_leaderboard_snapshots", "agentmeter_leaderboard_snapshots"]) {
    const late = await db.query(`INSERT INTO ${table}(user_id,period,from_day,to_day,rank,total_tokens,generated_at)
      VALUES($1,'total','2026-01-01','2026-10-15',1,100,$2)
      ON CONFLICT(user_id,period,from_day,to_day) DO UPDATE SET total_tokens=excluded.total_tokens,generated_at=excluded.generated_at
      RETURNING user_id`, [id, oldReadStarted]);
    assert.equal(late.rows.length, 0, "a late writer must not restore its pre-reset 100-token result");
    const fresh = await db.query(`INSERT INTO ${table}(user_id,period,from_day,to_day,rank,total_tokens,generated_at)
      VALUES($1,'total','2026-01-01','2026-10-15',1,5,clock_timestamp()),($2,'total','2026-01-01','2026-10-15',2,7,$3)
      RETURNING user_id`, [id, stranger, oldReadStarted]);
    assert.equal(fresh.rows.length, 2, "fresh snapshots and unrelated users remain writable");
    assert.equal((await db.query(`UPDATE ${table} SET total_tokens=100,generated_at=$2 WHERE user_id=$1 RETURNING user_id`, [id, oldReadStarted])).rows.length, 0);
    assert.equal((await db.query(`SELECT total_tokens::int n FROM ${table} WHERE user_id=$1`, [id])).rows[0].n, 5);
  }
});

test("cache reads and snapshot writes hold shared account locks, while reset holds the same lock exclusively", async () => {
  const id = await user(), a = await issue(id); await ingest(a, [row(10)]);
  const lock = `SELECT mode,granted FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
    AND classid::bigint=((hashtextextended($1||':cloud-device',0)>>32)&4294967295)
    AND objid::bigint=(hashtextextended($1||':cloud-device',0)&4294967295) AND objsubid=1`;
  // Miss and hit must acquire the account lock before reading or computing.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await db.transaction(async tx => {
      await tx.query("SELECT account_usage_grouped_cached($1,NULL,'2026-10-01Z','2026-10-02Z','day','UTC',0)", [id]);
      assert.deepEqual((await tx.query(lock, [id])).rows, [{ mode: "ShareLock", granted: true }]);
    });
  }
  await db.transaction(async tx => {
    await tx.query("INSERT INTO tokentracker_leaderboard_snapshots(user_id,period,from_day,to_day,rank,total_tokens) VALUES($1,'total','2026-01-01','2026-10-15',1,10)", [id]);
    assert.deepEqual((await tx.query(lock, [id])).rows, [{ mode: "ShareLock", granted: true }]);
  });
  await db.transaction(async tx => {
    await tx.query("SELECT cloud_reset_device_usage($1,'live',$2,$3)", [id, a.device_id, randomUUID()]);
    assert.deepEqual((await tx.query(lock, [id])).rows, [{ mode: "ExclusiveLock", granted: true }]);
  });
});

test("snapshot guard uses the user index when completed operations accumulate", async () => {
  const id = await user(), bulkUser = await user(), device = await issue(bulkUser);
  await db.query(`INSERT INTO tokentracker_cloud_usage_resets(operation_id,user_id,environment,device_id,machine_id,device_ids,status,completed_at)
    SELECT gen_random_uuid(),$1,'live',$2,$3,ARRAY[$2::uuid],'complete',clock_timestamp() FROM generate_series(1,10000)`,
  [bulkUser, device.device_id, device.machine_id]);
  await db.exec("ANALYZE tokentracker_cloud_usage_resets");
  const plan = (await db.query(`EXPLAIN(FORMAT JSON) SELECT bool_or(status='reset'),max(greatest(reset_at,completed_at))
    FROM tokentracker_cloud_usage_resets WHERE user_id=$1`, [id])).rows[0]["QUERY PLAN"];
  const text = JSON.stringify(plan);
  assert.match(text, /tokentracker_cloud_usage_resets_user_idx/);
  assert.doesNotMatch(text, /Seq Scan/);
});
