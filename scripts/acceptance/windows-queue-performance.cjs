// Synthetic numeric usage only. No installed provider logs or credentials.
// --baseline=<git-ref> compares the old local API in the current dependency tree.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

async function main() {
  const baselineArg = process.argv.find((arg) => arg.startsWith("--baseline="));
  let api;
  if (baselineArg) {
    const Module = require("node:module");
    const filename = path.resolve(__dirname, "../../src/lib/local-api.js");
    const baseline = new Module(filename);
    baseline.filename = filename;
    baseline.paths = Module._nodeModulePaths(path.dirname(filename));
    baseline._compile(require("node:child_process").execFileSync("git", [
      "show", `${baselineArg.slice("--baseline=".length)}:src/lib/local-api.js`,
    ], { cwd: path.resolve(__dirname, "../.."), encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true }), filename);
    api = baseline.exports;
  } else {
    api = require("../../src/lib/local-api");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tt-queue-performance-"));
  const queuePath = path.join(directory, "queue.jsonl");
  const manyBuckets = process.argv.includes("--many-buckets");
  let timer;
  try {
    const row = { source: "claude", model: "claude-sonnet-4-6", hour_start: "2026-10-12T00:00:00Z",
      input_tokens: 100, output_tokens: 10, total_tokens: 110, billable_total_tokens: 110 };
    const content = manyBuckets
      ? (Array.from({ length: 24_000 }, (_, i) => JSON.stringify({ ...row,
          hour_start: new Date(Date.parse(row.hour_start) - i * 1_800_000).toISOString(),
        })).join("\n") + "\n").repeat(20)
      : (JSON.stringify(row) + "\n").repeat(500_000);
    fs.writeFileSync(queuePath, content);
    const handler = api.createLocalApiHandler({ queuePath, trackerDataDir: directory });
    const url = new URL("http://localhost/functions/tokentracker-usage-summary?from=2000-01-01&to=2099-12-31&tz=UTC");
    let maxGap = 0, ticks = 0, last = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last); last = now; ticks++;
    }, 5);
    const started = performance.now();
    let response;
    await handler({ method: "GET", headers: { host: "localhost" } }, {
      setHeader() {}, writeHead() {}, end(body) { response = JSON.parse(body); },
    }, url);
    await new Promise((resolve) => setTimeout(resolve, 10));
    clearInterval(timer);
    const tokens = response?.totals?.total_tokens;
    if (tokens !== (manyBuckets ? 2_640_000 : 110)) throw new Error(`Unexpected usage total: ${tokens}`);
    console.log(JSON.stringify({ platform: process.platform, node: process.version,
      baseline: baselineArg?.slice("--baseline=".length) || null,
      buckets: manyBuckets ? 24_000 : 1, bytes: fs.statSync(queuePath).size,
      elapsedMs: Math.round(performance.now() - started), maxEventLoopGapMs: Math.round(maxGap), ticks, tokens }));
  } finally {
    clearInterval(timer);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
