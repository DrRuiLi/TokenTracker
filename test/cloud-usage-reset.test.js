const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { openLock } = require("../src/lib/fs");
const { resetCloudDeviceUsage, finishCloudDeviceUsageReset, readCloudUsageReset, cloudUsageResetBlocksUpload } = require("../src/lib/cloud-usage-reset");
const ownerId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const baseUrl = "https://cloud.example";
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-cloud-reset-"));
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  fs.mkdirSync(trackerDir, { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(trackerDir, "queue.jsonl"), '{"total_tokens":1}\n');
  fs.writeFileSync(path.join(trackerDir, "queue.state.json"), '{"offset":19}');
  fs.writeFileSync(path.join(trackerDir, "upload.throttle.json"), '{}');
  return { trackerDir, ownerId, deviceId, baseUrl, accessToken: "test-access" };
}
const reply = body => new Response(JSON.stringify({ ok: true, status: body.action === "refresh" ? "complete" : "reset", device_id: deviceId, operation_id: body.operation_id }));
const success = async (_url, opts) => reply(JSON.parse(opts.body));
const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, "queue.state.json")));

test("reset holds the sync lease and prepares a private credential-free marker before remote mutation", async t => {
  const f = fixture(t);
  const lock = await openLock(path.join(f.trackerDir, "sync.lock"));
  await assert.rejects(resetCloudDeviceUsage({ ...f, fetchImpl: success }), { code: "cloud_usage_reset_sync_busy" });
  assert.equal(readCloudUsageReset(f.trackerDir), null);
  await lock.release();
  await resetCloudDeviceUsage({ ...f, fetchImpl: async (url, opts) => {
    assert.equal(readCloudUsageReset(f.trackerDir).phase, "prepared");
    assert.equal(cloudUsageResetBlocksUpload(f.trackerDir, f), true);
    assert.equal(await openLock(path.join(f.trackerDir, "sync.lock"), { quietIfLocked: true }), null);
    assert.equal(readState(f.trackerDir).offset, 19);
    return success(url, opts);
  } });
  const raw = fs.readFileSync(path.join(f.trackerDir, "cloud-usage-reset.json"), "utf8");
  assert.equal(raw.includes(f.accessToken), false);
  // Windows stat exposes DOS attributes rather than POSIX permission bits.
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(f.trackerDir, "cloud-usage-reset.json")).mode & 0o777, 0o600);
  }
  assert.equal(readCloudUsageReset(f.trackerDir).phase, "uploading");
  assert.equal(readState(f.trackerDir).offset, 0);
  assert.equal(fs.existsSync(path.join(f.trackerDir, "upload.throttle.json")), false);
  assert.equal(cloudUsageResetBlocksUpload(f.trackerDir, f), false);
  for (const changed of [{ ownerId: otherId }, { baseUrl: "https://other.example" }, { deviceId: otherId }]) {
    assert.equal(cloudUsageResetBlocksUpload(f.trackerDir, { ...f, ...changed }), true);
    await assert.rejects(resetCloudDeviceUsage({ ...f, ...changed, fetchImpl: success }), { code: "cloud_usage_reset_owner_changed" });
  }
  assert.equal(cloudUsageResetBlocksUpload(f.trackerDir, { ownerId, baseUrl }), false);
});

test("uncertain reset retries its operation and never rewinds an uploading checkpoint", async t => {
  const f = fixture(t); let operation;
  await assert.rejects(resetCloudDeviceUsage({ ...f, fetchImpl: async (_url, opts) => {
    operation = JSON.parse(opts.body).operation_id; throw new Error("connection lost after server commit");
  } }), /connection lost/);
  assert.equal(readState(f.trackerDir).offset, 19);
  assert.equal(readCloudUsageReset(f.trackerDir).operationId, operation);
  await resetCloudDeviceUsage({ ...f, fetchImpl: async (url, opts) => {
    assert.equal(JSON.parse(opts.body).operation_id, operation); return success(url, opts);
  } });
  fs.writeFileSync(path.join(f.trackerDir, "queue.state.json"), '{"offset":7}');
  await resetCloudDeviceUsage({ ...f, fetchImpl: () => { assert.fail("upload retry cannot erase cloud again"); } });
  assert.equal(readState(f.trackerDir).offset, 7);
});

test("late session changes retain the prepared operation and checkpoint for owner-safe recovery", async t => {
  const f = fixture(t); let current = true;
  await assert.rejects(resetCloudDeviceUsage({ ...f, isCurrent: () => current, fetchImpl: async (url, opts) => {
    current = false; return success(url, opts);
  } }), { code: "auth_session_changed" });
  assert.equal(readCloudUsageReset(f.trackerDir).phase, "prepared");
  assert.equal(readState(f.trackerDir).offset, 19);
  await resetCloudDeviceUsage({ ...f, fetchImpl: success });
  assert.equal(readState(f.trackerDir).offset, 0);
});

test("only an acknowledged complete queue refreshes; failed refresh remains retryable", async t => {
  const f = fixture(t); await resetCloudDeviceUsage({ ...f, fetchImpl: success });
  const finish = { ...f, deviceToken: "new-device-token", fetchImpl: success };
  assert.equal(await finishCloudDeviceUsageReset(finish), false);
  fs.writeFileSync(path.join(f.trackerDir, "queue.state.json"), JSON.stringify({ offset: fs.statSync(path.join(f.trackerDir, "queue.jsonl")).size }));
  for (const changed of [{ ownerId: otherId }, { baseUrl: "https://other.example" }, { deviceId: otherId }]) {
    assert.equal(await finishCloudDeviceUsageReset({ ...finish, ...changed }), false);
  }
  await assert.rejects(finishCloudDeviceUsageReset({ ...finish, fetchImpl: async () => new Response('{"code":"unavailable"}', { status: 503 }) }), { code: "unavailable" });
  assert.equal(readCloudUsageReset(f.trackerDir).phase, "uploading");
  assert.equal(await finishCloudDeviceUsageReset({ ...finish, deviceId: undefined }), true);
  assert.equal(readCloudUsageReset(f.trackerDir), null);
});

test("rate-limit ambiguity retains prepared marker; definite first auth rejection permits recovery", async t => {
  for (const status of [429, 401]) {
    const f = fixture(t);
    await assert.rejects(resetCloudDeviceUsage({ ...f, fetchImpl: async () => new Response('{"code":"denied"}', { status }) }), { code: "denied" });
    assert.equal(Boolean(readCloudUsageReset(f.trackerDir)), status === 429);
    assert.equal(readState(f.trackerDir).offset, 19);
  }
});

async function listen(t, handler) {
  const errors = [];
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch(error => {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  t.after(() => { if (errors.length) throw errors[0]; });
  return `http://127.0.0.1:${server.address().port}`;
}

test("production loopback handler enforces CSRF, current JWT, lock and reset retry through real HTTP", async t => {
  const f = fixture(t); let remoteResets = 0; let beforeReset = () => {};
  const cloud = await listen(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    res.setHeader("Content-Type", "application/json");
    if (req.url.endsWith("device-token-issue")) { res.end(JSON.stringify({ token: "opaque-device-token", device_id: deviceId })); return; }
    remoteResets += 1; await beforeReset();
    res.end(JSON.stringify({ ok: true, operation_id: data.operation_id, device_id: deviceId, status: "reset" }));
  });
  const anonKey = `e30.${Buffer.from('{"role":"anon"}').toString("base64url")}.sig`;
  fs.writeFileSync(path.join(f.trackerDir, "config.json"), JSON.stringify({ machineId: "machine-test-12345", baseUrl: cloud, anonKey }));
  fs.writeFileSync(path.join(f.trackerDir, "runtime-instance.json"), JSON.stringify({ fingerprint: crypto.createHash("sha256").update(`${cloud}\0${anonKey}`).digest("hex") }));
  fs.writeFileSync(path.join(f.trackerDir, "cloud-sync-pref.json"), '{"enabled":true}');
  const { createLocalApiHandler } = require("../src/lib/local-api");
  const handler = createLocalApiHandler({ queuePath: path.join(f.trackerDir, "queue.jsonl"), trackerDataDir: f.trackerDir });
  const local = await listen(t, (req, res) => handler(req, res, new URL(req.url, local)).catch(() => { res.writeHead(500); res.end(); }));
  const auth = (await (await fetch(`${local}/api/local-auth`)).json()).token;
  const jwt = (sub = ownerId, exp = Date.now() / 1000 + 3600) => `e30.${Buffer.from(JSON.stringify({ sub, exp })).toString("base64url")}.sig`;
  const call = (endpoint, body, accessToken = jwt(), headers = {}) => fetch(local + endpoint, { method: "POST", headers: { "Content-Type": "application/json", "x-tokentracker-local-auth": auth, Authorization: `Bearer ${accessToken}`, ...headers }, body: JSON.stringify(body) });
  const sessionRes = await call("/functions/tokentracker-cloud-session", { expectedOwnerId: ownerId, insforgeBaseUrl: cloud });
  assert.equal(sessionRes.status, 200);
  const session = await sessionRes.json();
  const payload = { expectedOwnerId: ownerId, cloudSessionId: session.session_id };
  const endpoint = "/functions/tokentracker-cloud-usage-reset";
  for (const headers of [{ "x-tokentracker-local-auth": "" }, { origin: "https://foreign.example" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await call(endpoint, payload, jwt(), headers)).status, 401);
  }
  for (const token of [jwt(otherId), jwt(ownerId, 1), "malformed"]) {
    assert.equal((await call(endpoint, payload, token)).status, 401);
  }
  assert.equal(remoteResets, 0);
  const lock = await openLock(path.join(f.trackerDir, "sync.lock"));
  assert.equal((await call(endpoint, payload)).status, 409); await lock.release();
  const now = Date.now;
  beforeReset = () => { Date.now = () => now() + 2 * 3600_000; };
  try {
    assert.equal((await call(endpoint, payload)).status, 409);
    assert.equal(readState(f.trackerDir).offset, 19);
    assert.equal(readCloudUsageReset(f.trackerDir).phase, "prepared");
  } finally { Date.now = now; }
  let release, started;
  const seen = new Promise(resolve => { started = resolve; });
  beforeReset = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const pending = call(endpoint, payload);
  await seen;
  assert.equal(readCloudUsageReset(f.trackerDir).phase, "prepared");
  const clear = await call("/functions/tokentracker-cloud-session", { clear: true, session_id: session.session_id });
  assert.equal(clear.status, 200); release();
  assert.equal((await pending).status, 409);
  assert.equal(readState(f.trackerDir).offset, 19);
  const op = readCloudUsageReset(f.trackerDir).operationId;
  beforeReset = () => {};
  const retrySession = await (await call("/functions/tokentracker-cloud-session", { expectedOwnerId: ownerId, insforgeBaseUrl: cloud })).json();
  const retried = await call(endpoint, { ...payload, cloudSessionId: retrySession.session_id });
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).pending, true);
  assert.equal(readCloudUsageReset(f.trackerDir).operationId, op);
  assert.equal(readState(f.trackerDir).offset, 0);
  assert.equal(remoteResets, 3);
  assert.equal((await (await fetch(local + endpoint, { headers: { "x-tokentracker-local-auth": auth } })).json()).pending, true);
  fs.writeFileSync(path.join(f.trackerDir, "queue.state.json"), '{"offset":7}');
  const otherSession = await (await call("/functions/tokentracker-cloud-session", { expectedOwnerId: otherId, insforgeBaseUrl: cloud }, jwt(otherId))).json();
  const switched = await call("/functions/tokentracker-local-sync", { cloudSessionId: otherSession.session_id, expectedOwnerId: otherId, drain: true }, jwt(otherId));
  assert.equal(switched.status, 409);
  assert.equal((await switched.json()).code, "cloud_usage_reset_owner_changed");
  assert.equal(readState(f.trackerDir).offset, 7);
});

test("real loopback reset and spawned production sync drain replay fully before refresh, recovering from ingest failure", async t => {
  const f = fixture(t);
  const home = path.dirname(path.dirname(f.trackerDir));
  const queuePath = path.join(f.trackerDir, "queue.jsonl");
  const { defaultSeedPath } = require("../src/lib/machine-id");
  assert.equal(defaultSeedPath(queuePath), path.join(home, ".config", "tokentracker", "machine-id"));
  const savedEnv = Object.fromEntries(["HOME", "USERPROFILE", "TOKENTRACKER_NO_TELEMETRY"].map(key => [key, process.env[key]]));
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.TOKENTRACKER_NO_TELEMETRY = "1";
  t.after(() => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const row = { source: "cloud-reset-test", model: "claude-sonnet-4-6", hour_start: "2026-10-01T10:00:00Z", input_tokens: 10, output_tokens: 2, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 12 };
  fs.writeFileSync(queuePath, JSON.stringify(row) + "\n");
  const events = []; let issue = 0; let failIngest = true;
  const cloud = await listen(t, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    if (req.url.endsWith("device-token-issue")) {
      issue += 1; events.push("issue");
      res.end(JSON.stringify({ token: `opaque-device-${issue}`, device_id: deviceId })); return;
    }
    if (req.url.endsWith("tokentracker-ingest")) {
      assert.equal(req.headers.authorization, "Bearer opaque-device-2");
      assert.deepEqual(data.hourly, [row]);
      events.push(failIngest ? "ingest-failed" : "ingest-ack");
      if (failIngest) { res.writeHead(503); res.end('{"code":"test_ingest_unavailable"}'); return; }
      res.end('{"ok":true,"inserted":1,"skipped":0}'); return;
    }
    assert.equal(req.url.endsWith("tokentracker-device-usage-reset"), true);
    if (data.action === "refresh") {
      assert.equal(readState(f.trackerDir).offset, fs.statSync(queuePath).size);
      assert.equal(events.at(-1), "ingest-ack", JSON.stringify({ events, queue: fs.readFileSync(queuePath,"utf8"), state: readState(f.trackerDir) }));
    }
    events.push(data.action);
    res.end(JSON.stringify({ ok: true, operation_id: data.operation_id, device_id: deviceId, status: data.action === "reset" ? "reset" : "complete" }));
  });
  const anonKey = `e30.${Buffer.from('{"role":"anon"}').toString("base64url")}.sig`;
  fs.writeFileSync(path.join(f.trackerDir, "config.json"), JSON.stringify({ machineId: "machine-sandbox-12345", baseUrl: cloud, anonKey }));
  fs.writeFileSync(path.join(f.trackerDir, "runtime-instance.json"), JSON.stringify({ fingerprint: crypto.createHash("sha256").update(`${cloud}\0${anonKey}`).digest("hex") }));
  fs.writeFileSync(path.join(f.trackerDir, "cloud-sync-pref.json"), '{"enabled":true}');
  const { createLocalApiHandler } = require("../src/lib/local-api");
  const handler = createLocalApiHandler({ queuePath, trackerDataDir: f.trackerDir, syncContext: { home, scanSources: [] } });
  const local = await listen(t, (req, res) => handler(req, res, new URL(req.url, local)).catch(() => { res.writeHead(500); res.end(); }));
  const auth = (await (await fetch(`${local}/api/local-auth`)).json()).token;
  const accessToken = `e30.${Buffer.from(JSON.stringify({ sub: ownerId, exp: Date.now() / 1000 + 3600 })).toString("base64url")}.sig`;
  const call = (endpoint, body) => fetch(local + endpoint, { method: "POST", headers: { "Content-Type": "application/json", "x-tokentracker-local-auth": auth, Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(body) });
  const issueSession = async () => {
    const response = await call("/functions/tokentracker-cloud-session", { expectedOwnerId: ownerId, insforgeBaseUrl: cloud });
    assert.equal(response.status, 200); return response.json();
  };
  const oldSession = await issueSession();
  assert.equal((await call("/functions/tokentracker-cloud-usage-reset", { cloudSessionId: oldSession.session_id, expectedOwnerId: ownerId })).status, 200);
  assert.equal(readState(f.trackerDir).offset, 0);
  const session = await issueSession();
  const uploadBody = { cloudSessionId: session.session_id, expectedOwnerId: ownerId, drain: true, recheckCloudAccess: true };
  const failed = await call("/functions/tokentracker-local-sync", uploadBody);
  assert.equal(failed.status, 503);
  assert.equal(readCloudUsageReset(f.trackerDir).phase, "uploading");
  assert.equal(readState(f.trackerDir).offset, 0);
  assert.equal(events.includes("refresh"), false);
  failIngest = false;
  const completed = await call("/functions/tokentracker-local-sync", uploadBody);
  const completedBody = await completed.json();
  assert.equal(completed.status, 200, completedBody.code);
  assert.equal(completedBody.pending, false);
  assert.equal(completedBody.uploaded, true);
  assert.equal(readCloudUsageReset(f.trackerDir), null);
  assert.deepEqual(events, ["issue", "reset", "issue", "ingest-failed", "ingest-ack", "refresh"]);
  assert.equal(fs.readFileSync(path.join(home, ".config", "tokentracker", "machine-id"), "utf8").trim(), "machine-sandbox-12345");
});
