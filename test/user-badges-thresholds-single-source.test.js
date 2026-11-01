// Inverse-parity guardrail: cloud badge thresholds live ONLY in
// scripts/ops/user-badges.sql (the catalog table seed). The edges and the
// dashboard receive thresholds/next_threshold in payloads and must not embed
// their own copies — a second copy WILL drift.
//
// Exemptions: dashboard/src/lib/mock-data.ts fakes realistic payloads for
// dashboard:dev (display-only, never used for real evaluation), and
// src/lib/local-api.js owns the LOCAL badge thresholds (it is the local
// "server", the same role the SQL catalog plays for cloud).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Signature literals that identify a cloud threshold table copy. Chosen to be
// specific enough not to collide with unrelated numbers.
const CLOUD_THRESHOLD_SIGNATURES = [
  "100000000000", // token_titan diamond
  "10000000000", // token_titan gold
  "100_000_000_000",
  "10_000_000_000",
];

test("edge functions carry no badge threshold literals", () => {
  for (const rel of [
    "dashboard/edge-patches/tokentracker-leaderboard.ts",
    "dashboard/edge-patches/tokentracker-leaderboard-profile.ts",
  ]) {
    const content = read(rel);
    for (const sig of CLOUD_THRESHOLD_SIGNATURES) {
      assert.ok(!content.includes(sig), `${rel} embeds badge threshold ${sig}`);
    }
  }
});

test("dashboard source carries no cloud badge threshold literals (mock exempt)", () => {
  const files = walk(path.join(ROOT, "dashboard", "src")).filter(
    (f) =>
      /\.(jsx?|tsx?)$/.test(f) &&
      !/\.test\.[jt]sx?$/.test(f) && // test fixtures aren't display code
      !f.endsWith(`lib${path.sep}mock-data.ts`),
  );
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const sig of CLOUD_THRESHOLD_SIGNATURES) {
      assert.ok(
        !content.includes(sig),
        `${path.relative(ROOT, file)} embeds badge threshold ${sig}`,
      );
    }
  }
});

test("badge id sets agree across SQL, frontend catalog, and copy.csv", () => {
  const sql = read("scripts/ops/user-badges.sql");
  const catalog = read("dashboard/src/ui/achievements/badge-catalog.js");
  const copyCsv = read("dashboard/src/content/copy.csv");
  const localApi = read("src/lib/local-api.js");

  const CLOUD_IDS = [
    "token_titan",
    "big_day",
    "wordsmith",
    "marathoner",
    "streak",
    "weekend_warrior",
    "momentum",
    "polyglot",
    "trendsetter",
    "multitool",
    "podium",
    "veteran",
  ];
  const LOCAL_IDS = ["project_hopper", "project_devotion", "night_owl"];

  for (const id of CLOUD_IDS) {
    assert.ok(sql.includes(`'${id}'`), `SQL catalog missing ${id}`);
  }
  for (const id of LOCAL_IDS) {
    assert.ok(localApi.includes(id), `local-api missing local badge ${id}`);
  }
  for (const id of [...CLOUD_IDS, ...LOCAL_IDS]) {
    assert.ok(catalog.includes(`"${id}"`), `frontend catalog missing ${id}`);
    assert.ok(
      copyCsv.includes(`achievements.badge.${id}.name`),
      `copy.csv missing name key for ${id}`,
    );
    assert.ok(
      copyCsv.includes(`achievements.badge.${id}.desc`),
      `copy.csv missing desc key for ${id}`,
    );
  }
});
