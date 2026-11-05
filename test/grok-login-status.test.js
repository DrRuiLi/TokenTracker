const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { GROK_HOST_SQL, grokComSignedIn } = require("../src/lib/grok-login-status");
const { handleGrokLoginRoute, GROK_LOGIN_ROUTE } = require("../src/lib/grok-login-route");

function mockRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) {
      this.status = status;
    },
    end(payload) {
      this.body = payload ? JSON.parse(payload) : null;
    },
  };
}

test("grok host query never reads cookie values", () => {
  assert.match(GROK_HOST_SQL, /SELECT 1 AS present/);
  assert.doesNotMatch(GROK_HOST_SQL, /value|encrypted_value|name/i);
});

test("grokComSignedIn is false when the cookie database is missing", async () => {
  const missing = path.join(os.tmpdir(), "tt-missing-grok-cookies");
  assert.equal(await grokComSignedIn(missing), false);
});

test("grokComSignedIn reads only a grok.com host row", async () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-cookies-"));
  const cookies = path.join(dir, "Cookies");
  const db = new DatabaseSync(cookies);
  db.exec("CREATE TABLE cookies (host_key TEXT, value TEXT)");
  const insert = db.prepare("INSERT INTO cookies (host_key, value) VALUES (?, ?)");
  insert.run("notgrok.com", "secret");
  insert.run("grok.com.evil", "secret");
  db.close();
  assert.equal(await grokComSignedIn(cookies), false);
  const again = new DatabaseSync(cookies);
  again.prepare("INSERT INTO cookies (host_key, value) VALUES (?, ?)").run(".grok.com", "secret");
  again.close();
  assert.equal(await grokComSignedIn(cookies), true);
});

test("grokComSignedIn follows the grok.com host probe", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-grok-status-"));
  const cookies = path.join(dir, "Cookies");
  fs.writeFileSync(cookies, "");
  assert.equal(await grokComSignedIn(cookies, { readPresent: async () => true }), true);
  assert.equal(await grokComSignedIn(cookies, { readPresent: async () => false }), false);
  assert.equal(await grokComSignedIn(cookies, { readPresent: async () => { throw new Error("locked"); } }), null);
});

test("grok login status reports grok.com presence", async () => {
  const res = mockRes();
  const handled = await handleGrokLoginRoute(
    { method: "GET", headers: {} },
    res,
    new URL(`http://127.0.0.1${GROK_LOGIN_ROUTE}`),
    {
      queuePath: path.join(os.tmpdir(), "queue.jsonl"),
      isAuthorized: () => true,
      signedInProbe: async () => true,
    },
  );
  assert.equal(handled, true);
  assert.equal(res.body.signedIn, true);
  assert.equal(res.body.uncertain, false);
});
