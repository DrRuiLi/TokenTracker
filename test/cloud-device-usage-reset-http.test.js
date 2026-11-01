const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { createHash, createHmac, randomUUID } = require("node:crypto");
const { build } = require("esbuild");
const secret = "isolated-reset-jwt-secret";
const userId = randomUUID(), deviceId = randomUUID(), machineId = randomUUID(), operationId = randomUUID();
let handler;
test.before(async () => {
  const filename = path.resolve(__dirname, "../dashboard/edge-patches/tokentracker-device-usage-reset.ts");
  const result = await build({ entryPoints: [filename], bundle: true, write: false, format: "cjs", platform: "node", logLevel: "silent",
    plugins: [{ name: "reset-test-sdk", setup(builder) {
      builder.onResolve({ filter: /^npm:@insforge\/sdk/ }, () => ({ path: "sdk", namespace: "reset-test" }));
      builder.onLoad({ filter: /.*/, namespace: "reset-test" }, () => ({ contents: "export function createClient(){return globalThis.__resetTestClient}", loader: "js" }));
    } }] });
  const compiled = new Module(filename); compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(result.outputFiles[0].text, filename); handler = compiled.exports.default;
});
function jwt(claims = {}, corrupt = false) {
  const input = [{ alg: "HS256" }, { sub: userId, role: "authenticated", exp: Date.now() / 1000 + 3600, ...claims }]
    .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return input + "." + (corrupt ? "forged" : createHmac("sha256", secret).update(input).digest("base64url"));
}
function environment(t, rpc, extra = {}) {
  const deno = globalThis.Deno, client = globalThis.__resetTestClient;
  globalThis.Deno = { env: { get: key => ({ JWT_SECRET: secret, INSFORGE_BASE_URL: "https://reset.invalid",
    INSFORGE_SERVICE_ROLE_KEY: "isolated-service-key", INSFORGE_ANON_KEY: "isolated-anon-key", ...extra })[key] } };
  globalThis.__resetTestClient = { database: { rpc } };
  t.after(() => { globalThis.Deno = deno; globalThis.__resetTestClient = client; });
}
function request(action, token, body = {}) {
  return new Request("https://reset.invalid/functions/tokentracker-device-usage-reset", { method: "POST",
    headers: token ? { Authorization: "Bearer " + token } : {},
    body: JSON.stringify({ action, device_id: deviceId, operation_id: operationId, ...body }) });
}
const success = (status = "reset") => ({ data: { ok: true, device_id: deviceId, machine_id: machineId,
  operation_id: operationId, removed_rows: 9, status }, error: null });

test("reset verifies the account JWT and uses only its subject and server environment", async t => {
  const calls = [];
  environment(t, async (name, args) => { calls.push({ name, args }); return success(); });
  for (const token of [undefined, "device-token", jwt({}, true), jwt({ exp: 1 }), jwt({ role: "service_role" })]) {
    assert.equal((await handler(request("reset", token))).status, 401);
  }
  assert.equal(calls.length, 0);
  const response = await handler(request("reset", jwt(), { user_id: randomUUID(), environment: "sandbox" }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(calls, [{ name: "cloud_reset_device_usage", args: {
    p_user_id: userId, p_device_id: deviceId, p_operation_id: operationId, p_environment: "live",
  } }]);
});

test("refresh accepts a device credential, hashes it, and never forwards raw tokens", async t => {
  const calls = [], token = "device-reset-test-token";
  environment(t, async (name, args) => { calls.push({ name, args }); return success("complete"); },
    { TOKENTRACKER_BILLING_ENVIRONMENT: "sandbox" });
  for (const bad of [undefined, jwt(), "a.b", "x".repeat(2049)]) {
    assert.equal((await handler(request("refresh", bad))).status, 401);
  }
  assert.equal(calls.length, 0);
  const response = await handler(request("refresh", token, { environment: "live", user_id: randomUUID() }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ name: "cloud_refresh_device_usage", args: {
    p_token_hash: createHash("sha256").update(token).digest("hex"), p_operation_id: operationId, p_environment: "sandbox",
  } }]);
});

test("invalid actions, identifiers, JSON, and oversized payloads never reach database RPC", async t => {
  environment(t, async () => assert.fail("invalid request reached database"));
  for (const [action, body] of [["delete", {}], ["reset", { device_id: "invalid" }], ["reset", { operation_id: null }]]) {
    assert.equal((await handler(request(action, jwt(), body))).status, 400);
  }
  for (const body of ["null", "[]", "{bad"]) {
    const response = await handler(new Request("https://reset.invalid", { method: "POST", body }));
    assert.equal(response.status, 400);
  }
  assert.equal((await handler(request("reset", jwt(), { padding: "x".repeat(4096) }))).status, 413);
  assert.equal((await handler(new Request("https://reset.invalid"))).status, 405);
  assert.equal((await handler(new Request("https://reset.invalid", { method: "OPTIONS" }))).status, 204);
});

test("database denials preserve their HTTP status and unexpected errors disclose no details", async t => {
  let result = { data: { ok: false, code: "cloud_device_token_rejected", status: 401 }, error: null };
  environment(t, async () => result);
  const rejected = await handler(request("refresh", "revoked-token"));
  assert.equal(rejected.status, 401); assert.equal((await rejected.json()).code, "cloud_device_token_rejected");
  result = { data: null, error: { message: "sensitive database details" } };
  const unavailable = await handler(request("reset", jwt()));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { ok: false, code: "cloud_usage_reset_unavailable", status: 503 });
});

test("incomplete or inconsistent success responses cannot acknowledge reset or refresh", async t => {
  let result;
  environment(t, async () => result);
  for (const patch of [{ operation_id: randomUUID() }, { device_id: randomUUID() }, { machine_id: null },
    { removed_rows: -1 }, { removed_rows: 1.5 }, { status: "unknown" }]) {
    result = success(); Object.assign(result.data, patch);
    assert.equal((await handler(request("reset", jwt()))).status, 503);
  }
  result = success("reset");
  assert.equal((await handler(request("refresh", "device-token"))).status, 503);
});
