const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { openLock, writeFileAtomic } = require("./fs");
const { functionUrlFor, fetchFunctionResponse } = require("./function-url");

const MARKER = "cloud-usage-reset.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failure = (code, status = 409) => Object.assign(new Error(code), { code, status });
const sameBase = (a, b) => String(a).replace(/\/$/, "") === String(b).replace(/\/$/, "");

function readCloudUsageReset(trackerDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(trackerDir, MARKER), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  let value;
  try { value = JSON.parse(raw); } catch { throw failure("cloud_usage_reset_invalid_state"); }
  if (value?.version !== 1 || !UUID.test(value.operationId) || !UUID.test(value.deviceId) ||
      !UUID.test(value.ownerId) || !/^https?:\/\//.test(value.baseUrl || "") ||
      !["prepared", "uploading"].includes(value.phase)) throw failure("cloud_usage_reset_invalid_state");
  return value;
}

function cloudUsageResetBlocksUpload(trackerDir, { ownerId, baseUrl, deviceId } = {}) {
  try {
    const marker = readCloudUsageReset(trackerDir);
    return Boolean(marker && (marker.phase === "prepared" || marker.ownerId !== ownerId ||
      !sameBase(marker.baseUrl, baseUrl) || (deviceId && marker.deviceId !== deviceId)));
  }
  catch { return true; }
}

async function writeMarker(trackerDir, marker) {
  await writeFileAtomic(path.join(trackerDir, MARKER), JSON.stringify(marker) + "\n", { mode: 0o600 });
}

async function requestReset({ baseUrl, anonKey, authorization, body, fetchImpl = fetchFunctionResponse }) {
  const response = await fetchImpl(functionUrlFor(baseUrl, "tokentracker-device-usage-reset"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${authorization}`,
      ...(anonKey ? { apikey: anonKey } : {}) },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) throw failure(data.code || "cloud_usage_reset_failed", response.status || 502);
  if (data.operation_id !== body.operation_id) throw failure("cloud_usage_reset_invalid_response", 502);
  return data;
}

// Called only after the local bridge has bound the JWT to its current device.
// The marker precedes the remote mutation: an interrupted request must retry the
// same operation, never clear already-replayed history a second time.
async function resetCloudDeviceUsage({ trackerDir, ownerId, deviceId, baseUrl, anonKey, accessToken,
  isCurrent = () => true, fetchImpl }) {
  if (!UUID.test(ownerId) || !UUID.test(deviceId) || !accessToken) throw failure("auth_required", 401);
  const lock = await openLock(path.join(trackerDir, "sync.lock"), { quietIfLocked: true });
  if (!lock) throw failure("cloud_usage_reset_sync_busy");
  try {
    if (!isCurrent()) throw failure("auth_session_changed");
    let marker = readCloudUsageReset(trackerDir);
    const newOperation = !marker;
    if (marker && (marker.ownerId !== ownerId || marker.deviceId !== deviceId || !sameBase(marker.baseUrl, baseUrl))) {
      throw failure("cloud_usage_reset_owner_changed");
    }
    if (marker?.phase === "uploading") return { ok: true, operation_id: marker.operationId, status: "uploading" };
    if (!marker) {
      marker = { version: 1, operationId: crypto.randomUUID(), ownerId, deviceId, baseUrl, phase: "prepared" };
      await writeMarker(trackerDir, marker);
    }
    if (!isCurrent()) throw failure("auth_session_changed");
    const result = await requestReset({ baseUrl, anonKey, authorization: accessToken, fetchImpl,
      body: { action: "reset", device_id: deviceId, operation_id: marker.operationId } }).catch(async error => {
      // A definitive first-request rejection did not erase anything. Unknown
      // outcomes and retries retain their operation so they cannot erase twice.
      if (newOperation && [400, 401, 403, 404, 409, 422].includes(error.status)) {
        await fsp.unlink(path.join(trackerDir, MARKER));
      }
      throw error;
    });
    if (result.device_id !== deviceId || !["reset", "complete"].includes(result.status)) {
      throw failure("cloud_usage_reset_invalid_response", 502);
    }
    if (!isCurrent()) throw failure("auth_session_changed");
    await writeFileAtomic(path.join(trackerDir, "queue.state.json"),
      JSON.stringify({ offset: 0, updatedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
    await fsp.unlink(path.join(trackerDir, "upload.throttle.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
    marker.phase = "uploading";
    await writeMarker(trackerDir, marker);
    return { ...result, status: "uploading" };
  } finally { await lock.release(); }
}

// sync owns sync.lock here. Only its fully acknowledged queue can finish the
// operation; a partial batch/checkpoint or another account leaves it pending.
async function finishCloudDeviceUsageReset({ trackerDir, ownerId, deviceId, baseUrl, anonKey, deviceToken, fetchImpl }) {
  const marker = readCloudUsageReset(trackerDir);
  if (!marker || marker.phase !== "uploading" || marker.ownerId !== ownerId || (deviceId && marker.deviceId !== deviceId) || !sameBase(marker.baseUrl, baseUrl)) return false;
  if (!deviceToken) return false;
  const queuePath = path.join(trackerDir, "queue.jsonl");
  const size = await fsp.stat(queuePath).then(stat => stat.size).catch(error => { if (error.code === "ENOENT") return 0; throw error; });
  let offset;
  try { offset = JSON.parse(await fsp.readFile(path.join(trackerDir, "queue.state.json"), "utf8")).offset; }
  catch { throw failure("cloud_usage_reset_invalid_offset"); }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw failure("cloud_usage_reset_invalid_offset");
  if (offset !== size) return false;
  const result = await requestReset({ baseUrl, anonKey, authorization: deviceToken, fetchImpl,
    body: { action: "refresh", operation_id: marker.operationId } });
  if (result.status !== "complete" || result.device_id !== marker.deviceId) throw failure("cloud_usage_reset_invalid_response", 502);
  await fsp.unlink(path.join(trackerDir, MARKER));
  return true;
}

module.exports = { readCloudUsageReset, cloudUsageResetBlocksUpload, resetCloudDeviceUsage, finishCloudDeviceUsageReset };
