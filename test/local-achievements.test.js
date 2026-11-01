const assert = require("node:assert/strict");
const { test } = require("node:test");

const { computeLocalAchievements, LOCAL_BADGE_THRESHOLDS } = require("../src/lib/local-api");

const TZ_SHANGHAI = { timeZone: "Asia/Shanghai", offsetMinutes: 480 };

function projectRow(projectKey, hourStart, tokens) {
  return { project_key: projectKey, source: "claude", hour_start: hourStart, total_tokens: tokens };
}

function queueRow(hourStart, tokens) {
  return { source: "claude", model: "m", hour_start: hourStart, total_tokens: tokens };
}

function byId(result, id) {
  return result.find((badge) => badge.id === id);
}

test("empty inputs yield the full locked catalog", () => {
  const result = computeLocalAchievements([], [], { timeZoneContext: TZ_SHANGHAI });
  assert.equal(result.length, 3);
  for (const badge of result) {
    assert.equal(badge.tier, 0);
    assert.equal(badge.metric_value, 0);
    assert.equal(badge.next_threshold, badge.thresholds[0]);
    assert.deepEqual(Object.values(badge.achieved), [null, null, null, null]);
  }
});

test("project_hopper tiers on distinct projects with boundary exactness", () => {
  const [bronze] = [LOCAL_BADGE_THRESHOLDS.project_hopper[0]];
  const below = Array.from({ length: bronze - 1 }, (_, i) =>
    projectRow(`p${i}`, `2026-07-0${i + 1}T10:00:00Z`, 100),
  );
  const under = byId(
    computeLocalAchievements([], below, { timeZoneContext: TZ_SHANGHAI }),
    "project_hopper",
  );
  assert.equal(under.tier, 0);

  const exact = [...below, projectRow(`p${bronze}`, "2026-07-09T10:00:00Z", 100)];
  const at = byId(
    computeLocalAchievements([], exact, { timeZoneContext: TZ_SHANGHAI }),
    "project_hopper",
  );
  assert.equal(at.tier, 1);
  // achieved timestamp = hour the crossing row landed
  assert.equal(at.achieved.bronze, "2026-07-09T10:00:00Z");
  assert.equal(at.metric_value, bronze);
});

test("project_devotion tracks the max single-project running total", () => {
  const rows = [
    projectRow("small", "2026-07-01T01:00:00Z", 400_000),
    projectRow("big", "2026-07-02T01:00:00Z", 600_000),
    projectRow("big", "2026-07-03T01:00:00Z", 500_000), // big crosses 1M here
  ];
  const badge = byId(
    computeLocalAchievements([], rows, { timeZoneContext: TZ_SHANGHAI }),
    "project_devotion",
  );
  assert.equal(badge.tier, 1);
  assert.equal(badge.metric_value, 1_100_000);
  assert.equal(badge.achieved.bronze, "2026-07-03T01:00:00Z");
  assert.equal(badge.meta.project_key, "big");
});

test("night_owl buckets hours in the caller's timezone, not UTC", () => {
  // 18:00–22:00 UTC = 02:00–06:00 Asia/Shanghai (only <06:00 counts → 4 rows).
  const night = [
    queueRow("2026-07-01T18:00:00Z", 10), // 02:00 local
    queueRow("2026-07-01T19:00:00Z", 10), // 03:00
    queueRow("2026-07-01T20:00:00Z", 10), // 04:00
    queueRow("2026-07-01T21:00:00Z", 10), // 05:00
    queueRow("2026-07-01T22:00:00Z", 10), // 06:00 — NOT night
    queueRow("2026-07-01T10:00:00Z", 10), // 18:00 — NOT night
  ];
  const badge = byId(
    computeLocalAchievements(night, [], { timeZoneContext: TZ_SHANGHAI }),
    "night_owl",
  );
  assert.equal(badge.metric_value, 4);
  assert.equal(badge.tier, 0); // bronze needs 5

  // One more genuine night hour crosses bronze.
  const crossed = byId(
    computeLocalAchievements(
      [...night, queueRow("2026-07-02T17:00:00Z", 10)], // 01:00 local next day
      [],
      { timeZoneContext: TZ_SHANGHAI },
    ),
    "night_owl",
  );
  assert.equal(crossed.tier, 1);
  assert.equal(crossed.metric_value, 5);
});

test("zero-token rows never count anywhere", () => {
  const result = computeLocalAchievements(
    [queueRow("2026-07-01T18:00:00Z", 0)],
    [projectRow("p1", "2026-07-01T10:00:00Z", 0)],
    { timeZoneContext: TZ_SHANGHAI },
  );
  for (const badge of result) {
    assert.equal(badge.tier, 0);
    assert.equal(badge.metric_value, 0);
  }
});

test("tier timestamps replay in hour order even when rows arrive shuffled", () => {
  const thresholds = LOCAL_BADGE_THRESHOLDS.project_hopper;
  const rows = [];
  for (let i = 0; i < thresholds[1]; i += 1) {
    rows.push(projectRow(`p${i}`, `2026-06-${String(i + 1).padStart(2, "0")}T08:00:00Z`, 50));
  }
  const shuffled = [rows[4], rows[0], rows[3], rows[1], rows[2]];
  const badge = byId(
    computeLocalAchievements([], shuffled, { timeZoneContext: TZ_SHANGHAI }),
    "project_hopper",
  );
  assert.equal(badge.tier, 2);
  // bronze crossed on the 3rd distinct project chronologically, silver on the 5th.
  assert.equal(badge.achieved.bronze, "2026-06-03T08:00:00Z");
  assert.equal(badge.achieved.silver, "2026-06-05T08:00:00Z");
});
