"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const {
  extractCursorAuth,
  fetchCursorSandAccessStatus,
  fetchCursorSandUsageStatus,
} = require("./cursor-config");

function resolveGrokBotQuotaPath(queuePath) {
  return path.join(path.dirname(queuePath), "grok-bot-quota.json");
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

/**
 * Cursor Sand usagePercent → the window the side screen draws.
 * A missing grant or an explicit zero included limit is an empty window.
 * A failed request never reaches this function, so the previous file stays.
 */
function windowFromSandUsage(access, usage) {
  if (!access?.granted || !usage || usage.includedLimitZero === true) return null;
  const usedPercent = clampPercent(usage.usagePercent);
  const resetAt = typeof usage.nextResetAt === "string" ? usage.nextResetAt : "";
  if (usedPercent === null || !resetAt || !Number.isFinite(Date.parse(resetAt))) return null;
  const window = { used_percent: usedPercent, reset_at: resetAt };
  const periodStartMs = Date.parse(usage.currentPeriodStart || "");
  const resetAtMs = Date.parse(resetAt);
  if (Number.isFinite(periodStartMs) && resetAtMs > periodStartMs) {
    window.limit_window_seconds = Math.round((resetAtMs - periodStartMs) / 1000);
  }
  return window;
}

async function writeQuotaFile(filePath, window) {
  const payload = `${JSON.stringify({
    quaternary_window: window,
    fetched_at: new Date().toISOString(),
  })}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, filePath);
}

/**
 * Ask Cursor Sand for the Grok Bot quota percent and store it beside the queue.
 * The side screen reads this file. The official limits cache is left untouched.
 * Network failures keep the previous snapshot.
 */
async function refreshGrokBotQuota({
  queuePath,
  home,
  env,
  fetchImpl,
  extractAuth = extractCursorAuth,
  fetchAccess = fetchCursorSandAccessStatus,
  fetchUsage = fetchCursorSandUsageStatus,
} = {}) {
  const filePath = resolveGrokBotQuotaPath(queuePath);
  const auth = extractAuth({ home, env, trackerDir: path.dirname(queuePath) });
  if (!auth?.accessToken) return { updated: false, reason: "no-cursor-auth" };

  const [access, usage] = await Promise.all([
    fetchAccess({ accessToken: auth.accessToken, fetchImpl }).catch(() => null),
    fetchUsage({ accessToken: auth.accessToken, fetchImpl }).catch(() => null),
  ]);
  if (!usage) return { updated: false, reason: "fetch-failed" };

  const window = windowFromSandUsage(access, usage);
  await writeQuotaFile(filePath, window);
  return { updated: true, window };
}

module.exports = {
  resolveGrokBotQuotaPath,
  windowFromSandUsage,
  refreshGrokBotQuota,
};
