const assert = require("node:assert/strict");
const { describe, it, before, after } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  fetchMimoLimits,
  collectMimoLocal,
  computeMimoPlanPeriod,
  readMimoPlanAuthKeyNames,
  parseMimoPlanTokens,
  parseMimoPlanResetDay,
  parseMimoPlanProviders,
  parseMimoPlanLabel,
  isMimoPlanProviderId,
  MIMO_PLAN_DEFAULT_TOKENS,
  MIMO_PLAN_DEFAULT_PROVIDERS,
} = require("../src/lib/mimo-limits");

// node:sqlite is the write path for building a fixture DB (Node ≥22.18 on the
// project's test runtime). Skip the DB-backed cases when unavailable.
let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch (_e) {
  sqlite = null;
}

const SECRET = "sk-do-not-leak-this-key";

// Local-noon timestamps throughout: the plan period is computed in the LOCAL
// timezone (calendar reset day), so every fixture date must be built with the
// local Date constructor rather than Date.UTC — otherwise the assertions
// depend on the machine's UTC offset.
const NOW_MS = new Date(2026, 5, 24, 12, 0, 0).getTime(); // 2026-06-24 local
const IN_PERIOD_MS = new Date(2026, 5, 10, 8, 0, 0).getTime();
const PREV_PERIOD_MS = new Date(2026, 4, 31, 23, 0, 0).getTime();

const PLAN_TOKENS_OVERRIDE = "8000";

// A: xiaomi-token-plan-cn, assistant, in-period, all five token fields filled
//     → 1000 + 200 + 30 + 40 + 5 = 1275 counted.
// E: xiaomi-token-plan-sgp, assistant, in-period → 725 counted (multi-region).
// B/C/D/F: each breaks exactly one filter → excluded.
const EXPECTED_PERIOD_TOKENS = 1275 + 725;

function makeAuthJson(dir, keys = { "xiaomi-token-plan-cn": SECRET, xiaomi: SECRET }) {
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(keys), "utf8");
}

function tokens(input, output, reasoning, read, write) {
  return { input, output, reasoning, cache: { read, write } };
}

function buildV1FixtureDb(dir) {
  const dbPath = path.join(dir, "opencode.db");
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
  );
  const rows = [
    { id: "A", providerID: "xiaomi-token-plan-cn", role: "assistant", createdMs: IN_PERIOD_MS, tk: tokens(1000, 200, 30, 40, 5) },
    { id: "E", providerID: "xiaomi-token-plan-sgp", role: "assistant", createdMs: IN_PERIOD_MS, tk: tokens(700, 20, 5, 0, 0) },
    // Free-tier xiaomi provider → excluded by the providerID filter.
    { id: "B", providerID: "xiaomi", role: "assistant", createdMs: IN_PERIOD_MS, tk: tokens(50000, 50000, 0, 0, 0) },
    // User role → excluded by the role filter.
    { id: "C", providerID: "xiaomi-token-plan-cn", role: "user", createdMs: IN_PERIOD_MS, tk: tokens(90000, 0, 0, 0, 0) },
    // Previous cycle (before the June 1 reset) → excluded.
    { id: "D", providerID: "xiaomi-token-plan-cn", role: "assistant", createdMs: PREV_PERIOD_MS, tk: tokens(0, 90000, 0, 0, 0) },
    // Unrelated provider → excluded.
    { id: "F", providerID: "opencode", role: "assistant", createdMs: IN_PERIOD_MS, tk: tokens(0, 0, 90000, 0, 0) },
  ];
  for (const r of rows) {
    const data = JSON.stringify({
      providerID: r.providerID,
      role: r.role,
      tokens: r.tk,
      time: { created: r.createdMs },
    });
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(r.id, "sess_1", r.createdMs, r.createdMs, data);
  }
  db.close();
  return dbPath;
}

function buildV2FixtureDb(dir) {
  const dbPath = path.join(dir, "opencode.db");
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)" +
    ";CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
  );
  const rows = [
    { id: "A", providerID: "xiaomi-token-plan-cn", type: "assistant", createdMs: IN_PERIOD_MS, tk: tokens(1000, 200, 30, 40, 5) },
    { id: "B", providerID: "xiaomi", type: "assistant", createdMs: IN_PERIOD_MS, tk: tokens(50000, 50000, 0, 0, 0) },
    { id: "C", providerID: "xiaomi-token-plan-cn", type: "user", createdMs: IN_PERIOD_MS, tk: tokens(90000, 0, 0, 0, 0) },
    { id: "D", providerID: "xiaomi-token-plan-cn", type: "assistant", createdMs: PREV_PERIOD_MS, tk: tokens(0, 90000, 0, 0, 0) },
  ];
  for (const r of rows) {
    const data = JSON.stringify({
      model: { id: "mimo-v2.6-flash", providerID: r.providerID },
      type: r.type,
      tokens: r.tk,
      time: { created: r.createdMs },
    });
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, 0, ?, ?, ?)",
    ).run(r.id, "sess_v2_1", r.type, r.createdMs, r.createdMs, data);
  }
  db.close();
  return dbPath;
}

describe("mimo plan helpers (pure)", () => {
  it("computeMimoPlanPeriod anchors the cycle on the local reset day", () => {
    // Reset day 1, now June 24 → cycle = June 1 .. July 1.
    const p1 = computeMimoPlanPeriod(NOW_MS, 1);
    assert.equal(p1.startMs, new Date(2026, 5, 1).getTime());
    assert.equal(p1.endMs, new Date(2026, 6, 1).getTime());
    assert.equal(p1.resetMs, p1.endMs);
    assert.ok(p1.startMs <= NOW_MS && NOW_MS < p1.endMs, "now must fall inside the cycle");

    // Reset day 15, now June 24 (after the reset) → June 15 .. July 15.
    const p15 = computeMimoPlanPeriod(NOW_MS, 15);
    assert.equal(p15.startMs, new Date(2026, 5, 15).getTime());
    assert.equal(p15.endMs, new Date(2026, 6, 15).getTime());

    // Reset day 25, now June 24 (before the reset) → May 25 .. June 25.
    const before = computeMimoPlanPeriod(NOW_MS, 25);
    assert.equal(before.startMs, new Date(2026, 4, 25).getTime());
    assert.equal(before.endMs, new Date(2026, 5, 25).getTime());
  });

  it("computeMimoPlanPeriod clamps the reset day into short months", () => {
    // Feb 2026 has 28 days; a day-31 reset clamps to the 28th.
    const feb = computeMimoPlanPeriod(new Date(2026, 1, 10).getTime(), 31);
    assert.equal(feb.startMs, new Date(2026, 0, 28).getTime());
    assert.equal(feb.endMs, new Date(2026, 1, 28).getTime());
  });

  it("plan env overrides fall back to defaults on missing/invalid values", () => {
    assert.equal(parseMimoPlanTokens({}), MIMO_PLAN_DEFAULT_TOKENS);
    assert.equal(parseMimoPlanTokens({ TOKENTRACKER_MIMO_PLAN_TOKENS: "8000" }), 8000);
    assert.equal(parseMimoPlanTokens({ TOKENTRACKER_MIMO_PLAN_TOKENS: "junk" }), MIMO_PLAN_DEFAULT_TOKENS);
    assert.equal(parseMimoPlanTokens({ TOKENTRACKER_MIMO_PLAN_TOKENS: "-5" }), MIMO_PLAN_DEFAULT_TOKENS);

    assert.equal(parseMimoPlanResetDay({}), 1);
    assert.equal(parseMimoPlanResetDay({ TOKENTRACKER_MIMO_PLAN_RESET_DAY: "15" }), 15);
    assert.equal(parseMimoPlanResetDay({ TOKENTRACKER_MIMO_PLAN_RESET_DAY: "0" }), 1);
    assert.equal(parseMimoPlanResetDay({ TOKENTRACKER_MIMO_PLAN_RESET_DAY: "32" }), 1);

    assert.deepEqual(parseMimoPlanProviders({}), MIMO_PLAN_DEFAULT_PROVIDERS);
    assert.deepEqual(
      parseMimoPlanProviders({ TOKENTRACKER_MIMO_PROVIDERS: " xiaomi-token-plan-cn , ,xiaomi-token-plan-ams" }),
      ["xiaomi-token-plan-cn", "xiaomi-token-plan-ams"],
    );

    assert.equal(parseMimoPlanLabel({}), "Token Plan");
    assert.equal(parseMimoPlanLabel({ TOKENTRACKER_MIMO_PLAN_LABEL: "Token Plan (China)" }), "Token Plan (China)");
  });

  it("isMimoPlanProviderId matches only the configured token-plan ids", () => {
    assert.equal(isMimoPlanProviderId("xiaomi-token-plan-cn", {}), true);
    assert.equal(isMimoPlanProviderId("xiaomi", {}), false);
    assert.equal(
      isMimoPlanProviderId("custom-plan", { TOKENTRACKER_MIMO_PROVIDERS: "custom-plan" }),
      true,
    );
  });

  it("readMimoPlanAuthKeyNames returns provider key names only, never values", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-auth-"));
    try {
      makeAuthJson(tmpDir, { "xiaomi-token-plan-cn": SECRET, xiaomi: SECRET, anthropic: SECRET });
      const out = readMimoPlanAuthKeyNames({ env: { OPENCODE_HOME: tmpDir } });
      assert.equal(out.authPath, path.join(tmpDir, "auth.json"));
      assert.deepEqual(out.keyNames, ["xiaomi-token-plan-cn"]);
      // The secret must not appear anywhere in the returned structure.
      assert.equal(JSON.stringify(out).includes(SECRET), false);

      // Missing auth.json → no keys, no throw.
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-auth-empty-"));
      try {
        assert.deepEqual(readMimoPlanAuthKeyNames({ env: { OPENCODE_HOME: empty } }).keyNames, []);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }

      // Malformed auth.json → no keys, no throw.
      fs.writeFileSync(path.join(tmpDir, "auth.json"), "{not json", "utf8");
      assert.deepEqual(readMimoPlanAuthKeyNames({ env: { OPENCODE_HOME: tmpDir } }).keyNames, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("fetchMimoLimits (v1 message fixture)", { skip: !sqlite }, () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-v1-"));
    buildV1FixtureDb(tmpDir);
    makeAuthJson(tmpDir);
  });
  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      /* best effort */
    }
  });

  function env(extra = {}) {
    return { OPENCODE_HOME: tmpDir, TOKENTRACKER_MIMO_PLAN_TOKENS: PLAN_TOKENS_OVERRIDE, ...extra };
  }

  it("sums the five token fields for token-plan providers in the current cycle", async () => {
    const out = await fetchMimoLimits({ env: env(), nowMs: NOW_MS });
    assert.equal(out.configured, true);
    assert.equal(out.error, null);
    assert.equal(out.source, "local-estimate");
    assert.equal(out.plan_label, "Token Plan");
    assert.equal(out.plan_tokens, 8000);
    assert.equal(out.period_tokens, EXPECTED_PERIOD_TOKENS);
    // 2000 / 8000 = 25%
    assert.equal(out.primary_window.used_percent, 25);
    assert.equal(out.primary_window.used, EXPECTED_PERIOD_TOKENS);
    assert.equal(out.primary_window.limit, 8000);
    assert.equal(out.primary_window.remaining, 8000 - EXPECTED_PERIOD_TOKENS);
    assert.equal(out.primary_window.reset_at, new Date(2026, 6, 1).toISOString());
    assert.equal(out.reset_at, new Date(2026, 6, 1).toISOString());
    assert.equal(out.period_start_at, new Date(2026, 5, 1).toISOString());
    assert.equal(out.period_end_at, new Date(2026, 6, 1).toISOString());
  });

  it("never leaks the stored API key", async () => {
    const out = await fetchMimoLimits({ env: env(), nowMs: NOW_MS });
    assert.equal(JSON.stringify(out).includes(SECRET), false);
  });

  it("honors the plan size and reset day overrides", async () => {
    // Same 2000 tokens against a 100M default-sized plan… plus reset day 15
    // moves the cycle to June 15 .. July 15, which excludes the June 10 rows.
    const out = await fetchMimoLimits({
      env: env({ TOKENTRACKER_MIMO_PLAN_RESET_DAY: "15" }),
      nowMs: NOW_MS,
    });
    assert.equal(out.period_tokens, 0);
    assert.equal(out.primary_window.used_percent, 0);
    assert.equal(out.primary_window.reset_at, new Date(2026, 6, 15).toISOString());
  });

  it("clamps used_percent at 100 when usage exceeds the plan", async () => {
    const out = await fetchMimoLimits({
      env: env({ TOKENTRACKER_MIMO_PLAN_TOKENS: "1000" }),
      nowMs: NOW_MS,
    });
    assert.equal(out.primary_window.used_percent, 100);
    assert.equal(out.primary_window.remaining, 0);
    assert.equal(out.primary_window.status, "limit-reached");
  });

  it("filters to the provider list from TOKENTRACKER_MIMO_PROVIDERS", async () => {
    // Only the SGP region is tracked (and only its key authenticates the row)
    // → 725 / 8000 = 9.0625%; the CN row must not count.
    const onlySgp = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-sgp-"));
    try {
      buildV1FixtureDb(onlySgp);
      makeAuthJson(onlySgp, { "xiaomi-token-plan-sgp": SECRET });
      const out = await fetchMimoLimits({
        env: {
          OPENCODE_HOME: onlySgp,
          TOKENTRACKER_MIMO_PLAN_TOKENS: PLAN_TOKENS_OVERRIDE,
          TOKENTRACKER_MIMO_PROVIDERS: "xiaomi-token-plan-sgp",
        },
        nowMs: NOW_MS,
      });
      assert.equal(out.configured, true);
      assert.equal(out.period_tokens, 725);
      assert.equal(out.primary_window.used_percent, 725 / 8000 * 100);
    } finally {
      fs.rmSync(onlySgp, { recursive: true, force: true });
    }
  });

  it("is not configured without an auth.json token-plan key, despite DB rows", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-noauth-"));
    try {
      buildV1FixtureDb(empty);
      const out = await fetchMimoLimits({
        env: { OPENCODE_HOME: empty, TOKENTRACKER_MIMO_PLAN_TOKENS: PLAN_TOKENS_OVERRIDE },
        nowMs: NOW_MS,
      });
      assert.equal(out.configured, false);
      assert.equal(out.primary_window, null);
      assert.equal(out.period_tokens, 0);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("TOKENTRACKER_MIMO_DISABLE forces the unconfigured state", async () => {
    const out = await fetchMimoLimits({
      env: env({ TOKENTRACKER_MIMO_DISABLE: "1" }),
      nowMs: NOW_MS,
    });
    assert.equal(out.configured, false);
    assert.equal(out.primary_window, null);
  });

  it("collectMimoLocal reports zero rows for a database without mimo turns", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-norows-"));
    try {
      const agg = await collectMimoLocal({
        env: { OPENCODE_HOME: empty },
        nowMs: NOW_MS,
        providers: MIMO_PLAN_DEFAULT_PROVIDERS,
        period: computeMimoPlanPeriod(NOW_MS, 1),
      });
      assert.deepEqual(agg, { periodTokens: 0, rowCount: 0, error: null });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("fetchMimoLimits (opencode2 session_message fixture)", { skip: !sqlite }, () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-v2-"));
    buildV2FixtureDb(tmpDir);
    makeAuthJson(tmpDir);
  });
  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      /* best effort */
    }
  });

  it("reads the nested $.model.providerID schema with the same expectations", async () => {
    const out = await fetchMimoLimits({
      env: { OPENCODE_HOME: tmpDir, TOKENTRACKER_MIMO_PLAN_TOKENS: PLAN_TOKENS_OVERRIDE },
      nowMs: NOW_MS,
    });
    assert.equal(out.configured, true);
    // Single CN region row: 1000 + 200 + 30 + 40 + 5 = 1275 → 15.9375%
    assert.equal(out.period_tokens, 1275);
    assert.equal(out.primary_window.used_percent, 1275 / 8000 * 100);
  });
});
