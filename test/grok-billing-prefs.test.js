const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  DEFAULT_GROK_BILLING_REFRESH_INTERVAL_SECONDS,
  MAX_GROK_BILLING_REFRESH_INTERVAL_SECONDS,
  MIN_GROK_BILLING_REFRESH_INTERVAL_SECONDS,
  readGrokBillingRefreshIntervalSeconds,
  writeGrokBillingRefreshIntervalSeconds,
} = require("../src/lib/grok-billing-prefs");

test("grok billing refresh pref defaults to five minutes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-pref-"));
  assert.equal(readGrokBillingRefreshIntervalSeconds(dir), DEFAULT_GROK_BILLING_REFRESH_INTERVAL_SECONDS);
  assert.equal(DEFAULT_GROK_BILLING_REFRESH_INTERVAL_SECONDS, 300);
});

test("grok billing refresh pref persists arbitrary seconds in range", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-pref-"));
  assert.equal(writeGrokBillingRefreshIntervalSeconds(dir, 240), 240);
  assert.equal(readGrokBillingRefreshIntervalSeconds(dir), 240);
});

test("grok billing refresh pref rejects out-of-range writes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-pref-"));
  assert.throws(
    () => writeGrokBillingRefreshIntervalSeconds(dir, MIN_GROK_BILLING_REFRESH_INTERVAL_SECONDS - 1),
    /refresh_interval_out_of_range/,
  );
  assert.throws(
    () => writeGrokBillingRefreshIntervalSeconds(dir, MAX_GROK_BILLING_REFRESH_INTERVAL_SECONDS + 1),
    /refresh_interval_out_of_range/,
  );
});

test("grok billing refresh pref clamps corrupt stored values on read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-pref-"));
  fs.writeFileSync(
    path.join(dir, "grok-billing-pref.json"),
    JSON.stringify({ refreshIntervalSeconds: 10 }),
  );
  assert.equal(readGrokBillingRefreshIntervalSeconds(dir), MIN_GROK_BILLING_REFRESH_INTERVAL_SECONDS);
});
