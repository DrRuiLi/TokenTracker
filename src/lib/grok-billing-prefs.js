"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MIN_GROK_BILLING_REFRESH_INTERVAL_SECONDS = 60;
const MAX_GROK_BILLING_REFRESH_INTERVAL_SECONDS = 86_400;
const DEFAULT_GROK_BILLING_REFRESH_INTERVAL_SECONDS = 300;

function grokBillingPrefPath(trackerDir) {
  return path.join(trackerDir, "grok-billing-pref.json");
}

function normalizeGrokBillingRefreshIntervalSeconds(value, { clamp = true } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    if (clamp) return DEFAULT_GROK_BILLING_REFRESH_INTERVAL_SECONDS;
    throw new Error("refresh_interval_invalid");
  }
  const rounded = Math.round(n);
  if (rounded < MIN_GROK_BILLING_REFRESH_INTERVAL_SECONDS ||
      rounded > MAX_GROK_BILLING_REFRESH_INTERVAL_SECONDS) {
    if (clamp) {
      if (rounded < MIN_GROK_BILLING_REFRESH_INTERVAL_SECONDS) {
        return MIN_GROK_BILLING_REFRESH_INTERVAL_SECONDS;
      }
      if (rounded > MAX_GROK_BILLING_REFRESH_INTERVAL_SECONDS) {
        return MAX_GROK_BILLING_REFRESH_INTERVAL_SECONDS;
      }
    }
    throw new Error("refresh_interval_out_of_range");
  }
  return rounded;
}

function readGrokBillingRefreshIntervalSeconds(trackerDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(grokBillingPrefPath(trackerDir), "utf8"));
    return normalizeGrokBillingRefreshIntervalSeconds(raw?.refreshIntervalSeconds, { clamp: true });
  } catch {
    return DEFAULT_GROK_BILLING_REFRESH_INTERVAL_SECONDS;
  }
}

function readGrokBillingRefreshIntervalMs(trackerDir) {
  return readGrokBillingRefreshIntervalSeconds(trackerDir) * 1000;
}

function writeGrokBillingRefreshIntervalSeconds(trackerDir, seconds) {
  const refreshIntervalSeconds = normalizeGrokBillingRefreshIntervalSeconds(seconds, { clamp: false });
  if (!fs.existsSync(trackerDir)) fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(
    grokBillingPrefPath(trackerDir),
    JSON.stringify({
      refreshIntervalSeconds,
      updatedAt: new Date().toISOString(),
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return refreshIntervalSeconds;
}

module.exports = {
  MIN_GROK_BILLING_REFRESH_INTERVAL_SECONDS,
  MAX_GROK_BILLING_REFRESH_INTERVAL_SECONDS,
  DEFAULT_GROK_BILLING_REFRESH_INTERVAL_SECONDS,
  normalizeGrokBillingRefreshIntervalSeconds,
  readGrokBillingRefreshIntervalSeconds,
  readGrokBillingRefreshIntervalMs,
  writeGrokBillingRefreshIntervalSeconds,
};
