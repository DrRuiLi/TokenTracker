"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { scanKimiSessions, discoverSessionFiles, buildSessionAnalytics, listSessionsForBrowser, summarizeSessions, sessionsToCsv, resolveSessionSidecarPath, resumeCommandFor } = require("../src/lib/session-analytics");
const { parseKimiIncremental, parseKimiCodeIncremental } = require("../src/lib/rollout");
const T0 = Date.UTC(2026, 9, 10, 23, 59);
const ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "private prompt, tool arguments and assistant body";
const USAGE = { inputOther: 100, output: 300, inputCacheRead: 40, inputCacheCreation: 10 };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-kimi-sessions-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function write(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(JSON.stringify).join("\n") + "\n");
  return file;
}
function official(home, id = `session_${ID}`, agent = "main", records = [], state = {}) {
  const directory = path.join(home, ".kimi-code", "sessions", "workspace", id);
  fs.mkdirSync(directory, { recursive: true });
  if (agent === "main") fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({ createdAt: T0, workDir: "/repo/kimi-app", title: SECRET, ...state }));
  return write(path.join(directory, "agents", agent, "wire.jsonl"), records);
}
const config = (model = "kimi-k2.6") => ({ type: "config.update", modelAlias: `kimi-code/${model}`, systemPrompt: SECRET, time: T0 });
const prompt = (id = "p1", time = T0) => ({ type: "turn.prompt", promptId: id, origin: { kind: "user" }, input: [{ type: "text", text: SECRET }], time });
const step = (id = "step1", time = T0 + 3000, usage = USAGE) => ({ type: "context.append_loop_event", event: { type: "step.end", uuid: id, usage, llmStreamDurationMs: 2000, llmFirstTokenLatencyMs: 400 }, time });
const legacyUsage = (id = "m1", time = T0) => ({ timestamp: time / 1000, message: { type: "StatusUpdate", payload: { message_id: id, token_usage: { input_other: 100, output: 300, input_cache_read: 40, input_cache_creation: 10 } } } });
function legacy(home, records, id = ID) {
  const cwd = "/repo/kimi-app";
  const workspace = crypto.createHash("md5").update(cwd).digest("hex");
  const file = write(path.join(home, ".kimi", "sessions", workspace, id, "wire.jsonl"), records);
  fs.writeFileSync(path.join(home, ".kimi", "kimi.json"), JSON.stringify({ work_dirs: [{ path: cwd }] }));
  return file;
}

function total(rows) { return rows.reduce((sum, row) => sum + row.total_tokens, 0); }

test("Kimi official wire counts each step once, includes subagents and excludes message bodies", async (t) => {
  const home = fixture(t);
  const main = official(home, undefined, "main", [config(), prompt(),
    { type: "context.append_loop_event", event: { type: "tool.call", uuid: "tool", name: "Edit", args: { content: SECRET } }, time: T0 + 1000 },
    step(), step(), { type: "usage.record", model: "kimi-k2.6", usage: USAGE, time: T0 + 3000 },
    { type: "turn.ended", time: T0 + 4000 },
  ]);
  const sub = official(home, undefined, "agent-0", [config(), prompt("child"), step("child-step", T0 + 5000)]);
  const rows = await scanKimiSessions([sub, main]);
  assert.equal(rows.length, 1);
  assert.equal(total(rows), 900);
  assert.equal(rows[0].turns, 1);
  assert.equal(rows[0].edit_turns, 1);
  assert.equal(rows[0].usage_events, 2);
  assert.equal(rows[0].performance.estimated_tokens_per_second, 150);
  assert.equal(rows[0].performance.first_response_ms, 400);
  assert.equal(rows[0].model, "kimi-k2.6");
  assert.equal(JSON.stringify(rows).includes(SECRET), false);
  const browser = listSessionsForBrowser(rows).sessions[0];
  assert.equal(browser.resume_command, `kimi --session session_${ID}`);
  const exported = JSON.stringify(summarizeSessions(rows)) + sessionsToCsv(rows);
  for (const value of [SECRET, ID, "/repo/kimi-app"]) assert.equal(exported.includes(value), false);
});

test("Kimi legacy and migrated histories form one session while retaining the official tail", async (t) => {
  const home = fixture(t);
  const old = legacy(home, [
    { timestamp: T0 / 1000, message: { type: "TurnBegin", payload: { user_input: SECRET } } },
    { timestamp: (T0 + 500) / 1000, message: { type: "ToolCall", payload: { function: { name: "StrReplaceFile", arguments: SECRET } } } },
    legacyUsage(), legacyUsage(),
  ]);
  const modern = official(home, `ses_${ID}`, "main", [config(),
    { type: "context.append_message", message: { role: "user", content: SECRET }, time: T0 },
    { type: "context.append_loop_event", event: { type: "step.end", uuid: "migrated", messageId: "m1", usage: USAGE }, time: T0 },
    prompt("new", T0 + 60000), step("tail", T0 + 63000),
  ], { custom: { imported_from_kimi_cli: true, kimi_cli_session_id: ID } });
  const rows = await scanKimiSessions([modern, old]);
  assert.equal(rows.length, 1);
  assert.equal(total(rows), 900);
  assert.equal(rows[0].turns, 2);
  assert.equal(rows[0].edit_turns, 1);
  assert.equal(rows[0].project_ref, "/repo/kimi-app");
  assert.equal(listSessionsForBrowser(rows).sessions[0].resume_command, `kimi --session ses_${ID}`);
});

test("Kimi normalized usage equals both existing sync parsers without counting usage.record", async (t) => {
  const home = fixture(t);
  const old = legacy(home, [legacyUsage()]);
  const modern = official(home, "session_new", "main", [config(), step(),
    step("anthropic", T0 + 10000, { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 300 }),
    step("openai", T0 + 20000, { input_tokens: 140, input_tokens_details: { cached_tokens: 40 }, output_tokens: 300 }),
  ]);
  const rows = await scanKimiSessions([old, modern]);
  const queuePath = path.join(home, "queue.jsonl"), cursors = {};
  await parseKimiIncremental({ wireFiles: [old], cursors, queuePath, env: { HOME: home } });
  await parseKimiCodeIncremental({ wireFiles: [modern], cursors, queuePath, env: { KIMI_CODE_HOME: path.join(home, ".kimi-code") } });
  const latest = new Map(fs.readFileSync(queuePath, "utf8").trim().split("\n").map(JSON.parse).map((row) => [`${row.model}:${row.hour_start}`, row]));
  assert.equal(total(rows), total([...latest.values()]));
  assert.equal(total(rows), 1790);
});

test("Kimi copies and forks do not recount prior step IDs, and cross-day filters keep event dates", async (t) => {
  const home = fixture(t);
  const first = official(home, "session_original", "main", [config(), prompt(), step()]);
  const fork = official(home, "session_fork", "main", [config(), prompt(), step(), prompt("tail", T0 + 120000), step("tail", T0 + 123000)], { createdAt: T0 + 120000 });
  const rows = await scanKimiSessions([fork, first, first]);
  assert.equal(total(rows), 900);
  assert.equal(rows.reduce((sum, row) => sum + row.turns, 0), 2);
  assert.equal(total(listSessionsForBrowser(rows, { from: "2026-10-11", to: "2026-10-11", timeZone: "UTC" }).sessions), 450);
});

test("Kimi inventory updates after appends, keeps partial lines pending, and refreshes metadata", async (t) => {
  const home = fixture(t);
  const file = official(home, undefined, "main", [config(), prompt(), step()]);
  const first = await buildSessionAnalytics({ home, force: true });
  const again = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
  assert.equal(total(first), 450);
  assert.equal(total(again), 450);
  const tail = JSON.stringify(step("tail", T0 + 60000));
  fs.appendFileSync(file, tail.slice(0, 20));
  assert.equal(total(await buildSessionAnalytics({ home, cacheTtlMs: 0 })), 450);
  fs.appendFileSync(file, tail.slice(20) + "\n");
  assert.equal(total(await buildSessionAnalytics({ home, cacheTtlMs: 0 })), 900);
  const stateFile = path.join(path.dirname(path.dirname(path.dirname(file))), "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ workDir: "/repo/renamed", createdAt: T0 }));
  assert.equal((await buildSessionAnalytics({ home, cacheTtlMs: 0 }))[0].project_ref, "/repo/renamed");
  assert.equal(fs.readFileSync(resolveSessionSidecarPath(home), "utf8").includes(SECRET), false);
});

test("Kimi permission failure preserves the complete sidecar and retries unchanged files", async (t) => {
  const home = fixture(t);
  const file = official(home, undefined, "main", [config(), prompt(), step()]);
  await buildSessionAnalytics({ home, force: true });
  const sidecar = resolveSessionSidecarPath(home), before = fs.readFileSync(sidecar, "utf8");
  const original = fs.createReadStream;
  fs.createReadStream = function (target, ...args) {
    if (target === file) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original.call(this, target, ...args);
  };
  try {
    const rows = await buildSessionAnalytics({ home, force: true });
    assert.equal(total(rows), 450);
    assert.equal(rows.skippedFiles, 1);
    assert.equal(fs.readFileSync(sidecar, "utf8"), before);
  } finally { fs.createReadStream = original; }
  fs.appendFileSync(file, JSON.stringify(step("tail", T0 + 5000)) + "\n");
  assert.equal(total(await buildSessionAnalytics({ home })), 900);
});

test("Kimi discovery isolates custom homes and respects explicit roots and WSL mode", async (t) => {
  const home = fixture(t), other = fixture(t);
  const local = official(home, undefined, "main", [config(), step()]);
  const remote = official(other, "session_remote", "main", [config(), step("remote")]);
  let inventory = await discoverSessionFiles(home, { KIMI_CODE_HOME: path.join(other, ".kimi-code") }, { probeWsl: false });
  assert.deepEqual(inventory.kimi, [local]);
  inventory = await discoverSessionFiles(home, { KIMI_CODE_HOME: path.join(other, ".kimi-code") }, { homedir: () => home, probeWsl: false });
  assert.deepEqual(inventory.kimi, [remote]);
  inventory = await discoverSessionFiles(home, { TOKENTRACKER_WSL_MODE: "wsl-only" }, {
    platform: "win32", homedir: () => home, probeWsl: true,
    discoverWslHome: (directory) => directory === ".kimi-code" ? path.join(other, ".kimi-code") : null,
  });
  assert.deepEqual(inventory.kimi, [remote]);
});

test("Kimi model changes preserve per-model totals and resume IDs cannot inject commands", async (t) => {
  const home = fixture(t);
  const file = official(home, undefined, "main", [config(), step(),
    { type: "profile.bind", modelAlias: "kimi-code/k3-256k", systemPrompt: SECRET, time: T0 + 5000 }, step("next", T0 + 10000),
  ]);
  const rows = await scanKimiSessions([file]);
  assert.equal(rows[0].model, "mixed");
  assert.deepEqual(rows[0].model_usage.map((row) => row.model).sort(), ["k3-256k", "kimi-k2.6"]);
  assert.equal(resumeCommandFor("kimi", "session_a; cat ~/.secrets"), null);
});
