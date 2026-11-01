const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");
const usagePoller = fs.readFileSync(
  path.join(repoRoot, "TokenTrackerWin/UsagePoller.cs"),
  "utf8",
);

test("Windows tray and pet use dashboard display-token precedence (#451)", () => {
  assert.match(
    usagePoller,
    /var hasBillable = TryGetLong\(totals, "billable_total_tokens", out var billable\);[\s\S]*if \(hasBillable && billable > 0\) return billable;[\s\S]*if \(hasTotal && total > 0\) return total;/,
    "positive billable totals must win, with positive raw totals as the fallback",
  );
  assert.match(
    usagePoller,
    /long tokens = ResolveDisplayTokens\(totals\);/,
    "today's Windows tray/pet total must use the shared display-token policy",
  );
  assert.doesNotMatch(
    usagePoller,
    /GetLong\([^\n]+, "billable_total_tokens"\)/,
    "rolling and top-model token displays must not bypass the fallback policy",
  );
});
