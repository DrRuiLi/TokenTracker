import { beforeEach, expect, it, vi } from "vitest";
import { rebuildCloudDeviceUsage } from "./cloud-sync";
import { clearCloudDeviceSession, getStoredDeviceSession, setCloudSyncEnabled } from "./cloud-sync-prefs";
vi.mock("./insforge-config", () => ({ getInsforgeRemoteUrl: () => "https://cloud.example" }));
vi.mock("./local-api-auth", () => ({ getLocalApiAuthHeaders: async () => ({ "x-tokentracker-local-auth": "local-test" }) }));
const jwt = (sub = "owner-a") => `e30.${btoa(JSON.stringify({ sub, exp: Date.now() / 1000 + 3600 }))}.sig`;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => { vi.unstubAllGlobals(); localStorage.clear(); localStorage.setItem("tokentracker_cloud_sync_enabled", "1"); clearCloudDeviceSession(); });
function bridge(pending: boolean, onReset?: () => void) {
  let issuance = 0;
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("cloud-sync-pref")) return response({ ok: true });
    if (url.endsWith("cloud-session")) {
      if (JSON.parse(String(init?.body)).clear) return response({ ok: true });
      issuance += 1; return response({ session_id: `session-${issuance}`, device_id: "device-id", created_at: new Date().toISOString() });
    }
    if (url.endsWith("cloud-usage-reset")) {
      if (init?.method === "POST") { onReset?.(); return response({ ok: true, pending: true }); }
      return response({ pending });
    }
    if (url.endsWith("local-sync")) return response({ ok: true, pending, uploaded: !pending });
    throw new Error("unexpected request");
  });
  vi.stubGlobal("fetch", mock); return mock;
}
it.each([true, false])("preserves pending=%s until reset completion and proves a fresh upload session", async pending => {
  const mock = bridge(pending);
  expect(await rebuildCloudDeviceUsage(async () => jwt())).toEqual({ pending });
  const calls = mock.mock.calls;
  const reset = calls.find(([url, init]) => url.endsWith("cloud-usage-reset") && init?.method === "POST");
  const upload = calls.find(([url]) => url.endsWith("local-sync"));
  expect(JSON.parse(String(reset?.[1]?.body)).cloudSessionId).toBe("session-1");
  expect(JSON.parse(String(upload?.[1]?.body)).cloudSessionId).toBe("session-2");
  expect(getStoredDeviceSession()?.localSessionId).toBe("session-2");
});
it("ignores reset completion if cloud sync was disabled while upstream reset was pending", async () => {
  const mock = bridge(false, () => setCloudSyncEnabled(false));
  await expect(rebuildCloudDeviceUsage(async () => jwt())).rejects.toMatchObject({ code: "auth_session_changed" });
  expect(mock.mock.calls.some(([url]) => url.endsWith("local-sync"))).toBe(false);
});
it("keeps another account's session when an old reset acknowledgement arrives", async () => {
  let owner = "owner-a";
  const mock = bridge(false, () => { owner = "owner-b"; clearCloudDeviceSession(); });
  await expect(rebuildCloudDeviceUsage(async () => jwt(owner))).rejects.toMatchObject({ code: "auth_session_changed" });
  expect(mock.mock.calls.some(([url]) => url.endsWith("local-sync"))).toBe(false);
});
it("rechecks account ownership before sending a destructive reset", async () => {
  const mock = bridge(false);
  await expect(rebuildCloudDeviceUsage(async () => jwt(getStoredDeviceSession() ? "owner-b" : "owner-a"))).rejects.toMatchObject({ code: "auth_session_changed" });
  expect(mock.mock.calls.some(([url, init]) => url.endsWith("cloud-usage-reset") && init?.method === "POST")).toBe(false);
});
