const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  billingDownloadArgs,
  eventsFromCsvText,
  isBillingDownloadCommand,
  isHeadlessCommand,
  mergeStore,
  resolveGrokBillingPath,
  usageTokens,
} = require("../src/lib/grok-billing-export");

test("isHeadlessCommand tells a billing download apart from the login window", () => {
  assert.equal(isHeadlessCommand("msedge.exe --headless=new --user-data-dir=C:\\p"), true);
  assert.equal(isHeadlessCommand("msedge.exe --user-data-dir=C:\\p https://grok.com/dashboard/usage"), false);
});

test("billing download uses a real off-screen Edge, not headless mode", () => {
  const args = billingDownloadArgs("C:\\profile", "https://grok.com/dashboard/api/export");
  assert.equal(args.some((arg) => arg.includes("--headless")), false);
  assert.ok(args.includes("--window-position=-32000,-32000"));
  assert.equal(isBillingDownloadCommand(args.join(" ")), true);
  assert.equal(
    isBillingDownloadCommand("msedge.exe --user-data-dir=C:\\p https://grok.com/dashboard/usage"),
    false,
  );
});
test("usageTokens sums Grok billing usage JSON", () => {
  const raw = JSON.stringify({
    "prompt-text-tokens": 10,
    "completion-text-tokens": 5,
    "cached-prompt-text-tokens": 3,
    "cache-write-text-tokens": 2,
  });
  assert.equal(usageTokens(raw), 20);
});

test("eventsFromCsvText strips PII and parses rows", () => {
  const usage = JSON.stringify({
    "prompt-text-tokens": 7,
    "completion-text-tokens": 1,
  });
  const header =
    "Billing Item ID,Event Time,Product,Charge Category,Usage Type," +
    "Principal Type,Principal ID,Usage,Pricing Currency,Pricing Contracted,Model,User Email";
  const escapedUsage = usage.replace(/"/g, '""');
  const csv = [
    header,
    `id1,2026-11-01T02:00:00.000Z,cursor,usage,included,user,secret,"${escapedUsage}",USD,0,auto,hidden@example.com`,
  ].join("\n");
  const events = eventsFromCsvText(csv);
  assert.equal(events.length, 1);
  assert.equal(events[0].tokens, 8);
  assert.equal(events[0].product, "cursor");
});

test("mergeStore dedupes by billing id", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, "grok-billing.jsonl");
  const row = {
    id: "id1",
    t: "2026-11-01T02:00:00.000Z",
    model: "auto",
    tokens: 8,
    product: "cursor",
  };
  assert.equal(await mergeStore([row], storePath), 1);
  assert.equal(await mergeStore([row], storePath), 0);
  const saved = fs.readFileSync(storePath, "utf8");
  assert.equal(saved.includes("hidden@example.com"), false);
  assert.equal(saved.includes("secret"), false);
});

test("resolveGrokBillingPath sits beside the queue", () => {
  const queuePath = path.join("C:", "x", ".tokentracker", "tracker", "queue.jsonl");
  assert.equal(
    resolveGrokBillingPath(queuePath),
    path.join("C:", "x", ".tokentracker", "tracker", "grok-billing.jsonl"),
  );
});
