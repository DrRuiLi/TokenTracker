/**
 * Claude session files must be deduped ACROSS discovery roots.
 *
 * Multi-root discovery (#380) scans a native and a WSL Claude home. Codex
 * already collapses the same session found in both roots via its session-id
 * pass, but Claude only ever had per-file message dedup
 * (`claudeMessageDedupKey` inside `scanClaudeSession`), which cannot see a
 * second copy of the same file under a different path spelling. Every
 * discovered path becomes its own session row keyed by
 * `sessionFileCacheKey(source, path.resolve(filePath))`, so a WSL `$HOME` that
 * points at the Windows profile — the same files reachable as both
 * `C:\Users\dev\.claude\...` and `\\wsl$\Ubuntu\home\dev\.claude\...` —
 * produced duplicate rows in the session browser, its project list and the
 * CSV export.
 *
 * Dedup is deliberately CROSS-root only: two files inside one root are never
 * treated as copies of each other, so single-root installs (macOS, Linux,
 * native-only Windows) are bit-for-bit unaffected.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const {
  analyticsEntryStatKey,
  dedupeClaudeFilesAcrossRoots,
  scanClaudeSession,
  scanCodexSession,
} = require("../src/lib/session-analytics");

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-claude-roots-"));
  try {
    const result = fn(dir);
    if (result && typeof result.then === "function") {
      return result.finally(() => fs.rmSync(dir, { recursive: true, force: true }));
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// One session file per root, same basename UUID -> the same session reachable
// under two path spellings.
function seedRoot(base, name, uuid, mtimeMs, content = "{}\n") {
  const dir = path.join(base, name, "projects", "-Users-dev-app");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(filePath, content);
  if (mtimeMs) fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("the same session found in two roots collapses to one file", () => {
  withTmp((tmp) => {
    const native = seedRoot(tmp, "native", UUID_A, 1_000_000);
    const wsl = seedRoot(tmp, "wsl", UUID_A, 2_000_000);

    const deduped = dedupeClaudeFilesAcrossRoots([[native], [wsl]]);
    assert.equal(deduped.length, 1, "one session must not yield two rows");
    // Newest wins, matching the Codex session-id pass.
    assert.equal(deduped[0], wsl);
  });
});

test("the older copy wins when it is the newer file in the other root", () => {
  withTmp((tmp) => {
    const native = seedRoot(tmp, "native", UUID_A, 5_000_000);
    const wsl = seedRoot(tmp, "wsl", UUID_A, 1_000_000);

    const deduped = dedupeClaudeFilesAcrossRoots([[native], [wsl]]);
    assert.deepEqual(deduped, [native]);
  });
});

test("distinct sessions in different roots are both kept", () => {
  withTmp((tmp) => {
    const native = seedRoot(tmp, "native", UUID_A, 1_000_000);
    const wsl = seedRoot(tmp, "wsl", UUID_B, 1_000_000);

    const deduped = dedupeClaudeFilesAcrossRoots([[native], [wsl]]);
    assert.equal(deduped.length, 2);
    assert.ok(deduped.includes(native) && deduped.includes(wsl));
  });
});

test("a single root is returned untouched, including same-UUID siblings", () => {
  withTmp((tmp) => {
    // Two projects can legitimately hold files with the same basename in one
    // tree (a copied transcript, a restored backup). Within one root nothing is
    // dropped -- only cross-root duplicates are copies by construction.
    const dir = path.join(tmp, "native", "projects");
    const first = path.join(dir, "-Users-dev-a", `${UUID_A}.jsonl`);
    const second = path.join(dir, "-Users-dev-b", `${UUID_A}.jsonl`);
    for (const p of [first, second]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "{}\n");
    }

    const deduped = dedupeClaudeFilesAcrossRoots([[first, second]]);
    assert.deepEqual(deduped, [first, second]);
  });
});

// The single-root sibling case above returns early, so it never reaches the
// cross-root matching loop. With a second root present, an ambiguous UUID must
// disable dedup for that UUID entirely rather than let one root's file evict a
// sibling it may have nothing to do with.
test("same-UUID siblings in one root disable dedup instead of losing a session", () => {
  withTmp((tmp) => {
    const first = seedRoot(tmp, "native", UUID_A, 1_000_000);
    const sibling = seedRoot(tmp, "native-copy", UUID_A, 2_000_000);
    const other = seedRoot(tmp, "wsl", UUID_A, 1_500_000);

    const deduped = dedupeClaudeFilesAcrossRoots([[first, sibling], [other]]);

    // Which sibling `other` mirrors is unknowable from the path, so collapsing
    // by mtime would drop a genuinely distinct transcript — and, when `other`
    // mirrors the sibling rather than the first file, keep that content twice.
    assert.ok(
      deduped.includes(first),
      "the first sibling must not be evicted by a file from another root",
    );
    assert.equal(deduped.length, 3, "an ambiguous UUID must not be deduped at all");
  });
});

test("files without a UUID basename are never deduped", () => {
  withTmp((tmp) => {
    const dirA = path.join(tmp, "native", "projects", "-Users-dev-a");
    const dirB = path.join(tmp, "wsl", "projects", "-Users-dev-a");
    const a = path.join(dirA, "notes.jsonl");
    const b = path.join(dirB, "notes.jsonl");
    for (const p of [a, b]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "{}\n");
    }

    // Unproven identity must not delete a session.
    const deduped = dedupeClaudeFilesAcrossRoots([[a], [b]]);
    assert.equal(deduped.length, 2);
  });
});

test("ordering follows the root order so native precedence is stable", () => {
  withTmp((tmp) => {
    const nativeA = seedRoot(tmp, "native", UUID_A, 1_000_000);
    const wslB = seedRoot(tmp, "wsl", UUID_B, 1_000_000);

    assert.deepEqual(dedupeClaudeFilesAcrossRoots([[nativeA], [wslB]]), [nativeA, wslB]);
  });
});

test("divergent same-UUID Claude copies are retained instead of choosing by mtime", () => {
  withTmp((tmp) => {
    const native = seedRoot(tmp, "native", UUID_A, 1_000_000, "{\"native\":true}\n");
    const wsl = seedRoot(tmp, "wsl", UUID_A, 2_000_000, "{\"wsl\":true}\n");

    assert.deepEqual(dedupeClaudeFilesAcrossRoots([[native], [wsl]]), [native, wsl]);
  });
});

test("Claude cross-root union counts a shared prefix once and both divergent tails", async () => {
  await withTmp(async (tmp) => {
    const row = (id, input, output, timestamp) => ({
      type: "assistant",
      sessionId: UUID_A,
      cwd: "/repo",
      timestamp,
      message: {
        id,
        model: "claude-test",
        usage: { input_tokens: input, output_tokens: output },
        content: [],
      },
    });
    const common = [
      { type: "user", sessionId: UUID_A, cwd: "/repo", timestamp: "2026-08-08T01:00:00Z", message: { content: "go" } },
      row("m-common", 10, 1, "2026-08-08T01:00:01Z"),
    ];
    const nativeRows = [...common, row("m-native", 20, 2, "2026-08-08T01:00:02Z")];
    const wslRows = [...common, row("m-wsl", 30, 3, "2026-08-08T01:00:03Z")];
    const native = seedRoot(tmp, "native", UUID_A, 1_000_000, `${nativeRows.map(JSON.stringify).join("\n")}\n`);
    const wsl = seedRoot(tmp, "wsl", UUID_A, 2_000_000, `${wslRows.map(JSON.stringify).join("\n")}\n`);

    const session = await scanClaudeSession([native, wsl]);
    assert.equal(session.turns, 1);
    assert.equal(session.retry_turns, 0, "the shared prompt must be hash-deduped");
    assert.equal(session.tokens.input_tokens, 60);
    assert.equal(session.tokens.output_tokens, 6);
    assert.equal(session.total_tokens, 66);
  });
});

test("Claude and Codex keep a surviving mirror when another grouped path vanishes", async () => {
  await withTmp(async (tmp) => {
    const missing = path.join(tmp, "unmounted", `${UUID_A}.jsonl`);
    const readFailure = path.join(tmp, "read-failure");
    fs.mkdirSync(readFailure);
    const claudeRow = {
      type: "assistant",
      sessionId: UUID_A,
      cwd: "/repo",
      timestamp: "2026-08-08T03:00:00Z",
      message: {
        id: "m-survivor",
        model: "claude-test",
        usage: { input_tokens: 7, output_tokens: 2 },
        content: [],
      },
    };
    const claude = seedRoot(tmp, "claude-native", UUID_A, 1_000_000, `${JSON.stringify(claudeRow)}\n`);
    assert.match(
      analyticsEntryStatKey("claude", [missing, claude]),
      /^missing\|/,
      "one missing mirror must invalidate the cache without dropping the surviving group",
    );
    const claudeSession = await scanClaudeSession([missing, claude]);
    assert.equal(claudeSession.total_tokens, 9);
    const claudeAfterOpenFailure = await scanClaudeSession([readFailure, claude]);
    assert.equal(claudeAfterOpenFailure.total_tokens, 9);

    const codexRows = [
      { timestamp: "2026-08-08T03:01:00Z", type: "session_meta", payload: { id: UUID_A, cwd: "/repo", model_provider: "openai" } },
      { timestamp: "2026-08-08T03:01:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: "/repo", model: "gpt-test" } },
      { timestamp: "2026-08-08T03:01:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } } } },
    ];
    const codex = seedRoot(tmp, "codex-native", UUID_A, 1_000_000, `${codexRows.map(JSON.stringify).join("\n")}\n`);
    const codexSession = await scanCodexSession([missing, codex]);
    assert.equal(codexSession.total_tokens, 11);
    const codexAfterOpenFailure = await scanCodexSession([readFailure, codex]);
    assert.equal(codexAfterOpenFailure.total_tokens, 11);
  });
});

test("Codex discards records staged before a grouped mirror fails mid-read", async () => {
  await withTmp(async (tmp) => {
    const usage = (input, output) => ({
      input_tokens: input,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: input + output,
    });
    const rows = (input, output, suffix) => [
      { timestamp: `2026-08-08T04:00:0${suffix}Z`, type: "session_meta", payload: { id: UUID_A, cwd: "/repo", model_provider: "openai" } },
      { timestamp: `2026-08-08T04:00:1${suffix}Z`, type: "turn_context", payload: { turn_id: `turn-${suffix}`, cwd: "/repo", model: "gpt-test" } },
      { timestamp: `2026-08-08T04:00:2${suffix}Z`, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(input, output), total_token_usage: usage(input, output) } } },
    ];
    const poisonedRows = rows(900, 99, "0");
    const survivingRows = rows(8, 3, "1");
    const broken = seedRoot(tmp, "codex-broken", UUID_A, 1_000_000, `${poisonedRows.map(JSON.stringify).join("\n")}\n`);
    const survivor = seedRoot(tmp, "codex-survivor", UUID_A, 2_000_000, `${survivingRows.map(JSON.stringify).join("\n")}\n`);
    const originalCreateReadStream = fs.createReadStream;
    fs.createReadStream = function createFailingReadStream(filePath, options) {
      if (filePath !== broken) return originalCreateReadStream.call(this, filePath, options);
      return Readable.from((async function* failAfterCompleteRows() {
        yield Buffer.from(`${poisonedRows.map(JSON.stringify).join("\n")}\n`);
        const error = new Error("simulated stale mount after a partial read");
        error.code = "ESTALE";
        throw error;
      })());
    };

    try {
      const session = await scanCodexSession([broken, survivor]);
      assert.equal(session.total_tokens, 11, "the failed mirror's staged usage must not leak into the union");
      assert.equal(session.tokens.input_tokens, 8);
      assert.equal(session.tokens.output_tokens, 3);
    } finally {
      fs.createReadStream = originalCreateReadStream;
    }
  });
});

test("Codex cross-root union counts duplicate token events once and divergent tails", async () => {
  await withTmp(async (tmp) => {
    const usage = (input, output) => ({
      input_tokens: input,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: input + output,
    });
    const common = [
      { timestamp: "2026-08-08T02:00:00Z", type: "session_meta", payload: { id: UUID_A, cwd: "/repo", model_provider: "openai" } },
      { timestamp: "2026-08-08T02:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: "/repo", model: "gpt-test" } },
      { timestamp: "2026-08-08T02:00:02Z", type: "event_msg", payload: { type: "user_message", message: "go" } },
      { timestamp: "2026-08-08T02:00:03Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(100, 10), total_token_usage: usage(100, 10) } } },
    ];
    const nativeRows = [
      ...common,
      { timestamp: "2026-08-08T02:00:04Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(20, 2), total_token_usage: usage(120, 12) } } },
    ];
    const wslRows = [
      ...common,
      { timestamp: "2026-08-08T02:00:05Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(30, 3), total_token_usage: usage(130, 13) } } },
    ];
    const native = seedRoot(tmp, "native", UUID_A, 1_000_000, `${nativeRows.map(JSON.stringify).join("\n")}\n`);
    const wsl = seedRoot(tmp, "wsl", UUID_A, 2_000_000, `${wslRows.map(JSON.stringify).join("\n")}\n`);

    const session = await scanCodexSession([native, wsl]);
    assert.equal(session.tokens.input_tokens, 150);
    assert.equal(session.tokens.output_tokens, 15);
    assert.equal(session.total_tokens, 165);
    assert.equal(session.turns, 1);
  });
});
