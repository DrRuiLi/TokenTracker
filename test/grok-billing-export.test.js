const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  billingDownloadArgs,
  challengeVisitedSince,
  eventsFromCsvText,
  getGrokBillingRefreshState,
  recordRefreshFailure,
  recordRefreshSuccess,
  isBillingDownloadCommand,
  isHeadlessCommand,
  mergeStore,
  resolveGrokBillingPath,
  usageTokens,
  parseUsage,
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
  assert.deepEqual(parseUsage(raw), {
    input_tokens: 10,
    output_tokens: 5,
    cached_input_tokens: 3,
    cache_creation_input_tokens: 2,
    tokens: 20,
  });
});

test("eventsFromCsvText strips PII and parses rows", () => {
  const usage = JSON.stringify({
    "prompt-text-tokens": 7,
    "completion-text-tokens": 1,
    "cached-prompt-text-tokens": 4,
    "cache-write-text-tokens": 2,
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
  assert.equal(events[0].tokens, 14);
  assert.equal(events[0].input_tokens, 7);
  assert.equal(events[0].output_tokens, 1);
  assert.equal(events[0].cached_input_tokens, 4);
  assert.equal(events[0].cache_creation_input_tokens, 2);
  assert.equal(events[0].product, "cursor");
  assert.equal(JSON.stringify(events[0]).includes("hidden@example.com"), false);
  assert.equal(JSON.stringify(events[0]).includes("secret"), false);
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

function writeHistory(profileDir, visits) {
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });
  const db = new DatabaseSync(path.join(profileDir, "Default", "History"));
  db.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT)");
  db.exec("CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)");
  const addUrl = db.prepare("INSERT INTO urls (url, title) VALUES (?, '')");
  const addVisit = db.prepare("INSERT INTO visits (url, visit_time) VALUES (?, ?)");
  for (const { url, atMs } of visits) {
    const { lastInsertRowid } = addUrl.run(url);
    addVisit.run(lastInsertRowid, BigInt(atMs + 11_644_473_600_000) * 1000n);
  }
  db.close();
}

test("challengeVisitedSince spots a Cloudflare challenge after the download started", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const started = Date.parse("2026-11-09T05:57:14.000Z");
  writeHistory(dir, [
    { url: "https://grok.com/dashboard/usage?__cf_chl_tk=old", atMs: started - 60_000 },
    { url: "https://grok.com/dashboard/api/dashboard/v2/export-billing-items-csv?scope=user", atMs: started + 500 },
  ]);
  assert.equal(challengeVisitedSince(dir, started), false);

  writeHistory(path.join(dir, "b"), [
    {
      url: "https://grok.com/dashboard/api/dashboard/v2/export-billing-items-csv?scope=user&__cf_chl_rt_tk=x",
      atMs: started + 800,
    },
  ]);
  assert.equal(challengeVisitedSince(path.join(dir, "b"), started), true);
  assert.equal(challengeVisitedSince(path.join(dir, "missing"), started), false);
});

test("billing refresh state reports failing only after the last success", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queuePath = path.join(dir, "queue.jsonl");

  recordRefreshSuccess(1_000);
  assert.equal(getGrokBillingRefreshState(queuePath).failing, false);

  const err = new Error("challenge");
  err.code = "cloudflare-challenge";
  recordRefreshFailure(err, 2_000);
  const failing = getGrokBillingRefreshState(queuePath);
  assert.equal(failing.failing, true);
  assert.equal(failing.code, "cloudflare-challenge");
  assert.equal(failing.lastSuccessAt, 1_000);

  recordRefreshSuccess(3_000);
  const healed = getGrokBillingRefreshState(queuePath);
  assert.equal(healed.failing, false);
  assert.equal(healed.code, null);
});

test("resolveGrokBillingPath sits beside the queue", () => {
  const queuePath = path.join("C:", "x", ".tokentracker", "tracker", "queue.jsonl");
  assert.equal(
    resolveGrokBillingPath(queuePath),
    path.join("C:", "x", ".tokentracker", "tracker", "grok-billing.jsonl"),
  );
});
