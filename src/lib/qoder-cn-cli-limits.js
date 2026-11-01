"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const OPEN_API = "https://openapi.qoder.com.cn";

async function readQoderCnCliCredentials({ home = os.homedir(), env = process.env } = {}) {
  const root = typeof env.QODERCN_CONFIG_DIR === "string" && env.QODERCN_CONFIG_DIR.trim()
    ? path.resolve(env.QODERCN_CONFIG_DIR.trim())
    : path.join(home, ".qoder-cn");
  try {
    const [encrypted, machineId] = await Promise.all([
      fs.readFile(path.join(root, ".auth", "user"), "utf8"),
      fs.readFile(path.join(root, ".auth", "machine_id"), "utf8"),
    ]);
    // Verified against the official CLI 1.1.68 WASM credential-storage codec.
    const key = Buffer.from(machineId.trim().slice(0, 16), "utf8");
    if (key.length !== 16) return null;
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, key);
    const user = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(encrypted.trim(), "base64")),
      decipher.final(),
    ]).toString("utf8"));
    const token = user.security_oauth_token || user.access_token;
    if (typeof token !== "string" || !token.trim()) return null;
    return { token, organizationId: user.organization_id || null };
  } catch (_error) {
    return null;
  }
}

function cnAuthError() {
  const error = new Error("Qoder CN login expired. Sign in to Qoder CN CLI again.");
  error.code = "AUTH_EXPIRED";
  return error;
}

async function cnRequest(url, options, fetchImpl, { tokenExchange = false } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (_error) {
    throw new Error("Qoder CN usage request failed.");
  }
  if (response.status === 401 || response.status === 403 || (tokenExchange && response.status === 400)) throw cnAuthError();
  if (!response.ok) throw new Error(`Qoder CN API returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch (_error) {
    throw new Error("Qoder CN API returned invalid JSON.");
  }
}

function normalizeQoderCnCliUsage(response, normalizeRpcUsage) {
  const usage = response?.displayMode === "qoder" ? response.qoderUsage : response;
  const rawQuota = usage?.userQuota ?? usage?.user_quota;
  const addOnQuota = usage?.addOnQuota ?? usage?.add_on_quota;
  if ((!rawQuota || typeof rawQuota !== "object") && !addOnQuota) {
    throw new Error("Qoder CN usage response is missing the plan quota.");
  }
  const total = Number(rawQuota?.total);
  const used = Number(rawQuota?.used);
  const remaining = rawQuota?.remaining == null ? Math.max(0, total - used) : Number(rawQuota.remaining);
  if (rawQuota && (rawQuota.total == null || rawQuota.used == null
    || ![total, used, remaining].every(Number.isFinite) || Math.min(total, used, remaining) < 0
    || (total === 0 && (used !== 0 || remaining !== 0)))) {
    throw new Error("Qoder CN usage response has invalid quota values.");
  }
  // The OpenAPI returns fractions; the old desktop IPC already returns percents.
  const result = normalizeRpcUsage({
    userType: usage.userType ?? usage.user_type,
    expiresAt: usage.expiresAt ?? usage.expires_at,
    isQuotaExceeded: usage.isQuotaExceeded ?? usage.is_quota_exceeded,
    userQuota: rawQuota ? { used, total, remaining, unit: rawQuota.unit } : null,
    addOnQuota,
  });
  result.source = "cli-api";
  return result;
}

async function fetchQoderCnCliLimits({
  home = os.homedir(),
  env = process.env,
  fetchImpl = fetch,
  normalizeRpcUsage,
} = {}) {
  const pat = typeof env.QODERCN_PERSONAL_ACCESS_TOKEN === "string"
    ? env.QODERCN_PERSONAL_ACCESS_TOKEN.trim()
    : "";
  let credentials;
  if (pat) {
    const exchanged = await cnRequest(`${OPEN_API}/api/v1/jobToken/exchange`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ personal_token: pat }),
    }, fetchImpl, { tokenExchange: true });
    const token = exchanged?.token || exchanged?.device_token || exchanged?.access_token;
    if (typeof token !== "string" || !token.trim()) throw cnAuthError();
    credentials = { token };
  } else {
    credentials = await readQoderCnCliCredentials({ home, env });
  }
  if (!credentials) return null;
  const endpoint = credentials.organizationId ? "/sash/api/v2/me/usage" : "/api/v2/quota/usage";
  const response = await cnRequest(`${OPEN_API}${endpoint}`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${credentials.token}` },
  }, fetchImpl);
  return normalizeQoderCnCliUsage(response, normalizeRpcUsage);
}

module.exports = { readQoderCnCliCredentials, normalizeQoderCnCliUsage, fetchQoderCnCliLimits };
