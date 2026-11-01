"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, beforeEach, afterEach } = require("node:test");
const {
  isProviderId,
  envNameForProvider,
  resolveProviderKeyPath,
  normalizeApiKey,
  readStoredApiKey,
  writeStoredApiKey,
} = require("../src/lib/provider-api-key-store");

let tmpHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-provider-key-store-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("writes and reads an OpenCode Go key in a 0600 file", async () => {
  const filePath = await writeStoredApiKey({
    provider: "opencode-go",
    home: tmpHome,
    apiKey: "  test-key-abc123  ",
  });

  assert.equal(
    filePath,
    path.join(tmpHome, ".tokentracker", "tracker", "opencode-go-api-key.json"),
  );
  assert.equal(
    readStoredApiKey({ provider: "opencode-go", home: tmpHome }),
    "test-key-abc123",
  );

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(parsed.apiKey, "test-key-abc123");
  assert.match(parsed.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
});

test("tightens permissions on an existing store", async () => {
  const filePath = await writeStoredApiKey({
    provider: "command-code",
    home: tmpHome,
    apiKey: "cmd-key-abcdef",
  });
  if (process.platform === "win32") return;

  fs.chmodSync(filePath, 0o644);
  await writeStoredApiKey({ provider: "command-code", home: tmpHome, apiKey: "cmd-key-ghijkl" });
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(readStoredApiKey({ provider: "command-code", home: tmpHome }), "cmd-key-ghijkl");
});

test("keeps providers isolated", async () => {
  await writeStoredApiKey({ provider: "opencode-go", home: tmpHome, apiKey: "opencode-key-1" });
  assert.equal(readStoredApiKey({ provider: "command-code", home: tmpHome }), "");
  await writeStoredApiKey({ provider: "command-code", home: tmpHome, apiKey: "command-key-1" });
  assert.equal(readStoredApiKey({ provider: "opencode-go", home: tmpHome }), "opencode-key-1");
});

test("supports an explicit trackerDir and validates provider ids", () => {
  const trackerDir = path.join(tmpHome, "custom-tracker");
  assert.equal(
    resolveProviderKeyPath({ provider: "opencode-go", trackerDir }),
    path.join(trackerDir, "opencode-go-api-key.json"),
  );
  assert.equal(resolveProviderKeyPath({ provider: "../escape", trackerDir }), null);
  assert.equal(isProviderId("opencode-go"), true);
  assert.equal(isProviderId("command-code"), true);
  assert.equal(isProviderId("nope"), false);
  assert.equal(envNameForProvider("opencode-go"), "OPENCODE_GO_API_KEY");
  assert.equal(envNameForProvider("command-code"), "COMMAND_CODE_API_KEY");
});

test("rejects keys that cannot be sent verbatim in an auth header", async () => {
  for (const bad of ["", "   ", "short", "has space here", "line\nbreak", 42, null]) {
    assert.equal(normalizeApiKey(bad), "");
    await assert.rejects(
      writeStoredApiKey({ provider: "opencode-go", home: tmpHome, apiKey: bad }),
      /Invalid API key/,
    );
  }
  assert.equal(readStoredApiKey({ provider: "opencode-go", home: tmpHome }), "");
});

test("degrades to no key for missing, corrupt, or non-string stores", () => {
  const filePath = path.join(tmpHome, ".tokentracker", "tracker", "opencode-go-api-key.json");
  assert.equal(readStoredApiKey({ provider: "opencode-go", home: tmpHome }), "");

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "not json");
  assert.equal(readStoredApiKey({ provider: "opencode-go", home: tmpHome }), "");

  fs.writeFileSync(filePath, JSON.stringify({ apiKey: 12345 }));
  assert.equal(readStoredApiKey({ provider: "opencode-go", home: tmpHome }), "");

  fs.writeFileSync(filePath, JSON.stringify({ apiKey: "valid-key-123" }));
  assert.equal(readStoredApiKey({ provider: "opencode-go", home: tmpHome }), "valid-key-123");
});

test("never reads a home-directory store without an explicit home or trackerDir", () => {
  assert.equal(readStoredApiKey({ provider: "opencode-go" }), "");
  assert.equal(resolveProviderKeyPath({ provider: "opencode-go" }), null);
});
