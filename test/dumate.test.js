const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { test } = require("node:test");
const { runSql } = require("./helpers/sqlite-write");
const { resolveDumateDbPaths, parseDumateIncremental } = require("../src/lib/dumate");
const { cmdSync, readQueueBatch, drainQueueToCloud } = require("../src/commands/sync");
const { compactPendingQueue } = require("../src/lib/upload-queue");
const { readOpencodeDbMessages } = require("../src/lib/rollout");

async function buildDb(root, install, rows) {
  const dbPath = path.join(root, install, "data", "opencode", "opencode.db");
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  runSql(dbPath, "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);");
  for (const { id, session = "ses_dumate", input = 1070, updated = 1791443003257, provider = "QianfanPersonalQuota", model = "glm-5", nested = false, tokens } of rows) {
    const data = JSON.stringify({
      role: "assistant",
      ...(nested ? { model: { id: model, providerID: provider } } : { modelID: model, providerID: provider }),
      time: { created: 1791442995758, completed: 1791443003257 },
      tokens: tokens || { total: input + 888 + 768, input, output: 888, reasoning: 818, cache: { read: 768, write: 0 } },
    }).replace(/'/g, "''");
    runSql(dbPath, `INSERT INTO message VALUES ('${id}', '${session}', 1791442995758, ${updated}, '${data}');`);
  }
  return dbPath;
}

test("DuMate discovers every Windows install and pins explicit overrides", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-dumate-paths-"));
  try {
    const root = path.join(tmp, "qianfan-desktop-app", "qianfan_desk_xdg");
    const first = await buildDb(root, "first", []);
    const second = await buildDb(root, "second", []);
    await fs.mkdir(path.join(root, "incomplete"));
    assert.deepEqual(resolveDumateDbPaths({ env: { APPDATA: tmp }, platform: "win32" }), [first, second]);
    assert.deepEqual(resolveDumateDbPaths({ env: { APPDATA: tmp }, platform: "darwin" }), []);
    assert.deepEqual(resolveDumateDbPaths({ env: { APPDATA: tmp, TOKENTRACKER_DUMATE_HOME: path.dirname(first) } }), [first]);
    assert.deepEqual(resolveDumateDbPaths({ env: { TOKENTRACKER_DUMATE_HOME: path.join(root, "first") } }), [first]);
    assert.deepEqual(resolveDumateDbPaths({ env: { APPDATA: tmp, TOKENTRACKER_DUMATE_HOME: path.join(tmp, "missing") }, platform: "win32" }), []);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("DuMate SQLite downward and zero corrections survive compaction and HTTP upload exactly once", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-dumate-zero-upload-"));
  let server;
  try {
    const dbPath = await buildDb(tmp, "first", [{ id: "msg_corrected" }]);
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const cursors = {};
    const parse = () => parseDumateIncremental({ dbPaths: [dbPath], cursors, queuePath });
    await parse();
    const prefix = await fs.readFile(queuePath, "utf8");
    assert.equal(JSON.parse(prefix).total_tokens, 2726);
    const offset = Buffer.byteLength(prefix);
    await fs.writeFile(queueStatePath, JSON.stringify({ offset }));
    const correct = (tokens, updated) => {
      const json = JSON.stringify(tokens).replace(/'/g, "''");
      runSql(dbPath, `UPDATE message SET data = json_set(data, '$.tokens', json('${json}')), time_updated = ${updated} WHERE id = 'msg_corrected';`);
    };
    correct({ total: 1000, input: 500, output: 400, reasoning: 300, cache: { read: 100, write: 0 } }, 1791443004000);
    await parse();
    assert.equal((await readQueueBatch(queuePath, offset, 200)).buckets[0].total_tokens, 1000);
    correct({ total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 1791443005000);
    await parse();
    const latest = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse).at(-1);
    assert.equal(latest.total_tokens, 0);
    for (const column of ["input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "reasoning_output_tokens"]) assert.equal(latest[column], 0);
    const before = await fs.readFile(queuePath, "utf8");
    assert.equal((await parse()).eventsAggregated, 0);
    assert.equal(await fs.readFile(queuePath, "utf8"), before);
    assert.equal(readOpencodeDbMessages(dbPath).length, 0, "default OpenCode reads still omit zero-token records");
    assert.equal((await compactPendingQueue({ queuePath, offset, minPendingBytes: 0 })).removedRecords, 1);
    const compacted = await fs.readFile(queuePath, "utf8");
    assert.ok(compacted.startsWith(prefix), "uploaded history is unchanged");
    assert.equal((await readQueueBatch(queuePath, offset, 200)).buckets[0].total_tokens, 0);
    let calls = 0;
    let payload;
    server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (bytes) => { body += bytes; });
      request.on("end", () => {
        calls += 1;
        payload = JSON.parse(body);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, inserted: 1, upload_scope: "cloud" }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const upload = () => drainQueueToCloud({ baseUrl: `http://127.0.0.1:${server.address().port}`, deviceToken: "fixture-token", queuePath, queueStatePath });
    assert.equal((await upload()).batches, 1);
    assert.equal(payload.hourly[0].source, "dumate");
    assert.equal(payload.hourly[0].total_tokens, 0);
    assert.equal(payload.hourly[0].total_cost_usd, 0);
    assert.equal((await upload()).batches, 0);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, Buffer.byteLength(compacted));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("first-time DuMate zero messages do not create usage or claim OpenCode cursors", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-dumate-first-zero-"));
  try {
    const tokens = { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    const dbPath = await buildDb(tmp, "first", [{ id: "msg_zero", tokens }]);
    const cursors = { opencode: { messages: { "ses_dumate|msg_zero": { lastTotals: { total_tokens: 2726 } } } } };
    const queuePath = path.join(tmp, "queue.jsonl");
    assert.equal((await parseDumateIncremental({ dbPaths: [dbPath], cursors, queuePath })).eventsAggregated, 0);
    assert.equal(cursors.dumate, undefined);
    await assert.rejects(fs.stat(queuePath), { code: "ENOENT" });
    assert.equal(cursors.opencode.messages["ses_dumate|msg_zero"].lastTotals.total_tokens, 2726);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

for (const reverse of [false, true]) {
  test(`first-run DuMate chooses a newer zero copy over stale usage (${reverse ? "new first" : "old first"})`, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-dumate-zero-copy-"));
    try {
      const oldCopy = await buildDb(tmp, "old", [{ id: "msg_copy", updated: 1791443004000 }]);
      const newCopy = await buildDb(tmp, "new", [{ id: "msg_copy", updated: 1791443005000,
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }]);
      const cursors = { opencode: { messages: { "ses_dumate|msg_copy": { lastTotals: { total_tokens: 2726 } } } } };
      const queuePath = path.join(tmp, "queue.jsonl");
      const result = await parseDumateIncremental({ dbPaths: reverse ? [newCopy, oldCopy] : [oldCopy, newCopy], cursors, queuePath });
      assert.equal(result.eventsAggregated, 0);
      assert.equal(cursors.dumate, undefined);
      await assert.rejects(fs.stat(queuePath), { code: "ENOENT" });
      assert.equal(cursors.opencode.messages["ses_dumate|msg_copy"].lastTotals.total_tokens, 2726);
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  });
}

test("DuMate counts its Qianfan runtime and excludes imported Claude and OpenCode history", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-dumate-imports-"));
  try {
    const dbPath = await buildDb(tmp, "first", [
      { id: "msg_native" },
      { id: "msg_nested", nested: true, model: "custom-native-model" },
      { id: "msg_claude_import", provider: "anthropic", model: "glm-5" },
      { id: "msg_opencode_import", provider: "opencode", model: "glm-5" },
      { id: "msg_unknown", provider: "", model: "glm-5" },
    ]);
    const cursors = {};
    const queuePath = path.join(tmp, "queue.jsonl");
    const result = await parseDumateIncremental({ dbPaths: [dbPath], cursors, queuePath });
    assert.equal(result.eventsAggregated, 2);
    assert.deepEqual(Object.keys(cursors.dumate.messages).sort(), ["ses_dumate|msg_native", "ses_dumate|msg_nested"]);
    const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(rows.some((row) => row.model === "custom-native-model"), "provider identity, not model name, identifies DuMate usage");
    assert.equal((await parseDumateIncremental({ dbPaths: [dbPath], cursors, queuePath })).eventsAggregated, 0);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("DuMate deduplicates reinstall copies, keeps newest usage, and remains independent from OpenCode", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-dumate-parser-"));
  try {
    const first = await buildDb(tmp, "first", [{ id: "msg_same" }]);
    const second = await buildDb(tmp, "second", [
      { id: "msg_same", input: 1170, updated: 1791443004000 },
      { id: "msg_unique", session: "ses_other", input: 50 },
    ]);
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = { opencode: { messages: { "ses_dumate|msg_same": { lastTotals: { input_tokens: 1170 } } } } };
    const result = await parseDumateIncremental({ dbPaths: [first, second], cursors, queuePath });
    assert.equal(result.eventsAggregated, 2);
    const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const latest = rows.at(-1);
    assert.equal(latest.source, "dumate");
    assert.equal(latest.input_tokens, 1220);
    assert.equal(latest.output_tokens, 140);
    assert.equal(latest.reasoning_output_tokens, 1636);
    assert.equal(latest.cached_input_tokens, 1536);
    assert.equal(latest.total_tokens, 4532);
    assert.ok(cursors.opencode.messages["ses_dumate|msg_same"]);
    const before = await fs.readFile(queuePath, "utf8");
    assert.equal((await parseDumateIncremental({ dbPaths: [first, second], cursors, queuePath })).eventsAggregated, 0);
    assert.equal(await fs.readFile(queuePath, "utf8"), before);
    // A temporarily unavailable new installation must not let its stale copy
    // roll back the message cursor or inflate usage when it returns.
    assert.equal((await parseDumateIncremental({ dbPaths: [first], cursors, queuePath })).eventsAggregated, 0);
    assert.equal((await parseDumateIncremental({ dbPaths: [first, second], cursors, queuePath })).eventsAggregated, 0);
    assert.equal(await fs.readFile(queuePath, "utf8"), before);
    await fs.rm(path.join(tmp, "first"), { recursive: true, force: true });
    assert.equal((await parseDumateIncremental({ dbPaths: [second], cursors, queuePath })).eventsAggregated, 0);
    const copied = await buildDb(tmp, "third", [{ id: "msg_same", input: 1170, updated: 1791443004000 }]);
    assert.equal((await parseDumateIncremental({ dbPaths: [second, copied], cursors, queuePath })).eventsAggregated, 0);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("DuMate read failure preserves cursors instead of silently replacing usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-dumate-error-"));
  try {
    const dbPath = path.join(tmp, "broken.db");
    await fs.writeFile(dbPath, "not sqlite");
    const cursors = { dumate: { messages: {} } };
    await assert.rejects(parseDumateIncremental({ dbPaths: [dbPath], cursors, queuePath: path.join(tmp, "queue.jsonl") }));
    assert.deepEqual(cursors, { dumate: { messages: {} } });
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("source-scoped sync collects DuMate and emits no additional queue rows on its second run", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-dumate-sync-"));
  const saved = process.env.TOKENTRACKER_DUMATE_HOME;
  try {
    const root = path.join(tmp, "installs");
    await buildDb(root, "first", [{ id: "msg_sync" }]);
    process.env.TOKENTRACKER_DUMATE_HOME = root;
    const trackerDataDir = path.join(tmp, "tracker");
    await fs.mkdir(trackerDataDir);
    await fs.writeFile(path.join(trackerDataDir, "cloud-sync-pref.json"), JSON.stringify({ enabled: false }));
    const args = ["--auto", "--from-notify", "--source", "dumate"];
    await cmdSync(args, { home: tmp, trackerDataDir });
    const queuePath = path.join(trackerDataDir, "queue.jsonl");
    const before = await fs.readFile(queuePath, "utf8");
    const rows = before.trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "dumate");
    assert.equal(rows[0].output_tokens, 70);
    assert.equal(rows[0].reasoning_output_tokens, 818);
    assert.equal(rows[0].total_tokens, 2726);
    await cmdSync(args, { home: tmp, trackerDataDir });
    assert.equal(await fs.readFile(queuePath, "utf8"), before);
  } finally {
    if (saved === undefined) delete process.env.TOKENTRACKER_DUMATE_HOME;
    else process.env.TOKENTRACKER_DUMATE_HOME = saved;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
