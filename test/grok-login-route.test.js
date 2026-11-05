const assert = require("node:assert/strict");
const { test } = require("node:test");
const { handleGrokLoginRoute, GROK_LOGIN_ROUTE } = require("../src/lib/grok-login-route");

function mockRes() {
  return {
    status: 0,
    body: null,
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload ? JSON.parse(payload) : null;
    },
  };
}

test("grok login route ignores other paths", async () => {
  const handled = await handleGrokLoginRoute(
    { method: "GET", headers: {} },
    mockRes(),
    new URL("http://127.0.0.1/api/state"),
    { queuePath: "unused", isAuthorized: () => true },
  );
  assert.equal(handled, false);
});

test("grok login route rejects missing local auth", async () => {
  const res = mockRes();
  const handled = await handleGrokLoginRoute(
    { method: "POST", headers: {} },
    res,
    new URL(`http://127.0.0.1${GROK_LOGIN_ROUTE}`),
    { queuePath: "unused", isAuthorized: () => false },
  );
  assert.equal(handled, true);
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

test("grok login route opens the dedicated window", async () => {
  const res = mockRes();
  let opened = null;
  const handled = await handleGrokLoginRoute(
    { method: "POST", headers: {} },
    res,
    new URL(`http://127.0.0.1${GROK_LOGIN_ROUTE}`),
    {
      queuePath: "C:/tmp/.tokentracker/tracker/queue.jsonl",
      isAuthorized: () => true,
      openLogin: (opts) => {
        opened = opts;
      },
    },
  );
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.opened, true);
  assert.equal(opened.queuePath, "C:/tmp/.tokentracker/tracker/queue.jsonl");
});
