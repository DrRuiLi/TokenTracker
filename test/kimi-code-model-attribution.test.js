"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { parseKimiCodeIncremental } = require("../src/lib/rollout");
const T0 = Date.UTC(2026, 9, 15, 0);
const usage = { inputOther: 100, output: 20, inputCacheRead: 80, inputCacheCreation: 0 };
const step = (id, time = T0 + 1000) => ({ type: "context.append_loop_event", event: { type: "step.end", uuid: id, usage }, time });
function fixture(t, records) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-kimi-model-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "wire.jsonl"), queuePath = path.join(home, "queue.jsonl");
  fs.writeFileSync(file, records.map(JSON.stringify).join("\n") + "\n");
  return { file, queuePath, cursors: {}, env: { KIMI_CODE_HOME: home } };
}
function latest(queuePath) {
  return [...new Map(fs.readFileSync(queuePath, "utf8").trim().split("\n").map(JSON.parse).map((row) => [`${row.model}:${row.hour_start}`, row])).values()];
}
const parse = (f) => parseKimiCodeIncremental({ wireFiles: [f.file], ...f });

test("Kimi profile.bind selects k3-256k when config.update contains no model", async (t) => {
  const f = fixture(t, [
    { type: "config.update", systemPrompt: "private", time: T0 },
    { type: "profile.bind", modelAlias: "kimi-code/k3-256k", time: T0 },
    step("u1"), { type: "usage.record", model: "k3-256k", usage, time: T0 + 1000 },
  ]);
  assert.equal((await parse(f)).eventsAggregated, 1);
  assert.deepEqual(latest(f.queuePath).map((r) => [r.model, r.total_tokens]), [["k3-256k", 200]]);
  assert.equal((await parse(f)).eventsAggregated, 0);
  assert.equal(f.cursors.kimiCode.fileOffsets[f.file].model, "k3-256k");
});

test("Kimi llm.request overrides a stale profile and survives later incremental reads", async (t) => {
  const f = fixture(t, [
    { type: "config.update", modelAlias: "kimi-code/kimi-for-coding", time: T0 },
    { type: "profile.bind", modelAlias: "kimi-code/k3", time: T0 },
    { type: "llm.request", modelAlias: "kimi-code/k3-256k", model: "k3-256k", time: T0 },
    step("u1"),
  ]);
  await parse(f);
  fs.appendFileSync(f.file, JSON.stringify(step("u2", T0 + 3000)) + "\n");
  await parse(f);
  assert.deepEqual(latest(f.queuePath).map((r) => [r.model, r.total_tokens]), [["k3-256k", 400]]);
  fs.appendFileSync(f.file, [
    { type: "llm.request", model: "kimicoding/k2.8", time: T0 + 4000 },
    step("u3", T0 + 5000),
  ].map(JSON.stringify).join("\n") + "\n");
  await parse(f);
  assert.deepEqual(latest(f.queuePath).map((r) => [r.model, r.total_tokens]).sort(), [["k2.8", 200], ["k3-256k", 400]]);
  assert.equal((await parse(f)).eventsAggregated, 0);
});

test("model-less Kimi updates do not erase the known request model", async (t) => {
  const f = fixture(t, [
    { type: "llm.request", model: "k3-256k", time: T0 },
    { type: "config.update", thinkingEffort: "high", time: T0 },
    { type: "profile.bind", modelAlias: "", time: T0 },
    step("u1"),
  ]);
  await parse(f);
  assert.equal(latest(f.queuePath)[0].model, "k3-256k");
});
