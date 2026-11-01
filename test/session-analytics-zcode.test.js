"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_e) { /* Node < 22.5 has no node:sqlite; the suite skips below */ }

const {
  scanZcodeSessions,
  discoverSessionFiles,
  buildSessionAnalytics,
  listSessionsForBrowser,
  summarizeSessions,
  resolveSessionSidecarPath,
} = require("../src/lib/session-analytics");
const { readZcodeDbMessages, parseOpencodeDbIncremental, zcodeDbHasContent, hasZcodeCursorState, resolveZcodeInstallPaths } = require("../src/lib/rollout");
const { multiInstallParse } = require("../src/lib/multi-install-parser");
const { cmdSync } = require("../src/commands/sync");
const { cmdStatus } = require("../src/commands/status");
const { openCursorStore, readCursorStateSummary } = require("../src/lib/cursor-store");
const { withHome } = require("./helpers/with-home");
const { mockPlatform, mockMethod } = require("./helpers/mock");
const wsl = require("../src/lib/wsl-probe");

// engines allow Node >= 20 but node:sqlite (used to build fixture databases
// and by the production sqlite reader fallback) only exists from 22.5 — same
// try-require pattern as test/anythingllm-parser.test.js.
const sqliteTest = DatabaseSync ? test : test.skip;

const T0 = Date.UTC(2026, 9, 8, 10, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

function createFixtureDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER
    );
    CREATE TABLE model_usage (
      id TEXT,
      logical_request_id TEXT,
      attempt_index INTEGER,
      session_id TEXT,
      turn_id TEXT,
      query_source TEXT,
      provider_id TEXT,
      model_id TEXT,
      status TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      duration_ms INTEGER,
      time_to_first_token_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER
    );
    CREATE TABLE message (
      id TEXT,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
    CREATE TABLE turn_usage (
      session_id TEXT,
      turn_id TEXT,
      model_retry_count INTEGER
    );
    CREATE TABLE tool_usage (
      id TEXT,
      session_id TEXT,
      turn_id TEXT,
      tool_name TEXT
    );
  `);
  return db;
}

function insertSession(db, { id, parentId = null, directory = null, title = null, created = T0, updated = T0 }) {
  db.prepare("INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, parentId, directory, title, created, updated);
}

function insertModelUsage(db, {
  id, sessionId, startedAt = T0, durationMs = 0, ttfb = null,
  input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0,
  querySource = "main_turn", providerId = "account:bigmodel-individual-coding-plan",
  model = "GLM-5.3", status = "completed",
}) {
  db.prepare(`INSERT INTO model_usage
    (id, session_id, turn_id, query_source, provider_id, model_id, status, started_at, completed_at,
     duration_ms, time_to_first_token_ms, input_tokens, output_tokens, reasoning_tokens,
     cache_creation_input_tokens, cache_read_input_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, sessionId, null, querySource, providerId, model, status, startedAt, startedAt + durationMs,
      durationMs, ttfb, input, output, reasoning, cacheWrite, cacheRead);
}

// The legacy OpenCode `message` table carries inclusive token snapshots
// (input contains cache read+write, output contains reasoning) — the same
// shape readOpencodeDbMessages/appendRows in rollout.js parses.
function insertLegacyMessage(db, {
  id, sessionId, timeUpdated, tokens, cwd = null,
  model = "GLM-5.2", v2Model = null, providerId = "builtin:bigmodel-coding-plan", anthropic = false,
}) {
  const data = {
    id,
    sessionID: sessionId,
    role: "assistant",
    providerID: anthropic ? "anthropic" : providerId,
    time: { created: timeUpdated, completed: timeUpdated },
    tokens,
  };
  // v2Model writes the OpenCode v2 shape (model nested as { id, providerID },
  // no flat modelID) instead of the v1 flat field.
  if (v2Model) data.model = { id: v2Model, providerID: anthropic ? "anthropic" : providerId };
  else data.modelID = model;
  if (cwd) data.path = { cwd };
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
    .run(id, sessionId, timeUpdated, timeUpdated, JSON.stringify(data));
}

function insertTurn(db, sessionId, turnId, retryCount = 0) {
  db.prepare("INSERT INTO turn_usage (session_id, turn_id, model_retry_count) VALUES (?, ?, ?)")
    .run(sessionId, turnId, retryCount);
}

function insertTool(db, sessionId, turnId, name) {
  db.prepare("INSERT INTO tool_usage (id, session_id, turn_id, tool_name) VALUES (?, ?, ?, ?)")
    .run(`${sessionId}-${turnId}-${name}`, sessionId, turnId, name);
}

function buildDb(t, build) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dbPath = path.join(home, ".zcode", "cli", "db", "db.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = createFixtureDb(dbPath);
  build(db);
  db.close();
  return { home, dbPath };
}

sqliteTest("native ZCode session: disjoint tokens, priced cost, tokens/s and turn signals", async (t) => {
  const { dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "sess-native", directory: "C:\\repo\\demo", title: "Native session", created: T0, updated: T0 + 120000 });
    // Inclusive input (cache read folded in): readZcodeDbMessages splits it so
    // 1100 raw input becomes 100 disjoint input + 1000 cached.
    insertModelUsage(db, { id: "r1", sessionId: "sess-native", startedAt: T0, input: 1100, cacheRead: 1000, output: 1000, durationMs: 10000, ttfb: 1500 });
    // Below the speed threshold (50 < MIN_OUTPUT): tokens count, the sample does not.
    insertModelUsage(db, { id: "r2", sessionId: "sess-native", startedAt: T0 + 60000, input: 600, cacheRead: 500, output: 50, durationMs: 5000 });
    // Compaction request: tokens and duration count, plus compaction_count.
    insertModelUsage(db, { id: "r3", sessionId: "sess-native", startedAt: T0 + 61000, input: 200, output: 300, durationMs: 8000, querySource: "compact" });
    // Failed request: the native reader drops it (status != completed); only error_count sees it.
    insertModelUsage(db, { id: "r4", sessionId: "sess-native", startedAt: T0 + 62000, input: 9999, output: 9999, status: "error", durationMs: 100000 });
    // Sub-agent orchestrated through claude: blocklisted from tokens AND signals.
    insertModelUsage(db, { id: "r5", sessionId: "sess-native", startedAt: T0 + 63000, providerId: "anthropic", model: "claude-sonnet-4-5", input: 5000, output: 5000, durationMs: 60000, ttfb: 9000 });
    // All-zero completed row: the native reader's token predicate drops it.
    insertModelUsage(db, { id: "r6", sessionId: "sess-native", startedAt: T0 + 64000 });
    insertTurn(db, "sess-native", "turn-1", 1);
    insertTurn(db, "sess-native", "turn-2", 0);
    // ZCode writes Capitalized tool names; matching must be case-insensitive.
    insertTool(db, "sess-native", "turn-1", "Edit");
    insertTool(db, "sess-native", "turn-1", "Read");
    insertTool(db, "sess-native", "turn-2", "Bash");
  });

  const rows = await scanZcodeSessions(dbPath);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.source, "zcode");
  assert.equal(row.session_id, "sess-native");
  assert.equal(row.title, "Native session");
  assert.equal(row.project_ref, "C:\\repo\\demo");
  assert.equal(row.project_key, "demo");
  assert.equal(row.parent_session_id, null);
  assert.deepEqual(row.tokens, {
    input_tokens: 100 + 100 + 200,
    cached_input_tokens: 1000 + 500,
    cache_creation_input_tokens: 0,
    output_tokens: 1000 + 50 + 300,
    reasoning_output_tokens: 0,
    total_tokens: 3250,
  });
  assert.equal(row.model, "GLM-5.3");
  assert.equal(row.model_usage.length, 1);
  assert.equal(row.model_usage[0].model, "GLM-5.3");
  assert.equal(row.model_usage[0].pricing.status, "priced");
  assert.ok(row.cost_usd > 0, `expected a priced estimate, got ${row.cost_usd}`);
  assert.equal(row.cost_source, "model_pricing");
  assert.equal(row.cost_is_partial, false);
  // Speed: (1000 + 300) tokens over (10000 + 8000) ms of completed requests;
  // the 50-token request and every blocked/failed row never become samples.
  assert.equal(row.performance.estimated_output_tokens, 1300);
  assert.equal(row.performance.estimated_duration_ms, 18000);
  assert.equal(row.performance.estimated_request_count, 2);
  assert.ok(Math.abs(row.performance.estimated_tokens_per_second - 1300 / 18) < 1e-9);
  assert.equal(row.performance.first_response_ms, 1500);
  // Signals span every completed non-blocked request (r1..r3).
  assert.equal(row.api_duration_ms, 23000);
  assert.equal(row.error_count, 1);
  assert.equal(row.compaction_count, 1);
  assert.equal(row.turns, 2);
  assert.equal(row.retry_turns, 0);
  assert.equal(row.provenance.retry_confidence, "unavailable");
  assert.equal(row.first_pass, true); // model retry did not repeat the user's request
  assert.equal(row.edit_turns, 1);
  assert.equal(row.productive, true);
  assert.equal(row.usage_precision, "reported");
  assert.equal(row.model_calls, 3);
  assert.equal(row.usage_events, 3);
  // Epoch-ms message timestamps must surface as ISO strings, not be dropped.
  assert.equal(row.started_at, iso(T0));
  // ended_at carries the last request's start + duration (r3: T0+61s + 8s),
  // not just its start instant — the 10s r1 generation widens nothing here but
  // the compact r3 does. Error r4 (T0+62s) and zero-token r6 (T0+64s) end at
  // their start instants, both inside the span.
  assert.equal(row.ended_at, iso(T0 + 69000));
  // Minute buckets for the from/to day filter: r1 lands in the T0 bucket,
  // r2 and r3 share the next minute (blocked r5 and failed r4 never had
  // messages, r6 had no tokens).
  assert.equal(row.usage_buckets.length, 2);
  const bucket1 = row.usage_buckets.find((b) => b.timestamp === iso(T0));
  const bucket2 = row.usage_buckets.find((b) => b.timestamp === iso(T0 + 60000));
  assert.equal(bucket1.total_tokens, 100 + 1000 + 1000);
  assert.equal(bucket2.total_tokens, 100 + 500 + 50 + 200 + 300);
  assert.equal(bucket1.usage_events, 1);
  assert.equal(bucket2.usage_events, 2);
  const day = iso(T0).slice(0, 10);
  assert.equal(listSessionsForBrowser(rows, { from: day, to: day }).sessions[0].model_usage[0].usage_events, 3);
});

sqliteTest("legacy OpenCode message table feeds sessions that model_usage never covers", async (t) => {
  const { dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "sess-legacy", directory: null, title: "Legacy session", created: T0, updated: T0 + 3600000 });
    insertLegacyMessage(db, {
      id: "m1", sessionId: "sess-legacy", timeUpdated: T0, cwd: "C:\\repo\\legacy",
      tokens: { input: 1100, output: 400, reasoning: 100, cache: { read: 1000, write: 100 } },
    });
    insertLegacyMessage(db, {
      id: "m2", sessionId: "sess-legacy", timeUpdated: T0 + 60000,
      tokens: { input: 600, output: 200, cache: { read: 500, write: 0 } },
    });
    // A claude turn mirrored into the legacy table is blocklisted.
    insertLegacyMessage(db, {
      id: "m3", sessionId: "sess-legacy", timeUpdated: T0 + 90000, anthropic: true,
      tokens: { input: 9000, output: 9000, cache: { read: 0, write: 0 } },
    });
  });

  const rows = await scanZcodeSessions(dbPath);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.deepEqual(row.tokens, {
    input_tokens: 0 + 100,
    cached_input_tokens: 1000 + 500,
    cache_creation_input_tokens: 100 + 0,
    output_tokens: 300 + 200,
    reasoning_output_tokens: 100,
    // Reasoning is part of the usage-queue total (input + output + cache
    // read/write + reasoning), not folded into output_tokens.
    total_tokens: 2200 + 100,
  });
  // Empty directory column: the message's own cwd takes over.
  assert.equal(row.project_ref, "C:\\repo\\legacy");
  assert.equal(row.project_key, "legacy");
  assert.equal(row.model, "GLM-5.2");
  assert.equal(row.usage_precision, "reported");
  assert.equal(row.model_calls, 2);
  // Legacy snapshots carry no durations: estimates stay empty, tokens still count.
  assert.equal(row.api_duration_ms, 0);
  assert.equal(row.performance.estimated_request_count, 0);
  assert.equal(row.performance.estimated_tokens_per_second, null);
  assert.equal(row.turns, 0);
  assert.equal(row.edit_turns, 0);
  assert.equal(row.productive, false);
  assert.ok(row.cost_usd > 0);
  assert.equal(row.started_at, iso(T0));
  assert.equal(row.ended_at, iso(T0 + 60000));
});

sqliteTest("browser rows keep parity with the usage reader and drop usage-less sessions", async (t) => {
  const { dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "sess-a", directory: "C:\\repo\\a", title: "Root", created: T0, updated: T0 + 60000 });
    insertSession(db, { id: "sess-child", parentId: "sess-a", directory: "C:\\repo\\a", title: "Child", created: T0 + 10000, updated: T0 + 20000 });
    // claude-import migration the importer did not rebuild per-call usage for.
    insertSession(db, { id: "claude-import-abc123", directory: "C:\\repo\\a", title: "Imported", created: T0, updated: T0 + 1000 });
    insertModelUsage(db, { id: "a1", sessionId: "sess-a", startedAt: T0, input: 1200, cacheRead: 1000, output: 800, durationMs: 4000, ttfb: 600 });
    insertModelUsage(db, { id: "c1", sessionId: "sess-child", startedAt: T0 + 10000, input: 300, cacheRead: 200, output: 200, durationMs: 2000 });
  });

  const scanned = await scanZcodeSessions(dbPath);
  assert.equal(scanned.length, 3);
  // Same-source parity: the browser's token total equals the usage sync
  // reader's, by construction (scan consumes readZcodeDbMessages directly).
  const messageSum = readZcodeDbMessages(dbPath).reduce((sum, m) => {
    const tokens = m.data?.tokens || {};
    return sum + (tokens.input || 0) + (tokens.cache?.read || 0) + (tokens.cache?.write || 0) + (tokens.output || 0);
  }, 0);
  assert.equal(scanned.reduce((sum, row) => sum + row.total_tokens, 0), messageSum);

  const browser = listSessionsForBrowser(scanned).sessions;
  assert.equal(browser.length, 2); // the claude-import row has no usage at all
  assert.equal(new Set(browser.map((row) => row.session_hash)).size, browser.length);
  const child = browser.find((row) => row.session_id === "sess-child");
  assert.equal(child.thread_kind, "subagent");
  assert.equal(child.parent_session_id, "sess-a");
  assert.ok(child.started_at); // timestamps survive the browser mapping
  assert.ok(child.ended_at);
  const root = browser.find((row) => row.session_id === "sess-a");
  assert.equal(root.thread_kind, "root");
  assert.equal(root.resume_command, null); // no verified ZCode resume CLI form
  // Lineage folds like Codex threads: the child nests under its parent and
  // the parent row aggregates it (annotateThreadUsage covers zcode too).
  assert.equal(child.parent_session_hash, root.session_hash);
  assert.equal(child.root_session_hash, root.session_hash);
  assert.equal(root.direct_subagent_count, 1);
  assert.equal(root.combined_total_tokens, root.total_tokens + child.total_tokens);
  const summary = summarizeSessions(scanned);
  assert.equal(summary.subagents.length, 1);
  assert.equal(summary.subagents[0].name, "subagent");
  assert.equal(summary.subagents[0].calls, 1);
  assert.equal(summary.subagents[0].sessions, 1);
  assert.equal(summary.subagents[0].total_tokens, child.total_tokens);
  assert.equal(summary.subagents[0].cost_usd, child.cost_usd);
  assert.equal(summary.subagents[0].attribution, "observed-child-session");
});

sqliteTest("degrades gracefully when optional signal tables are missing", async (t) => {
  const { home, dbPath } = buildDb(t, (db) => {
    db.exec("DROP TABLE turn_usage; DROP TABLE tool_usage;");
    insertSession(db, { id: "sess-min", directory: "C:\\repo\\min", created: T0, updated: T0 + 1000 });
    insertModelUsage(db, { id: "m1", sessionId: "sess-min", startedAt: T0, input: 500, output: 400, durationMs: 3000, ttfb: 500 });
  });
  const rows = await scanZcodeSessions(dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total_tokens, 900);
  assert.equal(rows[0].turns, 0);
  assert.equal(rows[0].edit_turns, 0);
  assert.ok(Math.abs(rows[0].performance.estimated_tokens_per_second - 400 / 3) < 1e-9);

  // A db without a session table cannot enumerate sessions at all.
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-nosession-"));
  t.after(() => fs.rmSync(otherHome, { recursive: true, force: true }));
  const otherPath = path.join(otherHome, "db.sqlite");
  const other = new DatabaseSync(otherPath);
  other.exec("CREATE TABLE unrelated (x)");
  other.close();
  assert.deepEqual(await scanZcodeSessions(otherPath), []);
});

sqliteTest("OpenCode v2 nested model shape keeps by-model attribution and pricing", async (t) => {
  const { dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "sess-v2", directory: "C:\\repo\\v2", title: "V2 session", created: T0, updated: T0 + 60000 });
    // v2 layout: no flat modelID — the model nests as { id, providerID }.
    insertLegacyMessage(db, {
      id: "v2m1", sessionId: "sess-v2", timeUpdated: T0, v2Model: "GLM-4.7",
      tokens: { input: 600, output: 300, cache: { read: 500, write: 0 } },
    });
  });

  const rows = await scanZcodeSessions(dbPath);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.model, "GLM-4.7");
  assert.equal(row.model_usage.length, 1);
  assert.equal(row.model_usage[0].model, "GLM-4.7");
  assert.equal(row.model_usage[0].pricing.status, "priced");
  assert.ok(row.cost_usd > 0, `v2 model shape must stay priced, got ${row.cost_usd}`);
  assert.equal(row.cost_is_partial, false);
});

sqliteTest("an unreadable db rejects instead of reading as zero sessions", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-corrupt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "db.sqlite");
  fs.writeFileSync(dbPath, "this is not a sqlite database\n");
  // A failed read must propagate: the caller counts the db as skipped and
  // retries next build, never caches "no sessions" for a live database.
  await assert.rejects(scanZcodeSessions(dbPath));
});

sqliteTest("thinking tokens count toward the total, matching the usage queue", async (t) => {
  const { dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "sess-think", directory: "C:\\repo\\think", created: T0 });
    // Inclusive snapshot: output 1000 contains 300 reasoning tokens.
    insertModelUsage(db, { id: "t1", sessionId: "sess-think", startedAt: T0, input: 1100, cacheRead: 1000, output: 1000, reasoning: 300, durationMs: 5000 });
  });
  const rows = await scanZcodeSessions(dbPath);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.tokens.output_tokens, 700);
  assert.equal(row.tokens.reasoning_output_tokens, 300);
  // 100 disjoint input + 1000 cached + 700 output + 300 reasoning = 2100: the
  // same total the usage card reports for this request (its total is input +
  // output + cache_creation + cache_read + reasoning_output).
  assert.equal(row.tokens.total_tokens, 2100);
});

sqliteTest("session bounds use request end times so the last generation's duration survives", async (t) => {
  const { dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "sess-span", directory: "C:\\repo\\span", created: T0 });
    insertModelUsage(db, { id: "s1", sessionId: "sess-span", startedAt: T0, input: 500, output: 400, durationMs: 10000, ttfb: 800 });
  });
  const rows = await scanZcodeSessions(dbPath);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.started_at, iso(T0));
  // Not iso(T0): message timestamps are request starts, so the 10s request
  // must widen ended_at by its duration or the span reads as zero-length.
  assert.equal(row.ended_at, iso(T0 + 10000));
  // The browser's duration_ms mirrors active_ms: the single request's
  // execution time is the tail past the last message timestamp, and it must
  // count as working time — not 0.
  assert.equal(row.active_ms, 10000);
  assert.equal(row.duration_ms, 10000);
});

sqliteTest("request spans normalize epoch seconds alongside millisecond timestamps", async (t) => {
  const { dbPath } = buildDb(t, (db) => {
    for (const [id, startedAt] of [["seconds", T0 / 1000], ["milliseconds", T0]]) {
      insertSession(db, { id, directory: "/repo/timestamps", created: T0 });
      // Different real requests must not share every field of the ledger's
      // fork-copy fingerprint; this test isolates timestamp-unit handling.
      insertModelUsage(db, { id, sessionId: id, startedAt, input: 500, output: id === "seconds" ? 400 : 450, durationMs: 10000 });
    }
  });
  const rows = await scanZcodeSessions(dbPath);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.started_at, iso(T0));
    assert.equal(row.ended_at, iso(T0 + 10000));
    assert.equal(row.active_ms, 10000);
    assert.equal(row.duration_ms, 10000);
    assert.equal(row.project_key, "timestamps");
  }
});

sqliteTest("usage buckets scope day filters instead of billing a whole multi-day session", async (t) => {
  const day2 = T0 + 2 * 86400000;
  const { dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "sess-multi", directory: "C:\\repo\\multi", created: T0, updated: day2 + 60000 });
    insertModelUsage(db, { id: "d1a", sessionId: "sess-multi", startedAt: T0, input: 1100, cacheRead: 1000, output: 400, durationMs: 4000 });
    insertModelUsage(db, { id: "d1b", sessionId: "sess-multi", startedAt: T0 + 60000, input: 300, output: 100, durationMs: 2000 });
    insertModelUsage(db, { id: "d2a", sessionId: "sess-multi", startedAt: day2, input: 500, output: 200, durationMs: 3000 });
  });
  const rows = await scanZcodeSessions(dbPath);
  assert.equal(rows.length, 1);
  // Lifetime: day1 (100+1000+400 and 300+100) + day2 (500+200) = 2600.
  assert.equal(rows[0].total_tokens, 100 + 1000 + 400 + 300 + 100 + 500 + 200);

  const day1 = new Date(T0).toISOString().slice(0, 10);
  const day2Str = new Date(day2).toISOString().slice(0, 10);
  const day1Rows = listSessionsForBrowser(rows, { from: day1, to: day1 });
  assert.equal(day1Rows.sessions.length, 1);
  assert.equal(day1Rows.sessions[0].total_tokens, 100 + 1000 + 400 + 300 + 100);
  const day2Rows = listSessionsForBrowser(rows, { from: day2Str, to: day2Str });
  assert.equal(day2Rows.sessions.length, 1);
  assert.equal(day2Rows.sessions[0].total_tokens, 500 + 200);
});

sqliteTest("a failed native usage query aborts the scan instead of reading as zero tokens", async (t) => {
  const { dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "sess-fault", directory: "C:\\repo\\fault", created: T0 });
    // Break only the native row query: the view keeps pragma_table_info happy
    // (layout detection passes) but selecting from it fails on the dropped
    // base table — the exact "usage query failed, everything else fine" case.
    db.exec(`
      ALTER TABLE model_usage RENAME TO _mu_real;
      CREATE VIEW model_usage AS SELECT * FROM _mu_real;
      DROP TABLE _mu_real;
    `);
    insertLegacyMessage(db, { id: "lm1", sessionId: "sess-fault", timeUpdated: T0, tokens: { input: 100, output: 50 } });
  });
  // The usage reader itself still degrades to legacy — its own resilience
  // contract is unchanged.
  const messages = readZcodeDbMessages(dbPath);
  assert.equal(messages.length, 1);
  // The session scanner must not cache that degraded view as the truth: the
  // failure propagates and the caller counts the db as skipped.
  await assert.rejects(scanZcodeSessions(dbPath));
});

sqliteTest("active time unions request durations across idle pauses and overlaps", async (t) => {
  const hour = 3600000;
  const { dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "sess-union", directory: "C:\\repo\\union", created: T0 });
    // Two 10s requests around a 1h pause: 20s of work, the pause excluded.
    insertModelUsage(db, { id: "u1", sessionId: "sess-union", startedAt: T0, input: 100, output: 100, durationMs: 10000 });
    insertModelUsage(db, { id: "u2", sessionId: "sess-union", startedAt: T0 + hour, input: 100, output: 100, durationMs: 10000 });
    // Parallel requests after another pause: [2h, 2h+10s] ∪ [2h+5s, 2h+15s]
    // collapses to 15s — overlapping generations are not counted twice.
    insertModelUsage(db, { id: "u3", sessionId: "sess-union", startedAt: T0 + 2 * hour, input: 100, output: 100, durationMs: 10000 });
    insertModelUsage(db, { id: "u4", sessionId: "sess-union", startedAt: T0 + 2 * hour + 5000, input: 100, output: 100, durationMs: 10000 });
  });
  const rows = await scanZcodeSessions(dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].active_ms, 10000 + 10000 + 15000);
  assert.equal(rows[0].duration_ms, 35000);
  // api_duration_ms stays the plain per-request sum (40s) — it is the API
  // clock, not the deduplicated working time.
  assert.equal(rows[0].api_duration_ms, 40000);
});

sqliteTest("a failed legacy v2 layout probe aborts the scan too", async (t) => {
  const { dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "sess-v2fault", directory: "C:\\repo\\v2f", created: T0 });
    // Pre-native db (model_usage lacks the native columns) whose v1 table is
    // gone and whose v2 layout probe fails hard on a malformed-JSON view —
    // the scanner must reject rather than report a token-less session over a
    // database it failed to read.
    db.exec("ALTER TABLE model_usage DROP COLUMN reasoning_tokens;");
    db.exec("DROP TABLE message;");
    db.exec("CREATE VIEW session_message AS SELECT * FROM json_each('not valid json');");
  });
  // The tolerant usage reader still reads this as "no messages".
  assert.deepEqual(readZcodeDbMessages(dbPath), []);
  await assert.rejects(scanZcodeSessions(dbPath));
});

sqliteTest("a failed legacy v1 query also aborts the scan when no native layout exists", async (t) => {
  const { dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "sess-legacy-fault", directory: "C:\\repo\\lf", created: T0 });
    // Pre-native database whose legacy read fails hard: the message view
    // explodes on malformed JSON — a real failure, not the "other
    // generation's table is absent" miss.
    db.exec("ALTER TABLE model_usage DROP COLUMN reasoning_tokens;");
    db.exec("DROP TABLE message;");
    db.exec("CREATE VIEW message AS SELECT * FROM json_each('not valid json');");
  });
  assert.deepEqual(readZcodeDbMessages(dbPath), []);
  await assert.rejects(scanZcodeSessions(dbPath));
});

sqliteTest("failed ZCode rebuilds preserve the complete cache and retry unchanged databases", async (t) => {
  const { home, dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "retry", directory: "/repo/retry", created: T0 });
    insertModelUsage(db, { id: "retry", sessionId: "retry", input: 500, output: 400 });
  });
  const previousZcodeHome = process.env.ZCODE_HOME;
  const previousWslMode = process.env.TOKENTRACKER_WSL_MODE;
  process.env.ZCODE_HOME = path.join(home, ".zcode");
  process.env.TOKENTRACKER_WSL_MODE = "native-only";
  t.after(() => {
    if (previousZcodeHome === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = previousZcodeHome;
    if (previousWslMode === undefined) delete process.env.TOKENTRACKER_WSL_MODE;
    else process.env.TOKENTRACKER_WSL_MODE = previousWslMode;
  });
  const first = await buildSessionAnalytics({ home, force: true });
  assert.equal(first.length, 1);
  const sidecarPath = resolveSessionSidecarPath(home);
  const previousSidecar = fs.readFileSync(sidecarPath, "utf8");
  const previousMeta = fs.readFileSync(`${sidecarPath}.meta.json`, "utf8");
  const healthyDb = fs.readFileSync(dbPath);
  fs.writeFileSync(dbPath, "not a sqlite database");

  // The second failed build sees exactly the same stat signature as the
  // first. It must retry and keep reporting the failure, not hit an empty cache.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const failed = await buildSessionAnalytics({ home, cacheTtlMs: 0, force: attempt === 2 });
    assert.equal(failed.skippedFiles, 1);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].session_id, "retry");
    assert.equal(failed[0].total_tokens, first[0].total_tokens);
    assert.equal(fs.readFileSync(sidecarPath, "utf8"), previousSidecar);
    assert.equal(fs.readFileSync(`${sidecarPath}.meta.json`, "utf8"), previousMeta);
  }
  fs.writeFileSync(dbPath, healthyDb);
  const recovered = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
  assert.equal(recovered.skippedFiles, 0);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].total_tokens, first[0].total_tokens);
});

sqliteTest("a forced scan under a real SQLite lock invalidates TTL and unchanged-stat reuse until recovery", async (t) => {
  const { home, dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "locked" });
    insertModelUsage(db, { id: "locked-request", sessionId: "locked", input: 100, output: 200 });
  });
  const previousZcodeHome = process.env.ZCODE_HOME;
  const previousMode = process.env.TOKENTRACKER_WSL_MODE;
  process.env.ZCODE_HOME = path.join(home, ".zcode");
  process.env.TOKENTRACKER_WSL_MODE = "native-only";
  const lock = new DatabaseSync(dbPath);
  try {
    const first = await buildSessionAnalytics({ home, force: true });
    const sidecar = resolveSessionSidecarPath(home);
    const beforeSidecar = fs.readFileSync(sidecar, "utf8");
    const beforeMeta = fs.readFileSync(`${sidecar}.meta.json`, "utf8");
    const stat = fs.statSync(dbPath);
    lock.exec("BEGIN EXCLUSIVE");
    for (const options of [{ force: true }, {}, { cacheTtlMs: 0 }]) {
      const failed = await buildSessionAnalytics({ home, ...options });
      assert.equal(failed.skippedFiles, 1);
      assert.equal(failed[0].total_tokens, first[0].total_tokens);
      assert.equal(fs.readFileSync(sidecar, "utf8"), beforeSidecar);
      assert.equal(fs.readFileSync(`${sidecar}.meta.json`, "utf8"), beforeMeta);
      assert.equal(fs.statSync(dbPath).mtimeMs, stat.mtimeMs);
    }
    lock.exec("ROLLBACK");
    const recovered = await buildSessionAnalytics({ home });
    assert.equal(recovered.skippedFiles, 0);
    assert.equal(recovered[0].total_tokens, first[0].total_tokens);
    assert.equal(fs.existsSync(`${sidecar}.meta.json.zcode-incomplete`), false);
  } finally {
    lock.close();
    if (previousZcodeHome === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = previousZcodeHome;
    if (previousMode === undefined) delete process.env.TOKENTRACKER_WSL_MODE;
    else process.env.TOKENTRACKER_WSL_MODE = previousMode;
  }
});

const wslTest = DatabaseSync && process.platform === "win32" ? test : test.skip;

function buildDualDbs(t) {
  const native = buildDb(t, (db) => {
    insertSession(db, { id: "shared", directory: "C:\\repo\\shared", title: "Shared native" });
    insertSession(db, { id: "native-only", directory: "C:\\repo\\native" });
    insertModelUsage(db, { id: "shared-request", sessionId: "shared", input: 100, output: 1000, durationMs: 2000 });
    insertModelUsage(db, { id: "native-tail", sessionId: "shared", startedAt: T0 + 3600000, input: 200, output: 1000, durationMs: 4000 });
    insertModelUsage(db, { id: "native-request", sessionId: "native-only", input: 100, output: 200 });
    insertTurn(db, "shared", "shared-turn", 3);
    insertTurn(db, "shared", "native-turn");
    insertTool(db, "shared", "shared-turn", "Write");
    insertTool(db, "shared", "native-turn", "Edit");
  });
  const other = buildDb(t, (db) => {
    insertSession(db, { id: "shared", directory: "/repo/shared", title: "Shared mirror" });
    insertSession(db, { id: "wsl-only", directory: "/repo/wsl" });
    insertModelUsage(db, { id: "shared-request", sessionId: "shared", input: 100, output: 1000, durationMs: 2000 });
    insertModelUsage(db, { id: "wsl-tail", sessionId: "shared", startedAt: T0 + 7200000, input: 300, output: 1000, durationMs: 6000 });
    insertModelUsage(db, { id: "wsl-request", sessionId: "wsl-only", input: 200, output: 300 });
    insertTurn(db, "shared", "shared-turn", 3);
    insertTurn(db, "shared", "wsl-turn");
    insertTool(db, "shared", "shared-turn", "Write");
    insertTool(db, "shared", "wsl-turn", "Edit");
  });
  return { native, other };
}

sqliteTest("both installs retain distinct sessions and divergent tails without recounting shared event identities", async (t) => {
  const { native, other } = buildDualDbs(t);
  const rows = await scanZcodeSessions([native.dbPath, other.dbPath]);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.session_hash)).size, 3);
  assert.equal(rows.reduce((sum, row) => sum + row.total_tokens, 0), 4400);
  const shared = rows.find((row) => row.session_id === "shared");
  assert.equal(shared.total_tokens, 3600);
  assert.equal(shared.usage_events, 3);
  assert.equal(shared.turns, 3);
  assert.equal(shared.edit_turns, 3);
  assert.equal(shared.retry_turns, 0);
  assert.equal(shared.api_duration_ms, 12000);
  assert.equal(shared.active_ms, 12000);
  assert.equal(shared.performance.estimated_request_count, 3);
  assert.equal(shared.performance.estimated_output_tokens, 3000);
  assert.equal(shared.title, "Shared native");
  assert.equal(listSessionsForBrowser(rows).sessions.length, 3);
});

sqliteTest("ZCode discovery respects every install mode including both on a simulated Windows host", async (t) => {
  const { native, other } = buildDualDbs(t);
  for (const [mode, expected] of [
    ["both", [native.dbPath, other.dbPath]],
    ["native-only", [native.dbPath]],
    ["wsl-only", [other.dbPath]],
    ["native-first", [native.dbPath]],
    ["wsl-first", [other.dbPath]],
  ]) {
    const discovered = await discoverSessionFiles(native.home, {
      ZCODE_HOME: path.join(native.home, ".zcode"), TOKENTRACKER_WSL_MODE: mode,
    }, {
      platform: "win32", probeWsl: true,
      discoverWslHome: (provider) => provider === ".zcode" ? path.join(other.home, ".zcode") : null,
    });
    assert.deepEqual(discovered.zcode, expected, mode);
  }
});

sqliteTest("ZCode content probes distinguish confirmed empty databases from read failures", (t) => {
  const empty = buildDb(t, () => {});
  const populated = buildDb(t, (db) => insertSession(db, { id: "real" }));
  assert.equal(zcodeDbHasContent(empty.dbPath), false);
  assert.equal(zcodeDbHasContent(populated.dbPath), true);
  fs.writeFileSync(empty.dbPath, "unreadable sqlite database");
  assert.equal(zcodeDbHasContent(empty.dbPath), null);
  assert.equal(zcodeDbHasContent(path.join(empty.home, "missing.sqlite")), null);
});

sqliteTest("empty-shell fallback preserves both and exclusive modes in sync and session discovery", async (t) => {
  const populated = buildDb(t, (db) => {
    insertSession(db, { id: "real" });
    insertModelUsage(db, { id: "request", sessionId: "real", input: 500, output: 400 });
  });
  const empty = buildDb(t, () => {});
  for (const [native, other] of [[populated, empty], [empty, populated]]) {
    for (const [mode, expected] of [
      ["both", [native.dbPath, other.dbPath]],
      ["native-only", [native.dbPath]],
      ["wsl-only", [other.dbPath]],
      ["native-first", [populated.dbPath]],
      ["wsl-first", [populated.dbPath]],
    ]) {
      const env = { ZCODE_HOME: path.join(native.home, ".zcode"), TOKENTRACKER_WSL_MODE: mode };
      const paths = resolveZcodeInstallPaths({ nativeValue: native.dbPath, wslValue: other.dbPath }, env, { platform: "win32" });
      assert.deepEqual(Object.values(paths).filter(Boolean), expected, `sync ${mode}`);
      const discovered = await discoverSessionFiles(native.home, env, {
        platform: "win32", probeWsl: true,
        discoverWslHome: (provider) => provider === ".zcode" ? path.join(other.home, ".zcode") : null,
      });
      assert.deepEqual(discovered.zcode, expected, `sessions ${mode}`);
    }
  }
});

sqliteTest("a failed preferred ZCode database remains discoverable instead of being replaced", async (t) => {
  const healthy = buildDb(t, (db) => insertSession(db, { id: "real" }));
  const broken = buildDb(t, () => {});
  fs.writeFileSync(broken.dbPath, "unreadable sqlite database");
  for (const [mode, native, other] of [
    ["wsl-first", healthy, broken],
    ["native-first", broken, healthy],
  ]) {
    const env = { ZCODE_HOME: path.join(native.home, ".zcode"), TOKENTRACKER_WSL_MODE: mode };
    const paths = resolveZcodeInstallPaths({ nativeValue: native.dbPath, wslValue: other.dbPath }, env, { platform: "win32" });
    assert.deepEqual(Object.values(paths).filter(Boolean), [broken.dbPath]);
    const discovered = await discoverSessionFiles(native.home, env, {
      platform: "win32", probeWsl: true,
      discoverWslHome: (provider) => provider === ".zcode" ? path.join(other.home, ".zcode") : null,
    });
    assert.deepEqual(discovered.zcode, [broken.dbPath]);
    await assert.rejects(scanZcodeSessions(discovered.zcode));
  }
});

sqliteTest("both-mode usage sync counts a populated install once beside an empty shell", async (t) => {
  const empty = buildDb(t, () => {});
  const populated = buildDb(t, (db) => {
    insertSession(db, { id: "real" });
    insertModelUsage(db, { id: "request", sessionId: "real", input: 500, output: 400 });
  });
  const paths = resolveZcodeInstallPaths({ nativeValue: empty.dbPath, wslValue: populated.dbPath },
    { TOKENTRACKER_WSL_MODE: "both" }, { platform: "win32" });
  const queuePath = path.join(empty.home, "queue.jsonl");
  const reads = [];
  const cursors = {};
  for (let pass = 0; pass < 2; pass += 1) {
    await multiInstallParse({
      paths, providerName: "zcode", cursors, queuePath,
      getParams: (dbPath) => ({ dbPath }),
      parserFn: async (options) => {
        reads.push(options.dbPath);
        return parseOpencodeDbIncremental({ ...options, dbMessages: readZcodeDbMessages(options.dbPath), source: "zcode", cursorKey: "zcode" });
      },
    });
    const latest = new Map(fs.readFileSync(queuePath, "utf8").trim().split("\n").map((line) => {
      const row = JSON.parse(line);
      return [`${row.source}:${row.model}:${row.hour_start}`, row];
    }));
    assert.equal([...latest.values()].reduce((sum, row) => sum + row.total_tokens, 0), 900);
  }
  assert.deepEqual(reads, [empty.dbPath, populated.dbPath, empty.dbPath, populated.dbPath]);
});

for (const mode of ["wsl-first", "native-first"]) {
  for (const forceV2 of [false, true]) {
    sqliteTest(`${mode} retains cursor ownership after the preferred ZCode db gains data (${forceV2 ? "v2" : "legacy"} cursor store)`, async (t) => {
      const populated = buildDb(t, (db) => {
        insertSession(db, { id: "fallback", directory: "/repo/fallback" });
        insertModelUsage(db, { id: "fallback-request", sessionId: "fallback", input: 500, output: 400 });
      });
      const empty = buildDb(t, () => {});
      const native = mode === "wsl-first" ? populated : empty;
      const other = mode === "wsl-first" ? empty : populated;
      const restoreHome = withHome(native.home);
      const previousEnv = { ZCODE_HOME: process.env.ZCODE_HOME, TOKENTRACKER_WSL_MODE: process.env.TOKENTRACKER_WSL_MODE };
      mockPlatform(t, "win32");
      mockMethod(t, wsl, "discoverWslHome", (provider) => provider === ".zcode" ? path.join(other.home, ".zcode") : null);
      mockMethod(t, global, "fetch", async () => { throw new Error("unexpected network access"); });
      process.env.ZCODE_HOME = path.join(native.home, ".zcode");
      process.env.TOKENTRACKER_WSL_MODE = mode;
      const trackerDir = path.join(native.home, ".tokentracker", "tracker");
      const queuePath = path.join(trackerDir, "queue.jsonl");
      const projectQueuePath = path.join(trackerDir, "project.queue.jsonl");
      const statusZcode = async () => {
        // Let node:test flush the previous test's result before capturing CLI output.
        await new Promise((resolve) => setImmediate(resolve));
        let output = "";
        const write = process.stdout.write;
        process.stdout.write = (chunk) => { output += chunk; return true; };
        try { await cmdStatus(); } finally { process.stdout.write = write; }
        return output.split("\n").find((line) => line.startsWith("- ZCode:"));
      };
      try {
        // The diagnostic must use empty-shell fallback even before the first sync.
        assert.ok((await statusZcode()).includes(populated.dbPath));
        await cmdSync(["--auto", "--source=zcode"], { cursorStoreOptions: { forceV2 } });
        const first = fs.readFileSync(queuePath, "utf8");
        const firstProject = fs.readFileSync(projectQueuePath, "utf8");
        const { cursors, mode: storeMode } = await readCursorStateSummary({ trackerDir });
        assert.equal(storeMode, forceV2 ? "v2" : "legacy");
        assert.equal(cursors.zcodeInstallSelection.dbPath, populated.dbPath);

        const db = new DatabaseSync(empty.dbPath);
        insertSession(db, { id: "new-preferred", directory: "/repo/preferred" });
        insertModelUsage(db, { id: "new-request", sessionId: "new-preferred", input: 2000, output: 1000 });
        db.close();

        // Each command reopens persisted cursors; no in-memory selection cache.
        for (let pass = 0; pass < 2; pass += 1) {
          await cmdSync(["--auto", "--source=zcode"], { cursorStoreOptions: { forceV2 } });
          assert.equal(fs.readFileSync(queuePath, "utf8"), first, "preferred database must not enter the fallback ledger");
          assert.equal(fs.readFileSync(projectQueuePath, "utf8"), firstProject);
          const discovered = await discoverSessionFiles(native.home, process.env, { probeWsl: true });
          assert.deepEqual(discovered.zcode, [populated.dbPath]);
          const sessions = await scanZcodeSessions(discovered.zcode);
          assert.deepEqual(sessions.map((row) => row.session_id), ["fallback"]);
          assert.equal(sessions[0].total_tokens, 900);
          const status = await statusZcode();
          assert.ok(status.includes(populated.dbPath));
          assert.ok(!status.includes(empty.dbPath));
        }
        const fallbackDb = new DatabaseSync(populated.dbPath);
        insertModelUsage(fallbackDb, { id: "fallback-new-request", sessionId: "fallback", input: 100, output: 100 });
        fallbackDb.close();
        await cmdSync(["--auto", "--source=zcode"], { cursorStoreOptions: { forceV2 } });
        const updated = fs.readFileSync(queuePath, "utf8");
        const latest = new Map(updated.trim().split("\n").map((line) => {
          const row = JSON.parse(line);
          return [`${row.source}:${row.model}:${row.hour_start}`, row];
        }));
        assert.equal([...latest.values()].reduce((sum, row) => sum + row.total_tokens, 0), 1100, "the selected database still imports new requests");
        await cmdSync(["--auto", "--source=zcode"], { cursorStoreOptions: { forceV2 } });
        assert.equal(fs.readFileSync(queuePath, "utf8"), updated, "a repeat sync does not count the new request twice");
        const selection = (await readCursorStateSummary({ trackerDir })).cursors.zcodeInstallSelection;
        for (const [explicitMode, expected] of [
          ["native-only", [native.dbPath]], ["wsl-only", [other.dbPath]], ["both", [native.dbPath, other.dbPath]],
        ]) {
          const paths = resolveZcodeInstallPaths({ nativeValue: native.dbPath, wslValue: other.dbPath },
            { TOKENTRACKER_WSL_MODE: explicitMode }, { platform: "win32", selection });
          assert.deepEqual(Object.values(paths).filter(Boolean), expected, "explicit modes override the saved priority selection");
        }
      } finally {
        restoreHome();
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  }
}

sqliteTest("pre-marker ZCode history retains priority ownership while fresh metadata permits empty-shell fallback", (t) => {
  const preferred = buildDb(t, () => {});
  const alternate = buildDb(t, (db) => insertSession(db, { id: "alternate" }));
  for (const [name, cursors, hasHistory] of [
    ["messages", { zcode: { messages: { "old-request": { total_tokens: 900 } } } }, true],
    ["hourly buckets", { hourly: { buckets: { "zcode|GLM-5.3|2026-10-08T10:00:00.000Z": {} } } }, true],
    ["project buckets", { projectHourly: { buckets: { "project|zcode|2026-10-08T10:00:00.000Z": {} } } }, true],
    ["empty messages", { zcode: { messages: {} } }, false],
    ["updatedAt only", { zcode: { updatedAt: iso(T0) } }, false],
    ["migrations only", { migrations: { zcodeNativeUsageRepair_2026_08: { appliedAt: iso(T0) }, zcodeInclusiveTokenRepair_2026_09: { appliedAt: iso(T0) } } }, false],
  ]) {
    assert.equal(hasZcodeCursorState(cursors), hasHistory, name);
    for (const mode of ["native-first", "wsl-first"]) {
      const paths = mode === "native-first"
        ? { nativeValue: preferred.dbPath, wslValue: alternate.dbPath }
        : { nativeValue: alternate.dbPath, wslValue: preferred.dbPath };
      const env = { TOKENTRACKER_WSL_MODE: mode };
      assert.deepEqual(resolveZcodeInstallPaths(paths, env, { platform: "win32", cursors }),
        { native: hasHistory ? preferred.dbPath : alternate.dbPath, wsl: null }, `${mode}: ${name}`);
      if (hasHistory) {
        const missing = { ...paths, [mode === "native-first" ? "nativeValue" : "wslValue"]: null };
        assert.deepEqual(resolveZcodeInstallPaths(missing, env, { platform: "win32", cursors }),
          { native: alternate.dbPath, wsl: null }, `${mode}: retain the existing fallback when the preferred install is unavailable`);
      }
    }
  }
});

for (const mode of ["wsl-first", "native-first"]) {
  for (const forceV2 of [false, true]) {
    sqliteTest(`${mode} upgrades pre-marker history without importing the alternate database (${forceV2 ? "v2" : "legacy"} cursor store)`, async (t) => {
      const preferred = buildDb(t, (db) => {
        insertSession(db, { id: "old-preferred", directory: "/repo/preferred" });
        insertModelUsage(db, { id: "old-request", sessionId: "old-preferred", input: 500, output: 400 });
      });
      const alternate = buildDb(t, (db) => {
        insertSession(db, { id: "alternate", directory: "/repo/alternate" });
        insertModelUsage(db, { id: "alternate-request", sessionId: "alternate", input: 2000, output: 1000 });
      });
      const native = mode === "native-first" ? preferred : alternate;
      const other = mode === "native-first" ? alternate : preferred;
      const restoreHome = withHome(native.home);
      const previousEnv = { ZCODE_HOME: process.env.ZCODE_HOME, TOKENTRACKER_WSL_MODE: process.env.TOKENTRACKER_WSL_MODE };
      mockPlatform(t, "win32");
      mockMethod(t, wsl, "discoverWslHome", (provider) => provider === ".zcode" ? path.join(other.home, ".zcode") : null);
      mockMethod(t, global, "fetch", async () => { throw new Error("unexpected network access"); });
      process.env.ZCODE_HOME = path.join(native.home, ".zcode");
      process.env.TOKENTRACKER_WSL_MODE = mode;
      const trackerDir = path.join(native.home, ".tokentracker", "tracker");
      const cursorsPath = path.join(trackerDir, "cursors.json");
      const queuePath = path.join(trackerDir, "queue.jsonl");
      const projectQueuePath = path.join(trackerDir, "project.queue.jsonl");
      const statusZcode = async () => {
        await new Promise((resolve) => setImmediate(resolve));
        let output = "";
        const write = process.stdout.write;
        process.stdout.write = (chunk) => { output += chunk; return true; };
        try { await cmdStatus(); } finally { process.stdout.write = write; }
        return output.split("\n").find((line) => line.startsWith("- ZCode:"));
      };
      const queuedTotal = (content) => {
        const latest = new Map(content.trim().split("\n").filter(Boolean).map((line) => {
          const row = JSON.parse(line);
          return [`${row.source}:${row.model}:${row.hour_start}`, row];
        }));
        return [...latest.values()].reduce((sum, row) => sum + row.total_tokens, 0);
      };
      try {
        // Generate the older ledger through the real command, then remove only
        // the new ownership marker. Completed repairs must not hide a switch
        // by rebuilding the ledger from the alternate database.
        await cmdSync(["--auto", "--source=zcode"], { cursorStoreOptions: { forceV2: false }, scanSources: ["zcode"] });
        const first = fs.readFileSync(queuePath, "utf8");
        const firstProject = fs.readFileSync(projectQueuePath, "utf8");
        assert.equal(queuedTotal(first), 900);
        const legacy = JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
        assert.equal(legacy.zcodeInstallSelection.dbPath, preferred.dbPath);
        assert.ok(legacy.migrations.zcodeNativeUsageRepair_2026_08);
        assert.ok(legacy.migrations.zcodeInclusiveTokenRepair_2026_09);
        delete legacy.zcodeInstallSelection;
        fs.writeFileSync(cursorsPath, JSON.stringify(legacy));
        if (forceV2) {
          const store = await openCursorStore({ trackerDir, forceV2: true });
          assert.equal(store.mode, "v2");
          await store.commit();
        }
        const before = await readCursorStateSummary({ trackerDir });
        assert.equal(before.mode, forceV2 ? "v2" : "legacy");
        assert.equal(before.cursors.zcodeInstallSelection, undefined);
        const emptied = new DatabaseSync(preferred.dbPath);
        emptied.exec("DELETE FROM model_usage; DELETE FROM message; DELETE FROM session;");
        emptied.close();

        // Read-only commands also need the entire pre-marker cursor history,
        // before sync has had an opportunity to persist the marker.
        assert.deepEqual((await discoverSessionFiles(native.home, process.env, { probeWsl: true })).zcode, [preferred.dbPath]);
        assert.ok((await statusZcode()).includes(preferred.dbPath));
        const diagnostics = {};
        await cmdSync(["--auto", "--from-retry", "--source=zcode"], {
          cursorStoreOptions: { forceV2 }, scanSources: ["zcode"], diagnostics,
        });
        assert.equal(diagnostics.cursor_commits, 1, "an empty incremental sync must commit the new ownership marker");
        assert.equal(fs.readFileSync(queuePath, "utf8"), first, "the alternate 3000 tokens must not join the old 900-token ledger");
        assert.equal(fs.readFileSync(projectQueuePath, "utf8"), firstProject);
        const upgraded = await readCursorStateSummary({ trackerDir });
        assert.equal(upgraded.mode, forceV2 ? "v2" : "legacy");
        assert.deepEqual(upgraded.cursors.zcodeInstallSelection, {
          mode, zcodeHome: process.env.ZCODE_HOME, dbPath: preferred.dbPath,
        }, "ownership is persisted even when the old database has no rows");
        const discovered = await discoverSessionFiles(native.home, process.env, { probeWsl: true });
        assert.deepEqual(discovered.zcode, [preferred.dbPath]);
        assert.deepEqual(await scanZcodeSessions(discovered.zcode), []);
        const status = await statusZcode();
        assert.ok(status.includes(preferred.dbPath));
        assert.ok(!status.includes(alternate.dbPath));

        const restored = new DatabaseSync(preferred.dbPath);
        insertSession(restored, { id: "old-preferred", directory: "/repo/preferred" });
        insertModelUsage(restored, { id: "new-request", sessionId: "old-preferred", startedAt: T0 + 60000, input: 100, output: 100 });
        restored.close();
        await cmdSync(["--auto", "--source=zcode"], { cursorStoreOptions: { forceV2 }, scanSources: ["zcode"] });
        const updated = fs.readFileSync(queuePath, "utf8");
        const updatedProject = fs.readFileSync(projectQueuePath, "utf8");
        assert.equal(queuedTotal(updated), 1100, "the original owner can still append new requests");
        await cmdSync(["--auto", "--source=zcode"], { cursorStoreOptions: { forceV2 }, scanSources: ["zcode"] });
        assert.equal(fs.readFileSync(queuePath, "utf8"), updated, "a repeated sync does not count the new request twice");
        assert.equal(fs.readFileSync(projectQueuePath, "utf8"), updatedProject);
      } finally {
        restoreHome();
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  }
}

sqliteTest("saved ZCode ownership survives an unavailable install without changing explicit modes or homes", (t) => {
  const native = buildDb(t, (db) => insertSession(db, { id: "native" }));
  const other = buildDb(t, (db) => insertSession(db, { id: "wsl" }));
  const selection = { mode: "wsl-first", zcodeHome: null, dbPath: other.dbPath };
  const env = { TOKENTRACKER_WSL_MODE: "wsl-first" };
  fs.unlinkSync(other.dbPath);
  assert.deepEqual(resolveZcodeInstallPaths({ nativeValue: native.dbPath, wslValue: null }, env,
    { platform: "win32", selection }), { native: other.dbPath, wsl: null });
  assert.deepEqual(resolveZcodeInstallPaths({ nativeValue: native.dbPath, wslValue: null },
    { TOKENTRACKER_WSL_MODE: "native-only" }, { platform: "win32", selection }), { native: native.dbPath, wsl: null });
  const replacement = buildDb(t, (db) => insertSession(db, { id: "replacement" }));
  assert.deepEqual(resolveZcodeInstallPaths({ nativeValue: replacement.dbPath, wslValue: null },
    { ...env, ZCODE_HOME: path.join(replacement.home, ".zcode") },
    { platform: "win32", selection }), { native: replacement.dbPath, wsl: null });
  const nativeSelection = { mode: "wsl-first", zcodeHome: null, dbPath: native.dbPath };
  assert.deepEqual(resolveZcodeInstallPaths({ nativeValue: native.dbPath, wslValue: replacement.dbPath }, env,
    { platform: "win32", selection: nativeSelection }), { native: native.dbPath, wsl: null },
  "discovering a new preferred install must not replace the already-counted fallback");
});

sqliteTest("Codex and ZCode lineage remains independent when their session IDs collide", async (t) => {
  const { dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "root" });
    insertSession(db, { id: "child", parentId: "root" });
    insertModelUsage(db, { id: "root-request", sessionId: "root", input: 100, output: 200 });
    insertModelUsage(db, { id: "child-request", sessionId: "child", input: 200, output: 300 });
  });
  const zcode = await scanZcodeSessions(dbPath);
  const codex = zcode.map((row) => ({ ...row, source: "codex", session_hash: `codex-${row.session_id}` }));
  const browser = listSessionsForBrowser([...zcode, ...codex]).sessions;
  for (const source of ["codex", "zcode"]) {
    const root = browser.find((row) => row.source === source && row.session_id === "root");
    const child = browser.find((row) => row.source === source && row.session_id === "child");
    assert.equal(root.direct_subagent_count, 1);
    assert.equal(root.combined_total_tokens, 800);
    assert.equal(child.parent_session_hash, root.session_hash);
    assert.equal(child.root_session_hash, root.session_hash);
    assert.equal(root.parent_link_conflict, false);
    assert.equal(child.parent_link_conflict, false);
  }
  assert.equal(summarizeSessions([...zcode, ...codex]).subagents[0].calls, 2);
});

sqliteTest("forked ZCode history matches the usage ledger without copied token or speed samples", async (t) => {
  const { home, dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "original" });
    insertSession(db, { id: "fork", created: T0 + 3600000 });
    insertModelUsage(db, { id: "1-original", sessionId: "original", input: 100, output: 1000, durationMs: 3000 });
    insertModelUsage(db, { id: "2-copy", sessionId: "fork", input: 100, output: 1000, durationMs: 3000 });
    insertModelUsage(db, { id: "3-tail", sessionId: "fork", startedAt: T0 + 3600000, input: 200, output: 1000, durationMs: 4000 });
  });
  const queuePath = path.join(home, "queue.jsonl");
  await parseOpencodeDbIncremental({
    dbMessages: readZcodeDbMessages(dbPath), dbPath, cursors: {},
    queuePath, source: "zcode", cursorKey: "zcode",
  });
  const latest = new Map(fs.readFileSync(queuePath, "utf8").trim().split("\n").map((line) => {
    const row = JSON.parse(line);
    return [`${row.source}:${row.model}:${row.hour_start}`, row];
  }));
  const ledgerTotal = [...latest.values()].reduce((sum, row) => sum + row.total_tokens, 0);
  const rows = await scanZcodeSessions(dbPath);
  assert.equal(rows.reduce((sum, row) => sum + row.total_tokens, 0), ledgerTotal);
  assert.equal(ledgerTotal, 2300);
  const fork = rows.find((row) => row.session_id === "fork");
  assert.equal(fork.total_tokens, 1200);
  assert.equal(fork.api_duration_ms, 4000);
  assert.equal(fork.performance.estimated_request_count, 1);
  assert.equal(fork.performance.estimated_output_tokens, 1000);
});

wslTest("both-install cache preserves the complete union across cache hits, appends and read failures", async (t) => {
  const { native, other } = buildDualDbs(t);
  const restoreHome = withHome(native.home);
  const previousZcodeHome = process.env.ZCODE_HOME;
  const previousMode = process.env.TOKENTRACKER_WSL_MODE;
  const discoverWslHome = wsl.discoverWslHome;
  process.env.ZCODE_HOME = path.join(native.home, ".zcode");
  process.env.TOKENTRACKER_WSL_MODE = "both";
  wsl.discoverWslHome = (provider) => provider === ".zcode" ? path.join(other.home, ".zcode") : null;
  try {
    const first = await buildSessionAnalytics({ home: native.home, force: true });
    assert.equal(first.length, 3);
    assert.equal(first.reduce((sum, row) => sum + row.total_tokens, 0), 4400);
    assert.equal(new Set(first.map((row) => row._cache_key)).size, 3);
    const cached = await buildSessionAnalytics({ home: native.home, cacheTtlMs: 0 });
    assert.equal(cached.length, 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const db = new DatabaseSync(other.dbPath);
    insertSession(db, { id: "new-wsl" });
    insertModelUsage(db, { id: "new-wsl-request", sessionId: "new-wsl", input: 100, output: 100 });
    db.close();
    const appended = await buildSessionAnalytics({ home: native.home, cacheTtlMs: 0 });
    assert.equal(appended.length, 4);
    assert.equal(appended.reduce((sum, row) => sum + row.total_tokens, 0), 4600);
    const sidecar = resolveSessionSidecarPath(native.home);
    const beforeSidecar = fs.readFileSync(sidecar, "utf8");
    const beforeMeta = fs.readFileSync(`${sidecar}.meta.json`, "utf8");
    const healthy = fs.readFileSync(other.dbPath);
    fs.writeFileSync(other.dbPath, "unreadable sqlite snapshot");
    for (const force of [false, true]) {
      const failed = await buildSessionAnalytics({ home: native.home, cacheTtlMs: 0, force });
      assert.equal(failed.skippedFiles, 1);
      assert.equal(failed.length, 4);
      assert.equal(fs.readFileSync(sidecar, "utf8"), beforeSidecar);
      assert.equal(fs.readFileSync(`${sidecar}.meta.json`, "utf8"), beforeMeta);
    }
    fs.writeFileSync(other.dbPath, healthy);
    assert.equal((await buildSessionAnalytics({ home: native.home, cacheTtlMs: 0 })).skippedFiles, 0);
  } finally {
    wsl.discoverWslHome = discoverWslHome;
    if (previousZcodeHome === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = previousZcodeHome;
    if (previousMode === undefined) delete process.env.TOKENTRACKER_WSL_MODE;
    else process.env.TOKENTRACKER_WSL_MODE = previousMode;
    restoreHome();
  }
});
wslTest("zcode discovery follows the WSL install when no native db exists", async (t) => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-native-empty-"));
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-wsl-"));
  t.after(() => {
    fs.rmSync(nativeHome, { recursive: true, force: true });
    fs.rmSync(wslHome, { recursive: true, force: true });
  });
  const wslDb = path.join(wslHome, "cli", "db", "db.sqlite");
  fs.mkdirSync(path.dirname(wslDb), { recursive: true });
  const db = createFixtureDb(wslDb);
  insertSession(db, { id: "sess-wsl", directory: "/home/dev/repo", created: T0 });
  db.close();

  const discovered = await discoverSessionFiles(nativeHome, {
    ZCODE_HOME: path.join(nativeHome, ".zcode"),
    TOKENTRACKER_WSL_MODE: "wsl-first",
  }, { discoverWslHome: () => wslHome, probeWsl: true });
  assert.deepEqual(discovered.zcode, [wslDb]);
});

wslTest("an empty WSL db must not shadow the populated native one", async (t) => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-native-full-"));
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-wsl-shell-"));
  t.after(() => {
    fs.rmSync(nativeHome, { recursive: true, force: true });
    fs.rmSync(wslHome, { recursive: true, force: true });
  });
  // Native install with a real session, WSL install that only ran once and
  // keeps an empty database (observed on a real machine): under the default
  // wsl-first single pick the shell db evicted the populated native one and
  // the browser showed zero ZCode sessions. The mode pick must yield to the
  // install that actually holds content.
  const nativeDb = path.join(nativeHome, ".zcode", "cli", "db", "db.sqlite");
  fs.mkdirSync(path.dirname(nativeDb), { recursive: true });
  const native = createFixtureDb(nativeDb);
  insertSession(native, { id: "sess-native-real", directory: "C:\\repo\\native", created: T0 });
  insertModelUsage(native, { id: "n1", sessionId: "sess-native-real", startedAt: T0, input: 500, output: 400, durationMs: 3000 });
  native.close();
  const wslDb = path.join(wslHome, "cli", "db", "db.sqlite");
  fs.mkdirSync(path.dirname(wslDb), { recursive: true });
  createFixtureDb(wslDb).close();

  const discovered = await discoverSessionFiles(nativeHome, {
    ZCODE_HOME: path.join(nativeHome, ".zcode"),
    TOKENTRACKER_WSL_MODE: "wsl-first",
  }, { discoverWslHome: () => wslHome, probeWsl: true });
  assert.deepEqual(discovered.zcode, [nativeDb]);

  // "both" still reads every path; the empty db simply contributes nothing.
  const both = await discoverSessionFiles(nativeHome, {
    ZCODE_HOME: path.join(nativeHome, ".zcode"),
    TOKENTRACKER_WSL_MODE: "both",
  }, { discoverWslHome: () => wslHome, probeWsl: true });
  assert.deepEqual([...both.zcode].sort(), [nativeDb, wslDb].sort());

  // End to end: the populated native sessions reach the analytics build even
  // though the shell WSL db sits beside them.
  const built = await buildSessionAnalytics({ home: nativeHome, force: true });
  const zcodeBuilt = built.filter((row) => row.source === "zcode");
  assert.equal(zcodeBuilt.length, 1);
  assert.equal(zcodeBuilt[0].session_id, "sess-native-real");
  assert.equal(zcodeBuilt[0].total_tokens, 500 + 400);
});

wslTest("zcode discovery skips WSL for an injected home unless probeWsl opts in", async (t) => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-isolated-"));
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-wsl-decoy-"));
  t.after(() => {
    fs.rmSync(nativeHome, { recursive: true, force: true });
    fs.rmSync(wslHome, { recursive: true, force: true });
  });
  let probed = false;
  // A custom home must stay isolated: discoverWslHome resolves \\wsl$ against
  // the machine, not `home`, so probing would splice the live WSL install's
  // sessions into a tree the caller expects to control.
  const discovered = await discoverSessionFiles(nativeHome, {
    ZCODE_HOME: path.join(nativeHome, ".zcode"),
    TOKENTRACKER_WSL_MODE: "wsl-first",
  }, { discoverWslHome: () => { probed = true; return wslHome; } });
  assert.equal(probed, false);
  assert.deepEqual(discovered.zcode, []);
});

sqliteTest("ZCODE_HOME discovery feeds buildSessionAnalytics with stable per-session cache keys", async (t) => {
  const { home, dbPath } = buildDb(t, (db) => {
    insertSession(db, { id: "sess-a", directory: "C:\\repo\\a", title: "Root", created: T0, updated: T0 + 60000 });
    insertModelUsage(db, { id: "a1", sessionId: "sess-a", startedAt: T0, input: 1200, cacheRead: 1000, output: 800, durationMs: 4000, ttfb: 600 });
  });
  const previousZcodeHome = process.env.ZCODE_HOME;
  process.env.ZCODE_HOME = path.join(home, ".zcode");
  // Pin the WSL mode so a real WSL install on the test machine cannot pull
  // discovery away from the fixture's native db (default mode is wsl-first).
  const previousWslMode = process.env.TOKENTRACKER_WSL_MODE;
  process.env.TOKENTRACKER_WSL_MODE = "native-only";
  t.after(() => {
    if (previousZcodeHome === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = previousZcodeHome;
    if (previousWslMode === undefined) delete process.env.TOKENTRACKER_WSL_MODE;
    else process.env.TOKENTRACKER_WSL_MODE = previousWslMode;
  });

  const discovered = await discoverSessionFiles(home);
  assert.deepEqual(discovered.zcode, [dbPath]);

  const first = await buildSessionAnalytics({ home, force: true });
  const zcodeFirst = first.filter((row) => row.source === "zcode");
  assert.equal(zcodeFirst.length, 1);
  assert.equal(zcodeFirst[0].session_id, "sess-a");
  assert.equal(zcodeFirst[0].total_tokens, 200 + 1000 + 800);

  // A claude transcript appearing later changes the overall signature, which
  // forces a rebuild pass. The untouched zcode db must come back from cache —
  // one row, unchanged content — never duplicated, and its cache key stays
  // unique per session (the db path plus the session id).
  await new Promise((resolve) => setTimeout(resolve, 20));
  const claudeDir = path.join(home, ".claude", "projects", "repo");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "cs1.jsonl"), [
    JSON.stringify({ type: "user", uuid: "u1", timestamp: iso(T0), sessionId: "cs1", message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: iso(T0 + 1000), sessionId: "cs1", message: { id: "a1", model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: "end_turn", content: [] } }),
    "",
  ].join("\n"));

  const second = await buildSessionAnalytics({ home, force: false, cacheTtlMs: 0 });
  const zcodeSecond = second.filter((row) => row.source === "zcode");
  assert.equal(zcodeSecond.length, 1);
  assert.equal(zcodeSecond[0].session_id, "sess-a");
  assert.equal(zcodeSecond[0].total_tokens, zcodeFirst[0].total_tokens);
  assert.equal(second.filter((row) => row.source === "claude").length, 1);
  const keys = second.map((row) => row._cache_key);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, keys.length);
});
