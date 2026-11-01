"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test, beforeEach, afterEach } = require("node:test");

const PROVIDER_ENV_NAMES = ["OPENCODE_GO_API_KEY", "COMMAND_CODE_API_KEY"];

let tmpHome;
let previousEnv = {};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-provider-key-api-"));
  previousEnv = {};
  for (const name of PROVIDER_ENV_NAMES) {
    previousEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of PROVIDER_ENV_NAMES) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function freshHandler(queuePath) {
  delete require.cache[require.resolve("../src/lib/local-api")];
  const { createLocalApiHandler } = require("../src/lib/local-api");
  return createLocalApiHandler({ queuePath });
}

function makeQueuePath() {
  const queuePath = path.join(tmpHome, ".tokentracker", "tracker", "queue.jsonl");
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, "");
  return queuePath;
}

function makeReq({ method = "GET", urlObj, headers = {}, body } = {}) {
  const base = Readable.from(body != null ? [Buffer.from(body)] : []);
  base.method = method;
  base.url = urlObj.pathname + urlObj.search;
  base.headers = { host: "localhost", ...headers };
  return base;
}

function makeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 200,
    _headers: headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    writeHead(status, hdrs) {
      this.statusCode = status;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
    },
    end(body) {
      if (body) chunks.push(body);
    },
    body() {
      return chunks.join("");
    },
    json() {
      return JSON.parse(chunks.join(""));
    },
  };
}

async function call(handler, opts) {
  const urlObj = new URL(`http://localhost${opts.endpoint}`);
  const req = makeReq({ ...opts, urlObj });
  const res = makeRes();
  const handled = await handler(req, res, urlObj);
  assert.ok(handled, `endpoint must be handled: ${opts.endpoint}`);
  return res;
}

async function authToken(handler) {
  const authRes = await call(handler, { endpoint: "/api/local-auth" });
  return authRes.json().token;
}

function keyPath(provider = "opencode-go") {
  return path.join(
    tmpHome,
    ".tokentracker",
    "tracker",
    provider === "opencode-go" ? "opencode-go-api-key.json" : "command-code-api-key.json",
  );
}

test("GET reports not configured without a key and rejects unknown providers", async () => {
  const handler = freshHandler(makeQueuePath());

  const none = await call(handler, {
    endpoint: "/functions/tokentracker-provider-key?provider=opencode-go",
  });
  assert.equal(none.statusCode, 200);
  assert.deepEqual(none.json(), {
    provider: "opencode-go",
    configured: false,
    source: "none",
  });

  const unknown = await call(handler, {
    endpoint: "/functions/tokentracker-provider-key?provider=../etc/passwd",
  });
  assert.equal(unknown.statusCode, 400);
});

test("POST requires local auth and stores a 0600 key without echoing it", async () => {
  const queuePath = makeQueuePath();
  const handler = freshHandler(queuePath);
  const body = JSON.stringify({ provider: "opencode-go", apiKey: "test-key-abc123" });

  const denied = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-provider-key",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(denied.statusCode, 401);
  assert.equal(fs.existsSync(keyPath()), false);

  const token = await authToken(handler);
  const invalid = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-provider-key",
    headers: {
      "content-type": "application/json",
      "x-tokentracker-local-auth": token,
    },
    body: JSON.stringify({ provider: "opencode-go", apiKey: "" }),
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(fs.existsSync(keyPath()), false);

  const saved = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-provider-key",
    headers: {
      "content-type": "application/json",
      "x-tokentracker-local-auth": token,
    },
    body,
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json(), { ok: true, configured: true, source: "stored" });
  assert.equal(saved.body().includes("test-key-abc123"), false);

  const stored = JSON.parse(fs.readFileSync(keyPath(), "utf8"));
  assert.equal(stored.apiKey, "test-key-abc123");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(keyPath()).mode & 0o777, 0o600);
  }

  const status = await call(handler, {
    endpoint: "/functions/tokentracker-provider-key?provider=opencode-go",
  });
  assert.deepEqual(status.json(), {
    provider: "opencode-go",
    configured: true,
    source: "stored",
  });
});

test("saving a key drops the OpenCode Go limits cache and invalidates in-flight fetches", async () => {
  const queuePath = makeQueuePath();
  const cachePath = path.join(
    path.dirname(queuePath),
    "opencode-go-usage-limits-cache.json",
  );
  fs.writeFileSync(cachePath, JSON.stringify({ primary_window: { used_percent: 99 } }));
  const handler = freshHandler(queuePath);
  const token = await authToken(handler);

  const usageLimits = require("../src/lib/usage-limits");
  const originalReset = usageLimits.resetUsageLimitsCache;
  const resetCalls = [];
  usageLimits.resetUsageLimitsCache = (options) => {
    resetCalls.push(options);
    return originalReset(options);
  };
  let saved;
  try {
    saved = await call(handler, {
      method: "POST",
      endpoint: "/functions/tokentracker-provider-key",
      headers: {
        "content-type": "application/json",
        "x-tokentracker-local-auth": token,
      },
      body: JSON.stringify({ provider: "opencode-go", apiKey: "test-key-abc123" }),
    });
  } finally {
    usageLimits.resetUsageLimitsCache = originalReset;
  }
  assert.equal(saved.statusCode, 200);
  assert.equal(fs.existsSync(cachePath), false);
  assert.deepEqual(resetCalls, [{ invalidateInFlight: true }]);
});

test("GET reports the environment as the source when OPENCODE_GO_API_KEY is set", async () => {
  process.env.OPENCODE_GO_API_KEY = "env-key-123456";
  const handler = freshHandler(makeQueuePath());

  const res = await call(handler, {
    endpoint: "/functions/tokentracker-provider-key?provider=opencode-go",
  });
  assert.deepEqual(res.json(), {
    provider: "opencode-go",
    configured: true,
    source: "env",
  });
});

test("stores Command Code keys independently", async () => {
  const handler = freshHandler(makeQueuePath());
  const token = await authToken(handler);

  const saved = await call(handler, {
    method: "POST",
    endpoint: "/functions/tokentracker-provider-key",
    headers: {
      "content-type": "application/json",
      "x-tokentracker-local-auth": token,
    },
    body: JSON.stringify({ provider: "command-code", apiKey: "command-key-123" }),
  });
  assert.equal(saved.statusCode, 200);

  const commandStatus = await call(handler, {
    endpoint: "/functions/tokentracker-provider-key?provider=command-code",
  });
  assert.equal(commandStatus.json().source, "stored");

  const opencodeStatus = await call(handler, {
    endpoint: "/functions/tokentracker-provider-key?provider=opencode-go",
  });
  assert.equal(opencodeStatus.json().configured, false);
});
