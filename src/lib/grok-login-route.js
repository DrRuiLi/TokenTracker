"use strict";

const path = require("node:path");

const {
  GrokBillingError,
  openGrokLogin,
  resolveEdgeProfileDir,
} = require("./grok-billing-export");
const { grokComSignedIn } = require("./grok-login-status");

const ROUTE = "/api/grok-x-login";

function json(res, data, status) {
  res.writeHead(status || 200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function loginStatus(queuePath, { signedInProbe = grokComSignedIn } = {}) {
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
