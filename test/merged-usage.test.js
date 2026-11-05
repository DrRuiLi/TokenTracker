const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  buildMergedRows,
  ensureMergedUsage,
  resolveGrokBillingPath,
  resolveMergedUsagePath,
  localDateKey,
} = require("../src/lib/merged-usage");

// queue row with a full breakdown, as readQueueData sees it.
function queueRow(overrides = {}) {
  return {
    source: "cursor",
    model: "auto",
    hour_start: "2026-11-01T02:00:00.000Z",
    input_tokens: 100,
    cached_input_tokens: 200,
    cache_creation_input_tokens: 0,
    output_tokens: 50,
    reasoning_output_tokens: 0,
    total_tokens: 350,
    billable_total_tokens: 350,
    conversation_count: 1,
    ...overrides,
  };
}

function billing(overrides = {}) {
  return {
    ms: Date.parse("2026-11-01T05:20:15.238Z"),
    model: "grok-4.7-high",
    tokens: 39101,
    product: "cursor",
    ...overrides,
  };
}

test("localDateKey shifts an instant into Asia/Shanghai", () => {
  // 2026-11-01T16:30:00Z is 2026-11-02 00:30 in UTC+8.
  assert.equal(localDateKey(Date.parse("2026-11-01T16:30:00Z")), "2026-11-02");
  assert.equal(localDateKey(Date.parse("2026-11-01T05:20:15Z")), "2026-11-01");
});

test("non-cursor queue sources always pass through", () => {
  const rows = buildMergedRows(
    [
      queueRow({ source: "opencode", model: "big-pickle" }),
      queueRow({ source: "codex", model: "gpt-5.3-codex" }),
      queueRow({ source: "mimo", model: "mimo" }),
    ],
    [], // no billing
  );
  const sources = rows.map((r) => r.source).sort();
  assert.deepEqual(sources, ["codex", "mimo", "opencode"]);
  // breakdown preserved verbatim
  const opencode = rows.find((r) => r.source === "opencode");
  assert.equal(opencode.total_tokens, 350);
  assert.equal(opencode.input_tokens, 100);
  assert.equal(opencode.cached_input_tokens, 200);
});

test("queue cursor is kept when billing has no cursor for that date", () => {
  const rows = buildMergedRows(
    [queueRow({ source: "cursor", hour_start: "2026-10-15T02:00:00.000Z" })],
    [billing({ product: "grok-bot", ms: Date.parse("2026-11-01T05:00:00Z") })],
  );
  // grok-bot coverage on 11-01 must NOT suppress queue cursor on 10-15.
  assert.equal(rows.filter((r) => r.source === "cursor").length, 1);
  assert.equal(rows.find((r) => r.source === "cursor").total_tokens, 350);
});

test("queue cursor is dropped on a date billing covers for the cursor product", () => {
  const rows = buildMergedRows(
    [
      queueRow({ source: "cursor", hour_start: "2026-11-01T02:00:00.000Z" }), // 11-01 UTC+8
      queueRow({ source: "cursor", hour_start: "2026-10-15T02:00:00.000Z" }), // 10-15, not covered
    ],
    [billing({ product: "cursor", ms: Date.parse("2026-11-01T05:20:15Z") })],
  );
  const starts = rows.filter((r) => r.source === "cursor").map((r) => r.hour_start);
  // the covered 11-01 queue row is dropped (replaced by billing's own row);
  // the uncovered 10-15 queue row survives.
  assert.equal(starts.includes("2026-11-01T02:00:00.000Z"), false);
  assert.equal(starts.includes("2026-10-15T02:00:00.000Z"), true);
  // billing's synthesized cursor row is present (hour-bucketed from the event).
  assert.equal(starts.includes("2026-11-01T05:00:00.000Z"), true);
});

test("billing cursor covers the UTC+8 date, not the raw UTC date", () => {
  // An instant at 2026-11-01T16:30:00Z is 11-02 in UTC+8, so it covers 11-02.
  const rows = buildMergedRows(
    [
      queueRow({ source: "cursor", hour_start: "2026-11-02T02:00:00.000Z" }), // 11-02 UTC+8
      queueRow({ source: "cursor", hour_start: "2026-11-01T02:00:00.000Z" }), // 11-01 UTC+8
    ],
    [billing({ product: "cursor", ms: Date.parse("2026-11-01T16:30:00Z") })],
  );
  const starts = rows.filter((r) => r.source === "cursor").map((r) => r.hour_start);
  // covered 11-02 queue row dropped; uncovered 11-01 kept; billing row present.
  assert.equal(starts.includes("2026-11-02T02:00:00.000Z"), false);
  assert.equal(starts.includes("2026-11-01T02:00:00.000Z"), true);
  assert.equal(starts.includes("2026-11-01T16:00:00.000Z"), true);
});

test("billing events become synthesized $0-cost rows bucketed by hour", () => {
  const rows = buildMergedRows(
    [],
    [
      billing({ product: "cursor", ms: Date.parse("2026-11-01T05:10:00Z"), tokens: 1000 }),
      billing({ product: "cursor", ms: Date.parse("2026-11-01T05:50:00Z"), tokens: 2000 }),
      billing({ product: "grok-bot", ms: Date.parse("2026-11-01T06:05:00Z"), tokens: 500, model: "grok-bot" }),
    ],
  );
  const cursor = rows.filter((r) => r.source === "cursor");
  assert.equal(cursor.length, 1); // both 05:xx events share one hour bucket
  assert.equal(cursor[0].total_tokens, 3000);
  assert.equal(cursor[0].billable_total_tokens, 3000);
  assert.equal(cursor[0].input_tokens, 0);
  assert.equal(cursor[0].output_tokens, 0);
  assert.equal(cursor[0].total_cost_usd, 0);
  assert.equal(cursor[0].billing_included, true);

  const grok = rows.find((r) => r.source === "grok-bot");
  assert.equal(grok.total_tokens, 500);
});

test("billing usage split is summed onto the synthesized hour row", () => {
  const rows = buildMergedRows(
    [],
    [
      billing({
        product: "cursor",
        ms: Date.parse("2026-11-01T05:10:00Z"),
        tokens: 16,
        input_tokens: 7,
        output_tokens: 1,
        cached_input_tokens: 4,
        cache_creation_input_tokens: 2,
      }),
      billing({
        product: "cursor",
        ms: Date.parse("2026-11-01T05:50:00Z"),
        tokens: 10,
        input_tokens: 3,
        output_tokens: 7,
      }),
    ],
  );
  const cursor = rows.find((r) => r.source === "cursor");
  assert.equal(cursor.total_tokens, 26);
  assert.equal(cursor.input_tokens, 10);
  assert.equal(cursor.output_tokens, 8);
  assert.equal(cursor.cached_input_tokens, 4);
  assert.equal(cursor.cache_creation_input_tokens, 2);
  assert.equal(cursor.total_cost_usd, 0);
});

test("cursor is not double counted when billing and queue both cover a date", () => {
  const rows = buildMergedRows(
    [queueRow({ source: "cursor", hour_start: "2026-11-01T02:00:00.000Z", total_tokens: 350 })],
    [billing({ product: "cursor", ms: Date.parse("2026-11-01T05:20:15Z"), tokens: 9999 })],
  );
  const cursorTotal = rows
    .filter((r) => r.source === "cursor")
    .reduce((sum, r) => sum + r.total_tokens, 0);
  // only billing's 9999; the queue's 350 was dropped, not added.
  assert.equal(cursorTotal, 9999);
});

test("ensureMergedUsage writes a queue-shaped file and rebuilds only on change", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-merged-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queuePath = path.join(dir, "queue.jsonl");
  const billingPath = path.join(dir, "grok-billing.jsonl");
  const mergedPath = path.join(dir, "merged-usage.jsonl");

  fs.writeFileSync(queuePath, JSON.stringify(queueRow({ source: "opencode" })) + "\n");
  fs.writeFileSync(billingPath, JSON.stringify({
    id: "b1",
    t: "2026-11-01T05:20:15.238Z",
    model: "grok-bot",
    tokens: 42,
    input_tokens: 30,
    output_tokens: 12,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    product: "grok-bot",
  }) + "\n");

  assert.equal(await ensureMergedUsage({ queuePath, billingPath, mergedPath }), mergedPath);
  const first = fs.readFileSync(mergedPath, "utf8");
  const parsed = first.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(parsed.length, 2);
  assert.equal(parsed.find((r) => r.source === "grok-bot").total_tokens, 42);
  assert.equal(parsed.find((r) => r.source === "grok-bot").input_tokens, 30);
  assert.equal(parsed.find((r) => r.source === "grok-bot").output_tokens, 12);
  assert.equal(parsed.find((r) => r.source === "opencode").source, "opencode");

  // unchanged inputs -> no rebuild (meta gate), same bytes
  const mtime = fs.statSync(mergedPath).mtimeMs;
  await ensureMergedUsage({ queuePath, billingPath, mergedPath });
  assert.equal(fs.statSync(mergedPath).mtimeMs, mtime);

  // change the billing store -> rebuild picks it up
  fs.writeFileSync(billingPath, JSON.stringify({ id: "b2", t: "2026-11-01T07:00:00.000Z", model: "grok-bot", tokens: 100, product: "grok-bot" }) + "\n");
  await ensureMergedUsage({ queuePath, billingPath, mergedPath });
  const after = fs.readFileSync(mergedPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(after.find((r) => r.source === "grok-bot").total_tokens, 100);
});

test("ensureMergedUsage returns null and writes nothing when the billing store is absent", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-merged-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queuePath = path.join(dir, "queue.jsonl");
  const mergedPath = resolveMergedUsagePath(queuePath);
  fs.writeFileSync(queuePath, JSON.stringify(queueRow({ source: "cursor" })) + "\n");

  // no billing store -> nothing to merge; callers fall back to the raw queue.
  assert.equal(
    await ensureMergedUsage({ queuePath, billingPath: path.join(dir, "nope.jsonl"), mergedPath }),
    null,
  );
  assert.equal(fs.existsSync(mergedPath), false);

  // a stale merged artifact from an earlier run is cleaned up, not served.
  fs.writeFileSync(mergedPath, "{}\n");
  assert.equal(
    await ensureMergedUsage({ queuePath, billingPath: path.join(dir, "nope.jsonl"), mergedPath }),
    null,
  );
  assert.equal(fs.existsSync(mergedPath), false);
});

test("resolveGrokBillingPath sits beside the queue in any profile home", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tt-home-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const queuePath = path.join(sandbox, ".tokentracker", "tracker", "queue.jsonl");
  assert.equal(
    resolveGrokBillingPath(queuePath),
    path.join(sandbox, ".tokentracker", "tracker", "grok-billing.jsonl"),
  );
});

test("resolveMergedUsagePath sits beside the queue", () => {
  const queuePath = path.join("C:", "x", ".tokentracker", "tracker", "queue.jsonl");
  assert.equal(resolveMergedUsagePath(queuePath), path.join("C:", "x", ".tokentracker", "tracker", "merged-usage.jsonl"));
});
