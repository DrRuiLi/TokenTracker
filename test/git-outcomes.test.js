"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { buildGitOutcomes } = require("../src/lib/git-outcomes");

test("Git outcomes attributes only the single overlapping metadata-only session", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-git-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tt-git-repo-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-18T01:30:00Z", GIT_COMMITTER_DATE: "2026-07-18T01:30:00Z" } });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "TokenTracker Test");
  fs.writeFileSync(path.join(repo, "file.txt"), "safe");
  git("add", "file.txt");
  git("commit", "-m", "implement metadata feature");
  const sessions = [{
    session_hash: "session-hash",
    project_ref: repo,
    started_at: "2026-07-18T01:00:00Z",
    ended_at: "2026-07-18T01:20:00Z",
    source: "codex",
    model: "gpt-test",
  }];
  const outcomes = await buildGitOutcomes(sessions, { home, force: true, maxAgeDays: 100_000 });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].session_hash, "session-hash");
  assert.equal(outcomes[0].accepted, true);
  assert.equal(Object.hasOwn(outcomes[0], "subject"), false);
  assert.equal(Object.hasOwn(outcomes[0], "diff"), false);
  const cached = await buildGitOutcomes(sessions, { home, maxAgeDays: 100_000 });
  assert.deepEqual(cached, outcomes);
});

// Attribution runs git inside every recent session's working directory. On
// macOS each protected location it touches (~/Documents, ~/Downloads, another
// app's container) raises its own TCC consent prompt, so a cached run must not
// enter those directories at all — the dashboard polls this endpoint often.
test("a cached attribution run never touches the project directory", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-git-quiet-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tt-git-quiet-repo-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-18T01:30:00Z", GIT_COMMITTER_DATE: "2026-07-18T01:30:00Z" } });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "TokenTracker Test");
  fs.writeFileSync(path.join(repo, "file.txt"), "safe");
  git("add", "file.txt");
  git("commit", "-m", "work");
  const sessions = [{
    session_hash: "quiet-hash",
    project_ref: repo,
    started_at: "2026-07-18T01:00:00Z",
    ended_at: "2026-07-18T01:20:00Z",
    source: "codex",
    model: "gpt-test",
  }];

  const first = await buildGitOutcomes(sessions, { home, force: true, maxAgeDays: 100_000 });
  assert.equal(first.length, 1);

  // Renaming the directory away makes any probe observable: the old code called
  // fs.existsSync(project_ref) and spawned git there before consulting the
  // cache, so it would have lost the attribution. A quiet run keeps it.
  const moved = `${repo}-moved`;
  fs.renameSync(repo, moved);
  try {
    const cached = await buildGitOutcomes(sessions, { home, maxAgeDays: 100_000 });
    assert.deepEqual(cached, first, "cached run must serve the sidecar without probing project_ref");
  } finally {
    fs.renameSync(moved, repo);
  }
});

// macOS raises a separate TCC consent dialog per protected location, and ad-hoc
// signing resets that consent on every update, so an opt-in beta must not walk
// into ~/Documents or ~/Downloads on its own.
test("attribution never enters a TCC-protected location", { skip: process.platform !== "darwin" ? "macOS-only guard" : false }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-git-tcc-home-"));
  const repo = path.join(home, "Documents", "project");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-18T01:30:00Z", GIT_COMMITTER_DATE: "2026-07-18T01:30:00Z" } });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "TokenTracker Test");
  fs.writeFileSync(path.join(repo, "file.txt"), "safe");
  git("add", "file.txt");
  git("commit", "-m", "work in a protected folder");
  const sessions = [{
    session_hash: "tcc-hash",
    project_ref: repo,
    started_at: "2026-07-18T01:00:00Z",
    ended_at: "2026-07-18T01:20:00Z",
    source: "codex",
    model: "gpt-test",
  }];

  const probed = [];
  const realExistsSync = fs.existsSync;
  fs.existsSync = (target) => {
    if (typeof target === "string" && target.startsWith(path.join(home, "Documents"))) probed.push(target);
    return realExistsSync(target);
  };
  try {
    assert.deepEqual(await buildGitOutcomes(sessions, { home, force: true, maxAgeDays: 100_000 }), []);
    assert.deepEqual(probed, [], "a protected directory must not be probed at all");

    // Opting in restores attribution for anyone who keeps repos there.
    process.env.TOKENTRACKER_GIT_ATTRIBUTION_PROTECTED_DIRS = "1";
    const optedIn = await buildGitOutcomes(sessions, { home, force: true, maxAgeDays: 100_000 });
    assert.equal(optedIn.length, 1);
    assert.equal(optedIn[0].session_hash, "tcc-hash");
  } finally {
    delete process.env.TOKENTRACKER_GIT_ATTRIBUTION_PROTECTED_DIRS;
    fs.existsSync = realExistsSync;
  }
});

test("TOKENTRACKER_DISABLE_GIT_ATTRIBUTION keeps attribution out of project directories", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-git-off-home-"));
  const missing = path.join(os.tmpdir(), "tt-git-off-nonexistent");
  const sessions = [{
    session_hash: "off-hash",
    project_ref: missing,
    started_at: "2026-07-18T01:00:00Z",
    ended_at: "2026-07-18T01:20:00Z",
    source: "codex",
    model: "gpt-test",
  }];
  const previous = process.env.TOKENTRACKER_DISABLE_GIT_ATTRIBUTION;
  process.env.TOKENTRACKER_DISABLE_GIT_ATTRIBUTION = "1";
  try {
    assert.deepEqual(await buildGitOutcomes(sessions, { home, force: true, maxAgeDays: 100_000 }), []);
    // Nothing was written, so nothing was probed.
    assert.equal(fs.existsSync(`${path.join(home, ".tokentracker", "tracker", "auto-outcomes.jsonl")}.meta.json`), false);
  } finally {
    if (previous === undefined) delete process.env.TOKENTRACKER_DISABLE_GIT_ATTRIBUTION;
    else process.env.TOKENTRACKER_DISABLE_GIT_ATTRIBUTION = previous;
  }
});
