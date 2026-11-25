const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  refreshGrokBotQuota,
  resolveGrokBotQuotaPath,
  windowFromSandUsage,
} = require("../src/lib/grok-bot-quota");

const RESET = "2026-11-08T03:09:14.090Z";
const START = "2026-11-01T03:09:14.090Z";

function tempQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-bot-quota-"));
  return path.join(dir, "queue.jsonl");
}

test("sand usage becomes a side-screen window", () => {
  const window = windowFromSandUsage(
    { granted: true },
    { usagePercent: 57.84, nextResetAt: RESET, currentPeriodStart: START },
  );
  assert.equal(window.used_percent, 57.84);
  assert.equal(window.reset_at, RESET);
  assert.equal(window.limit_window_seconds, 7 * 24 * 3600);
});

test("a missing grant or zero included limit clears the window", () => {
  const usage = { usagePercent: 40, nextResetAt: RESET };
  assert.equal(windowFromSandUsage({ granted: false }, usage), null);
  assert.equal(windowFromSandUsage({ granted: true }, { ...usage, includedLimitZero: true }), null);
  assert.equal(windowFromSandUsage({ granted: true }, { usagePercent: 40 }), null);
});

test("billing-cycle refresh writes the sand percent beside the queue", async () => {
  const queuePath = tempQueue();
  const result = await refreshGrokBotQuota({
    queuePath,
    extractAuth: () => ({ accessToken: "cursor-token" }),
    fetchAccess: async ({ accessToken }) => {
      assert.equal(accessToken, "cursor-token");
      return { granted: true };
    },
    fetchUsage: async () => ({
      usagePercent: 12.5,
      nextResetAt: RESET,
      currentPeriodStart: START,
    }),
  });
  assert.equal(result.updated, true);
  assert.equal(result.window.used_percent, 12.5);
  const stored = JSON.parse(fs.readFileSync(resolveGrokBotQuotaPath(queuePath), "utf8"));
  assert.equal(stored.quaternary_window.used_percent, 12.5);
  assert.equal(stored.quaternary_window.reset_at, RESET);
  assert.equal("accessToken" in stored, false);
});

test("a failed sand read keeps the previous percent", async () => {
  const queuePath = tempQueue();
  const filePath = resolveGrokBotQuotaPath(queuePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{\"quaternary_window\":{\"used_percent\":8,\"reset_at\":\"2026-11-08T03:09:14.090Z\"}}\n");
  const result = await refreshGrokBotQuota({
    queuePath,
    extractAuth: () => ({ accessToken: "cursor-token" }),
    fetchAccess: async () => { throw new Error("down"); },
    fetchUsage: async () => { throw new Error("down"); },
  });
  assert.deepEqual(result, { updated: false, reason: "fetch-failed" });
  const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(stored.quaternary_window.used_percent, 8);
});

test("no cursor token skips the sand call", async () => {
  const queuePath = tempQueue();
  let called = false;
  const result = await refreshGrokBotQuota({
    queuePath,
    extractAuth: () => null,
    fetchUsage: async () => { called = true; return null; },
  });
  assert.equal(result.reason, "no-cursor-auth");
  assert.equal(called, false);
  assert.equal(fs.existsSync(resolveGrokBotQuotaPath(queuePath)), false);
});
