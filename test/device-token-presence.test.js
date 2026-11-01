"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  createCloudDeviceTokenStore,
  resolveDeviceTokenPresence,
} = require("../src/lib/cloud-device-token");
const { cmdDoctor } = require("../src/commands/doctor");
const { cmdStatus } = require("../src/commands/status");
const { withHome } = require("./helpers/with-home");
const { DEFAULT_BASE_URL } = require("../src/lib/runtime-config");

const binding = {
  userId: "user-oauth",
  baseUrl: DEFAULT_BASE_URL,
  machineId: "machine-oauth",
};

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-device-presence-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const trackerDir = path.join(home, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });
  return { home, trackerDir };
}

test("legacy config.json deviceToken still counts as set", async (t) => {
  const { trackerDir } = await fixture(t);
  const presence = resolveDeviceTokenPresence({
    trackerDir,
    config: { baseUrl: DEFAULT_BASE_URL, deviceToken: "legacy-token", machineId: binding.machineId },
  });
  assert.equal(presence.set, true);
  assert.equal(presence.source, "config");
});

test("OAuth cloud-device-token.json alone counts as set for matching machine", async (t) => {
  const { trackerDir } = await fixture(t);
  assert.equal(
    createCloudDeviceTokenStore(path.join(trackerDir, "cloud-device-token.json")).set(binding, "oauth-token"),
    true,
  );
  const presence = resolveDeviceTokenPresence({
    trackerDir,
    config: { baseUrl: DEFAULT_BASE_URL, machineId: binding.machineId },
  });
  assert.equal(presence.set, true);
  assert.equal(presence.source, "cloud-device-token");
});

test("store token for another machine or baseUrl does not count", async (t) => {
  const { trackerDir } = await fixture(t);
  assert.equal(
    createCloudDeviceTokenStore(path.join(trackerDir, "cloud-device-token.json")).set(binding, "oauth-token"),
    true,
  );
  assert.equal(
    resolveDeviceTokenPresence({
      trackerDir,
      config: { baseUrl: DEFAULT_BASE_URL, machineId: "other-machine" },
    }).set,
    false,
  );
  assert.equal(
    resolveDeviceTokenPresence({
      trackerDir,
      config: { baseUrl: "https://self-hosted.example", machineId: binding.machineId, anonKey: "anon_" + "a".repeat(40) },
    }).set,
    false,
  );
});

test("config token wins over store for source reporting", async (t) => {
  const { trackerDir } = await fixture(t);
  createCloudDeviceTokenStore(path.join(trackerDir, "cloud-device-token.json")).set(binding, "oauth-token");
  const presence = resolveDeviceTokenPresence({
    trackerDir,
    config: {
      baseUrl: DEFAULT_BASE_URL,
      machineId: binding.machineId,
      deviceToken: "config-token",
    },
  });
  assert.equal(presence.set, true);
  assert.equal(presence.source, "config");
});

test("status --json reports device_token_set when only cloud-device-token.json exists", async (t) => {
  const { home, trackerDir } = await fixture(t);
  await fs.writeFile(
    path.join(trackerDir, "config.json"),
    JSON.stringify({ baseUrl: DEFAULT_BASE_URL, machineId: binding.machineId }) + "\n",
  );
  createCloudDeviceTokenStore(path.join(trackerDir, "cloud-device-token.json")).set(binding, "oauth-token");

  const restore = withHome(home);
  const prevWrite = process.stdout.write;
  let out = "";
  try {
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };
    await cmdStatus(["--json"]);
  } finally {
    process.stdout.write = prevWrite;
    restore();
  }
  const parsed = JSON.parse(out);
  assert.equal(parsed.device_token_set, true);
});

test("doctor reports runtime.device_token ok when only cloud-device-token.json exists", async (t) => {
  const { home, trackerDir } = await fixture(t);
  await fs.writeFile(
    path.join(trackerDir, "config.json"),
    JSON.stringify({ baseUrl: DEFAULT_BASE_URL, machineId: binding.machineId }) + "\n",
  );
  createCloudDeviceTokenStore(path.join(trackerDir, "cloud-device-token.json")).set(binding, "oauth-token");

  const restore = withHome(home);
  const prevFetch = globalThis.fetch;
  const prevWrite = process.stdout.write;
  let out = "";
  try {
    globalThis.fetch = async () => ({ status: 404 });
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };
    await cmdDoctor(["--json"]);
  } finally {
    process.stdout.write = prevWrite;
    globalThis.fetch = prevFetch;
    restore();
  }
  const report = JSON.parse(out);
  const tokenCheck = report.checks.find((c) => c.id === "runtime.device_token");
  assert.equal(tokenCheck.status, "ok");
  assert.equal(tokenCheck.meta.device_token, "set");
  assert.equal(tokenCheck.meta.source, "cloud-device-token");
  assert.ok(!out.includes("oauth-token"), "doctor must not leak the device token");
});
