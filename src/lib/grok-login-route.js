"use strict";

const path = require("node:path");

const {
  GrokBillingError,
  getGrokBillingRefreshState,
  openGrokLogin,
  resolveEdgeProfileDir,
} = require("./grok-billing-export");
const {
  DEFAULT_GROK_BILLING_REFRESH_INTERVAL_SECONDS,
  MAX_GROK_BILLING_REFRESH_INTERVAL_SECONDS,
  MIN_GROK_BILLING_REFRESH_INTERVAL_SECONDS,
  readGrokBillingRefreshIntervalSeconds,
  writeGrokBillingRefreshIntervalSeconds,
} = require("./grok-billing-prefs");
const { rescheduleGrokBillingRefresh } = require("./grok-billing-scheduler");
const { grokComSignedIn } = require("./grok-login-status");

const ROUTE = "/api/grok-x-login";

function json(res, data, status) {
  res.writeHead(status || 200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req, maxBytes = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("payload_too_large");
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function loginStatus(queuePath, { signedInProbe = grokComSignedIn } = {}) {
  const trackerDir = path.dirname(queuePath);
  const profile = resolveEdgeProfileDir(queuePath);
  const cookies = profile
    ? path.join(profile, "Default", "Network", "Cookies")
    : null;
  const present = cookies ? await signedInProbe(cookies) : false;
  return {
    ok: true,
    platform: process.platform,
    signedIn: present === true,
    uncertain: present === null,
    refreshIntervalSeconds: readGrokBillingRefreshIntervalSeconds(trackerDir),
    refreshIntervalMinSeconds: MIN_GROK_BILLING_REFRESH_INTERVAL_SECONDS,
    refreshIntervalMaxSeconds: MAX_GROK_BILLING_REFRESH_INTERVAL_SECONDS,
    defaultRefreshIntervalSeconds: DEFAULT_GROK_BILLING_REFRESH_INTERVAL_SECONDS,
    billing: getGrokBillingRefreshState(queuePath),
  };
}

/**
 * Local-dashboard route for the X-subscription Edge login window.
 * Returns true when this request was handled.
 */
async function handleGrokLoginRoute(req, res, url, { queuePath, isAuthorized, openLogin = openGrokLogin, signedInProbe } = {}) {
  if (!url || url.pathname !== ROUTE) return false;
  const method = String(req.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-tokentracker-local-auth",
      "Cache-Control": "no-store",
    });
    res.end();
    return true;
  }
  if (typeof isAuthorized !== "function" || !isAuthorized(req)) {
    json(res, { ok: false, error: "unauthorized" }, 401);
    return true;
  }
  if (method === "GET") {
    json(res, await loginStatus(queuePath, { signedInProbe }));
    return true;
  }
  if (method === "PUT") {
    try {
      const body = await readJsonBody(req);
      const trackerDir = path.dirname(queuePath);
      const refreshIntervalSeconds = writeGrokBillingRefreshIntervalSeconds(
        trackerDir,
        body?.refreshIntervalSeconds,
      );
      rescheduleGrokBillingRefresh();
      json(res, {
        ok: true,
        refreshIntervalSeconds,
        ...(await loginStatus(queuePath, { signedInProbe })),
      });
    } catch (error) {
      const status = error?.message === "payload_too_large" ? 413 : 400;
      json(res, { ok: false, error: error?.message || "invalid_pref" }, status);
    }
    return true;
  }
  if (method !== "POST") {
    json(res, { ok: false, error: "Method Not Allowed" }, 405);
    return true;
  }
  try {
    await openLogin({ queuePath });
    json(res, { ok: true, opened: true, ...(await loginStatus(queuePath, { signedInProbe })) });
  } catch (error) {
    const status = error instanceof GrokBillingError ? 400 : 500;
    json(res, { ok: false, error: error?.message || "login_failed" }, status);
  }
  return true;
}

module.exports = {
  GROK_LOGIN_ROUTE: ROUTE,
  handleGrokLoginRoute,
  loginStatus,
};
