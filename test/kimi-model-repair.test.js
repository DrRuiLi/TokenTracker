"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { repairKimiModelAttribution, KIMI_MODEL_REPAIR_KEY } = require("../src/lib/kimi-model-repair");
const { parseKimiIncremental, parseKimiCodeIncremental } = require("../src/lib/rollout");
const { compactPendingQueue } = require("../src/lib/upload-queue");
const time = Date.UTC(2026, 9, 15);
const step = (id) => ({ type: "context.append_loop_event", time, event: { type: "step.end", uuid: id,
  usage: { inputOther: 100, inputCacheRead: 80, inputCacheCreation: 0, output: 20 } } });
const rows = (bytes) => bytes.toString().trim().split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
const latest = (bytes) => new Map(rows(bytes).map((row) => [`${row.source}|${row.model}|${row.hour_start}`, row]));

async function fixture(t, { uploaded = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-kimi-repair-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "wire.jsonl"), queuePath = path.join(dir, "queue.jsonl");
  await fs.writeFile(file, [{ type: "profile.bind", modelAlias: "kimi-code/k3-256k", time }, step("first")].map(JSON.stringify).join("\n") + "\n");
  const cursors = {};
  await parseKimiCodeIncremental({ wireFiles: [file], cursors, queuePath, env: {} });
  // Reproduce the old parser's missed profile.bind, including its persisted offset.
  const misattribute = (text) => text.replaceAll("k3-256k", "kimi-for-coding");
  await fs.writeFile(queuePath, misattribute(await fs.readFile(queuePath, "utf8")));
  const oldCursors = JSON.parse(misattribute(JSON.stringify(cursors)));
  const before = await fs.readFile(queuePath), queueStatePath = path.join(dir, "queue.state.json");
  await fs.writeFile(queueStatePath, JSON.stringify({ offset: uploaded ? before.length : 0, untouched: "keep" }));
  return { dir, file, before, cursors: oldCursors, queuePath, queueStatePath,
    legacyFiles: [], officialFiles: [file], parseLegacy: parseKimiIncremental, parseOfficial: parseKimiCodeIncremental, env: {} };
}
const repair = (f) => repairKimiModelAttribution(f);
async function compact(f) {
  const { offset } = JSON.parse(await fs.readFile(f.queueStatePath));
  await compactPendingQueue({ queuePath: f.queuePath, offset, minPendingBytes: 0 });
}
function assertCorrect(bytes, expected = 200) {
  const values = [...latest(bytes).values()];
  assert.equal(values.filter((row) => row.model === "kimi-for-coding").reduce((sum, row) => sum + row.total_tokens, 0), 0);
  assert.equal(values.filter((row) => row.model === "k3-256k").reduce((sum, row) => sum + row.total_tokens, 0), expected);
}

for (const uploaded of [false, true]) test(`Kimi model repair preserves uploaded prefix and corrects ${uploaded ? "uploaded" : "pending"} buckets`, async (t) => {
  const f = await fixture(t, { uploaded });
  const stateBefore = await fs.readFile(f.queueStatePath);
  assert.equal((await repair(f)).repaired, true);
  await compact(f);
  const after = await fs.readFile(f.queuePath);
  assertCorrect(after);
  if (uploaded) assert.deepEqual(after.subarray(0, f.before.length), f.before);
  assert.deepEqual(await fs.readFile(f.queueStatePath), stateBefore);
  const pending = rows(after.subarray(uploaded ? f.before.length : 0));
  assert.equal(pending.filter((row) => row.model === "kimi-for-coding").length, 1);
  assert.equal(pending.find((row) => row.model === "kimi-for-coding").total_tokens, 0);
  assert.equal((await parseKimiCodeIncremental({ ...f, wireFiles: [f.file] })).eventsAggregated, 0);
  assert.equal((await repair(f)).repaired, false);
  assert.deepEqual(await fs.readFile(f.queuePath), after);
});

test("Kimi repair retries a partial append from its journal without recounting", async (t) => {
  const f = await fixture(t, { uploaded: true });
  const beforeCursors = JSON.parse(JSON.stringify(f.cursors));
  const original = fs.appendFile;
  fs.appendFile = async (target, data, ...args) => {
    if (target === f.queuePath) {
      await original(target, String(data).slice(0, 45), ...args);
      throw new Error("interrupted append");
    }
    return original(target, data, ...args);
  };
  try { await assert.rejects(repair(f), /interrupted append/); } finally { fs.appendFile = original; }
  assert.deepEqual(f.cursors, beforeCursors);
  assert.equal((await repair(f)).repaired, true);
  await compact(f);
  assertCorrect(await fs.readFile(f.queuePath));
  const saved = JSON.parse(JSON.stringify(f.cursors));
  f.cursors = saved;
  assert.equal((await repair(f)).repaired, false);
  await assert.rejects(fs.stat(`${f.queuePath}.kimi-model-repair.json`), { code: "ENOENT" });
});

test("Kimi repair does not touch history when a previously parsed source disappears or truncates", async (t) => {
  const f = await fixture(t);
  f.cursors.kimiCode.fileOffsets[`${f.file}.missing`] = { size: 50 };
  assert.equal((await repair(f)).deferred, "missing-source");
  delete f.cursors.kimiCode.fileOffsets[`${f.file}.missing`];
  await fs.truncate(f.file, 5);
  assert.equal((await repair(f)).deferred, "truncated-source");
  assert.deepEqual(await fs.readFile(f.queuePath), f.before);
  assert.equal(f.cursors.migrations?.[KIMI_MODEL_REPAIR_KEY], undefined);
});

test("new Kimi usage settles before repair, then consecutive parses keep the corrected total", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.file, JSON.stringify(step("second")) + "\n");
  assert.equal((await repair(f)).deferred, "totals-not-conserved");
  await parseKimiCodeIncremental({ ...f, wireFiles: [f.file] });
  assert.equal((await repair(f)).repaired, true);
  await compact(f);
  assertCorrect(await fs.readFile(f.queuePath), 400);
  for (let index = 0; index < 2; index++) {
    assert.equal((await parseKimiCodeIncremental({ ...f, wireFiles: [f.file] })).eventsAggregated, 0);
    assertCorrect(await fs.readFile(f.queuePath), 400);
  }
  await fs.appendFile(f.file, JSON.stringify(step("third")) + "\n");
  assert.equal((await parseKimiCodeIncremental({ ...f, wireFiles: [f.file] })).eventsAggregated, 1);
  assertCorrect(await fs.readFile(f.queuePath), 600);
});

test("Kimi journal replay refuses changes to uploaded bytes", async (t) => {
  const f = await fixture(t, { uploaded: true });
  const original = fs.appendFile;
  fs.appendFile = async (target, ...args) => {
    if (target === f.queuePath) throw new Error("interrupt");
    return original(target, ...args);
  };
  try { await assert.rejects(repair(f), /interrupt/); } finally { fs.appendFile = original; }
  const modified = Buffer.from(f.before); modified[0] = 32;
  await fs.writeFile(f.queuePath, modified);
  assert.equal((await repair(f)).deferred, "uploaded-prefix-changed");
  assert.deepEqual(await fs.readFile(f.queuePath), modified);
});

for (const interruptCompaction of [false, true]) test(`full sync compacts a small repaired Kimi queue${interruptCompaction ? " after a committed-cursor interruption" : ""}`, async (t) => {
  const { cmdSync } = require("../src/commands/sync");
  const { withHome } = require("./helpers/with-home");
  const f = await fixture(t);
  const session = path.join(f.dir, ".kimi-code", "sessions", "workspace", "session", "agents", "main", "wire.jsonl");
  await fs.mkdir(path.dirname(session), { recursive: true });
  await fs.rename(f.file, session);
  f.cursors.kimiCode.fileOffsets[session] = f.cursors.kimiCode.fileOffsets[f.file];
  delete f.cursors.kimiCode.fileOffsets[f.file];
  await fs.writeFile(path.join(f.dir, "cursors.json"), JSON.stringify(f.cursors));
  const keys = ["KIMI_HOME", "KIMI_CODE_HOME", "CODEX_HOME", "TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const restore = withHome(f.dir);
  try {
    process.env.KIMI_HOME = path.join(f.dir, ".kimi");
    process.env.KIMI_CODE_HOME = path.join(f.dir, ".kimi-code");
    process.env.CODEX_HOME = path.join(f.dir, ".codex");
    process.env.TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN = "";
    const context = { home: f.dir, trackerDataDir: f.dir, scanSources: ["kimi", "kimi-code"] };
    if (interruptCompaction) {
      const original = fs.rename;
      fs.rename = async (source, destination) => {
        if (destination === f.queuePath) throw new Error("interrupted compaction");
        return original(source, destination);
      };
      try { await assert.rejects(cmdSync([], context), /interrupted compaction/); } finally { fs.rename = original; }
    }
    await cmdSync([], context);
    const first = await fs.readFile(f.queuePath);
    assertCorrect(first);
    assert.equal(rows(first).filter((row) => row.model === "kimi-for-coding").length, 1);
    assert.equal(rows(first).find((row) => row.model === "kimi-for-coding").total_tokens, 0);
    await cmdSync([], context);
    assert.deepEqual(await fs.readFile(f.queuePath), first);
  } finally {
    restore();
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

test("Kimi repair defers when a source changes during reconstruction", async (t) => {
  const f = await fixture(t);
  f.parseOfficial = async (args) => {
    const result = await parseKimiCodeIncremental(args);
    await fs.appendFile(f.file, JSON.stringify(step("appended-during-rebuild")) + "\n");
    return result;
  };
  assert.equal((await repair(f)).deferred, "source-changed");
  assert.deepEqual(await fs.readFile(f.queuePath), f.before);
  assert.equal(f.cursors.migrations?.[KIMI_MODEL_REPAIR_KEY], undefined);
});
