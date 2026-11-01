const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createAsyncQueueReader } = require("../src/lib/async-queue-reader");

async function fixture(t, parseRow = (row) => ({ key: row.key, row })) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-async-queue-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, "queue.jsonl"), read: createAsyncQueueReader({ parseRow, label: "testQueue" }) };
}

const line = (key, value) => JSON.stringify({ key, value }) + "\n";

test("cold concurrent queue readers share parsing and let unrelated HTTP requests run", async (t) => {
  let parses = 0;
  const x = await fixture(t, (row) => { parses++; return { key: row.key, row }; });
  await fs.writeFile(x.file, line("same", 10).repeat(100_000));
  const http = require("node:http");
  const server = http.createServer(async (req, res) => {
    if (req.url === "/usage") res.end(JSON.stringify(await x.read(x.file)));
    else res.end("healthy");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let usageCompleted = false;
  const usage = fetch(`${base}/usage`).then((res) => res.json()).then((rows) => { usageCompleted = true; return rows; });
  // Wait until parsing has actually started, then request an unrelated endpoint.
  while (parses === 0) await new Promise((resolve) => setImmediate(resolve));
  const shared = x.read(x.file);
  const health = await fetch(`${base}/health`).then((res) => res.text());
  assert.equal(health, "healthy");
  assert.equal(usageCompleted, false, "health is served before the large scan completes");
  const [rows, sameRows] = await Promise.all([usage, shared]);
  assert.deepEqual(rows, sameRows);
  assert.equal(parses, 100_000);
  assert.equal(rows[0].value, 10);
  await x.read(x.file);
  assert.equal(parses, 100_000, "unchanged reads reuse parsed rows");
  await fs.appendFile(x.file, line("same", 20));
  assert.equal((await x.read(x.file))[0].value, 20);
  assert.equal(parses, 100_001, "only the appended row is parsed");
  assert.equal(sameRows[0].value, 10, "published arrays remain immutable");
});

test("replacement, truncation, same-size rewrites and deletion discard stale buckets", async (t) => {
  const x = await fixture(t);
  await fs.writeFile(x.file, line("old", 10));
  await x.read(x.file);
  const replacement = path.join(x.dir, "replacement");
  await fs.writeFile(replacement, line("new", 20));
  await fs.rename(replacement, x.file);
  assert.deepEqual(await x.read(x.file), [{ key: "new", value: 20 }]);
  await fs.writeFile(x.file, line("alt", 30));
  assert.deepEqual(await x.read(x.file), [{ key: "alt", value: 30 }]);
  await fs.writeFile(x.file, "");
  assert.deepEqual(await x.read(x.file), []);
  await fs.unlink(x.file);
  assert.deepEqual(await x.read(x.file), []);
  await fs.writeFile(x.file, line("fresh", 40));
  assert.deepEqual(await x.read(x.file), [{ key: "fresh", value: 40 }]);
});

test("same-size rewrites invalidate snapshots even when file timestamps collide", async (t) => {
  const padding = line("padding", 0).repeat(40);
  for (const [name, before, after] of [
    ["head", line("old", 10) + padding, line("new", 20) + padding],
    ["middle", padding + line("old", 10) + padding, padding + line("new", 20) + padding],
    ["tail", padding + line("old", 10), padding + line("new", 20)],
    ["unterminated tail", padding + line("old", 10).trimEnd(), padding + line("new", 20).trimEnd()],
  ]) {
    await t.test(name, async (t) => {
      let parses = 0;
      const x = await fixture(t, (row) => { parses++; return { key: row.key, row }; });
      assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
      await fs.writeFile(x.file, before);
      let frozenTimestamps;
      const open = fs.open;
      // Preserve real file reads, but deterministically reproduce coarse Windows
      // timestamps instead of relying on two writes landing in the same clock tick.
      t.mock.method(fs, "open", async (...args) => {
        const file = await open(...args);
        if (args[0] === x.file) {
          const stat = file.stat.bind(file);
          file.stat = async (...options) => {
            const currentStat = await stat(...options);
            frozenTimestamps ??= {
              mtimeNs: currentStat.mtimeNs,
              ctimeNs: currentStat.ctimeNs,
            };
            return { ...currentStat, ...frozenTimestamps };
          };
        }
        return file;
      });

      const snapshot = await x.read(x.file);
      const coldParses = parses;
      assert.equal(await x.read(x.file), snapshot, "unchanged reads reuse the snapshot");
      assert.equal(parses, coldParses, "unchanged reads must not parse rows again");
      await fs.writeFile(x.file, after);
      const refreshed = await x.read(x.file);
      assert.ok(refreshed.some(row => row.key === "new" && row.value === 20));
      assert.ok(!refreshed.some(row => row.key === "old"), "rewrites discard stale keys");
      assert.ok(snapshot.some(row => row.key === "old"), "published snapshots stay immutable");
    });
  }
});

test("growth with rewritten interior rows discards stale cached buckets", async (t) => {
  const x = await fixture(t);
  const padding = line("padding", 0).repeat(40);
  await fs.writeFile(x.file, padding + line("old", 10) + padding);
  const snapshot = await x.read(x.file);
  await fs.writeFile(x.file, padding + line("new", 20) + padding + line("appended", 30));
  const refreshed = await x.read(x.file);
  assert.ok(refreshed.some(row => row.key === "new" && row.value === 20));
  assert.ok(refreshed.some(row => row.key === "appended" && row.value === 30));
  assert.ok(!refreshed.some(row => row.key === "old"));
  assert.ok(snapshot.some(row => row.key === "old"));
});

test("partial tails, UTF-8 chunk boundaries and malformed lines preserve completed rows", async (t) => {
  const x = await fixture(t);
  const unicode = "中🙂".repeat(20_000);
  await fs.writeFile(x.file, line("unicode", unicode) + "bad json\n" + '{"key":"partial","value":');
  assert.deepEqual(await x.read(x.file), [{ key: "unicode", value: unicode }]);
  await fs.appendFile(x.file, "42}\n");
  assert.deepEqual(await x.read(x.file), [{ key: "unicode", value: unicode }, { key: "partial", value: 42 }]);
  await fs.appendFile(x.file, '{"key":"temporary","value":10}');
  assert.equal((await x.read(x.file)).at(-1).key, "temporary");
  // Completing a valid unterminated JSON object can even change its key.
  await fs.appendFile(x.file, '\r\n');
  assert.equal((await x.read(x.file)).at(-1).value, 10);
});
