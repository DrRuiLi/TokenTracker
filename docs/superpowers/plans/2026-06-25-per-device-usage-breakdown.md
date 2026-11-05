# Per-Device Usage Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user with multiple devices filter the dashboard by device, crossed with the existing time dimension (e.g. "this month × MacBook"), plus a left-column card comparing per-device usage.

**Architecture:** The cloud DB already stores usage per `device_id`; the aggregation RPC `account_usage_grouped` already accepts a `p_device_ids` array. We expose the device dimension by (1) letting each `account-*` edge endpoint narrow that array to a requested `device_id`, (2) adding one `account-devices` endpoint that lists the account's devices with per-device totals, and (3) threading a `deviceId` through the dashboard's data hooks plus a top-bar dropdown and a left-column device card. No DB migration, no `src/` (CLI) change, no `queue.jsonl` change.

**Tech Stack:** Edge functions = Deno + `@insforge/sdk` (tested statically via `node --test`). Dashboard = React 18 + Vite + TS strict, tested with **vitest** (`cd dashboard && npx vitest run <file>`), jsdom + `@testing-library/react`.

## Global Constraints

- **CommonJS in `src/`, ESM + TypeScript strict in `dashboard/`. No mixing.** (Edge files are Deno TS.)
- **Do NOT modify the `MODEL_PRICING` / `getModelPricing` block** in any edge file. `test/edge-pricing-parity.test.js` asserts those blocks are byte-identical across `tokentracker-leaderboard-refresh.ts`, `account-daily.ts`, `account-summary.ts`, `account-model-breakdown.ts`, `leaderboard-profile.ts`. Our edits must not touch them.
- **Security boundary:** a requested `device_id` MUST be validated with `activeDeviceIds.includes(requestedDeviceId)` before use. `activeDeviceIds` is already filtered to the JWT-verified `userId`; an id outside it (another user's device, a revoked one) is ignored and the endpoint falls back to all devices.
- **Cache correctness:** every usage hook's `storageKey` MUST include the device scope, or switching device shows another scope's cached data.
- **Device UI only in account view:** the dropdown and the device card render only when `accountView === true` AND the account has `>= 2` active devices.
- **Default = "all devices" = current behavior.** With no `device_id`, every endpoint and hook must behave byte-identically to today (regression-free for existing users).
- **No hardcoded UI strings.** All user-facing text goes through `copy(...)` backed by `dashboard/src/content/copy.csv` (+ i18n JSON for zh / zh-TW / ja / ko). Passes `npm run validate:copy` and `npm run validate:ui-hardcode`.
- **Commits in English, conventional style** (`feat:` / `test:` / etc.).
- Branch first if on `main` (do not commit design/plan work directly to a release branch without a feature branch).

---

### Task 1: Edge — narrow `account-*` endpoints by optional `device_id`

**Files:**
- Modify: `dashboard/edge-patches/tokentracker-account-daily.ts`
- Modify: `dashboard/edge-patches/tokentracker-account-summary.ts`
- Modify: `dashboard/edge-patches/tokentracker-account-hourly.ts`
- Modify: `dashboard/edge-patches/tokentracker-account-monthly.ts`
- Modify: `dashboard/edge-patches/tokentracker-account-heatmap.ts`
- Modify: `dashboard/edge-patches/tokentracker-account-model-breakdown.ts`
- Test: `test/account-device-filter.test.js` (create)

**Interfaces:**
- Consumes: existing `let activeDeviceIds: string[]` (assigned via `await fetchActiveDeviceIds(client, userId)`) and `const url = new URL(req.url)` already present in every endpoint.
- Produces: each endpoint honors an optional `?device_id=<uuid>` query param, narrowing aggregation to that one device.

- [ ] **Step 1: Write the failing static test**

Create `test/account-device-filter.test.js`:

```js
"use strict";

// The six account-* edge endpoints must each honor an optional ?device_id=
// query param by narrowing activeDeviceIds to that one device — but ONLY when
// the id belongs to the JWT-verified user (the includes() guard). This is a
// static source check (the endpoints are Deno + InsForge SDK and can't run
// under node --test); it guarantees all six got the identical guarded narrow.

const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");
const EDGE_DIR = "dashboard/edge-patches";

const ENDPOINTS = [
  "tokentracker-account-daily.ts",
  "tokentracker-account-summary.ts",
  "tokentracker-account-hourly.ts",
  "tokentracker-account-monthly.ts",
  "tokentracker-account-heatmap.ts",
  "tokentracker-account-model-breakdown.ts",
];

function readEdge(name) {
  return fs.readFileSync(path.join(ROOT, EDGE_DIR, name), "utf8");
}

test("every account-* endpoint reads device_id and guards it with includes()", () => {
  for (const name of ENDPOINTS) {
    const src = readEdge(name);
    assert.ok(
      src.includes('url.searchParams.get("device_id")'),
      `${name}: does not read the device_id query param`,
    );
    assert.ok(
      /activeDeviceIds\.includes\(\s*requestedDeviceId\s*\)/.test(src),
      `${name}: missing the includes(requestedDeviceId) ownership guard`,
    );
    assert.ok(
      /activeDeviceIds\s*=\s*\[\s*requestedDeviceId\s*\]/.test(src),
      `${name}: does not narrow activeDeviceIds to [requestedDeviceId]`,
    );
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/account-device-filter.test.js`
Expected: FAIL — first endpoint `does not read the device_id query param`.

- [ ] **Step 3: Apply the identical narrow block to all six endpoints**

In each of the six files, find the line that assigns `activeDeviceIds` from `fetchActiveDeviceIds`, e.g. in `account-daily.ts` / `account-summary.ts`:

```ts
  let activeDeviceIds: string[];
  try {
    activeDeviceIds = await fetchActiveDeviceIds(client, userId);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
```

Immediately **after that `try/catch`**, insert this block (identical in all six files):

```ts
  // Optional single-device scope. The dashboard device filter passes
  // ?device_id=<uuid>; narrow the active set to just that device. The
  // includes() check is a security boundary: activeDeviceIds is already
  // filtered to this JWT-verified user, so an id outside it (another user's
  // device, or a revoked one) is ignored and we fall back to all devices.
  const requestedDeviceId = url.searchParams.get("device_id");
  if (requestedDeviceId && activeDeviceIds.includes(requestedDeviceId)) {
    activeDeviceIds = [requestedDeviceId];
  }
```

Notes for the implementer:
- `url` (`const url = new URL(req.url)`) is already defined at the top of every handler; `activeDeviceIds` is already `let`. No other change.
- If a file declares `const activeDeviceIds`, change it to `let`. (daily/summary already use `let`.)
- Do NOT touch the `MODEL_PRICING` / `getModelPricing` block in daily/summary/model-breakdown.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/account-device-filter.test.js`
Expected: PASS.

- [ ] **Step 5: Guard against pricing-block drift**

Run: `node --test test/edge-pricing-parity.test.js`
Expected: PASS (we never touched the pricing blocks).

- [ ] **Step 6: Commit**

```bash
git add dashboard/edge-patches/tokentracker-account-*.ts test/account-device-filter.test.js
git commit -m "feat(edge): narrow account-* endpoints by optional device_id"
```

---

### Task 2: Edge — new `tokentracker-account-devices` endpoint

**Files:**
- Create: `dashboard/edge-patches/tokentracker-account-devices.ts`
- Test: extend `test/account-device-filter.test.js`

**Interfaces:**
- Produces: `GET /functions/tokentracker-account-devices?from=&to=&tz=&tz_offset_minutes=` → `{ from, to, devices: Array<{ id, device_name, platform, created_at, total_tokens }> }`, sorted by `total_tokens` descending. Auth: `Bearer <jwt>` verified via HS256 `JWT_SECRET`.

- [ ] **Step 1: Write the failing static test**

Append to `test/account-device-filter.test.js`:

```js
test("account-devices endpoint exists, verifies JWT, queries devices, sums per-device", () => {
  const src = readEdge("tokentracker-account-devices.ts");
  assert.ok(src.includes("verifiedUserIdFromJwt"), "missing JWT verification");
  assert.ok(
    src.includes('.from("tokentracker_devices")'),
    "does not query tokentracker_devices",
  );
  assert.ok(src.includes('"device_name"') || src.includes("device_name"), "no device_name field");
  assert.ok(src.includes("account_usage_grouped"), "does not sum usage via the RPC");
  assert.ok(src.includes("total_tokens"), "does not return per-device total_tokens");
});

test("account-devices is NOT in the pricing-parity mirror set (no MODEL_PRICING block)", () => {
  const src = readEdge("tokentracker-account-devices.ts");
  assert.ok(!src.includes("const MODEL_PRICING"), "account-devices must not embed a pricing block");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/account-device-filter.test.js`
Expected: FAIL — `ENOENT` reading `tokentracker-account-devices.ts`.

- [ ] **Step 3: Create the endpoint**

Create `dashboard/edge-patches/tokentracker-account-devices.ts`:

```ts
/**
 * InsForge Edge: list the signed-in user's active devices with per-device
 * usage totals for [from, to]. Powers the dashboard device filter dropdown
 * and the per-device usage card. Reuses account_usage_grouped (no DB change):
 * one RPC per device with p_device_ids=[id] gives that device's isolated sum.
 *
 * Auth: HS256 JWT_SECRET signature verification (same template as
 * tokentracker-account-summary). InsForge does NOT validate JWTs at the
 * gateway, so we verify the signature ourselves before returning per-user data.
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const raw = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function verifiedUserIdFromJwt(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const secret = Deno.env.get("JWT_SECRET");
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]);
    const ok = await crypto.subtle.verify("HMAC", key, sig, data);
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    const sub = payload.sub;
    if (typeof sub === "string" && sub.length > 0) return sub;
    const uid = payload.user_id;
    if (typeof uid === "string" && uid.length > 0) return uid;
  } catch { /* ignore */ }
  return null;
}

interface DeviceRow {
  id: string;
  device_name: string | null;
  platform: string | null;
  created_at: string | null;
}

interface GroupedRow {
  total_tokens: number | null;
}

async function sumDeviceTokens(
  client: ReturnType<typeof createClient>,
  userId: string,
  deviceId: string,
  fromIso: string,
  toIso: string,
  tz: string | null,
  tzOffsetMinutes: number | null,
): Promise<number> {
  const { data, error } = await client.database.rpc("account_usage_grouped", {
    p_user_id: userId,
    p_device_ids: [deviceId],
    p_from: fromIso,
    p_to: toIso,
    p_trunc: "day",
    p_tz: tz,
    p_offset_min: tzOffsetMinutes,
  });
  if (error) throw new Error(error.message);
  const rows = (Array.isArray(data) ? data : []) as GroupedRow[];
  let sum = 0;
  for (const r of rows) sum += Number(r.total_tokens) || 0;
  return sum;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  if (!from || !to) return json({ error: "Missing from/to" }, 400);
  const tz = url.searchParams.get("tz") || null;
  const tzOffsetRaw = url.searchParams.get("tz_offset_minutes");
  const tzOffsetMinutes = tzOffsetRaw != null && tzOffsetRaw !== "" ? Number(tzOffsetRaw) : null;

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) return json({ error: "server misconfigured" }, 500);

  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  const userId = await verifiedUserIdFromJwt(req.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  let devices: DeviceRow[];
  try {
    const { data, error } = await client.database
      .from("tokentracker_devices")
      .select("id, device_name, platform, created_at")
      .eq("user_id", userId)
      .is("revoked_at", null);
    if (error) throw new Error(error.message);
    devices = (data ?? []) as DeviceRow[];
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  // Widen the UTC window ±1 day so TZ-shifted edge hours are captured (mirrors
  // account-summary). The RPC handles per-device isolation + source-class
  // dedup; a single-device query needs no extra dedup.
  const startDate = new Date(`${from}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const endDate = new Date(`${to}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 2);
  const rangeStart = startDate.toISOString();
  const rangeEnd = endDate.toISOString();

  let withTotals: Array<DeviceRow & { total_tokens: number }>;
  try {
    withTotals = await Promise.all(
      devices.map(async (d) => ({
        ...d,
        total_tokens: await sumDeviceTokens(client, userId, d.id, rangeStart, rangeEnd, tz, tzOffsetMinutes),
      })),
    );
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  withTotals.sort((a, b) => b.total_tokens - a.total_tokens);
  return json({ from, to, devices: withTotals });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/account-device-filter.test.js`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add dashboard/edge-patches/tokentracker-account-devices.ts test/account-device-filter.test.js
git commit -m "feat(edge): add account-devices endpoint (per-device usage totals)"
```

---

### Task 3: Dashboard API — thread `device` through filters + add `fetchAccountDevices`

**Files:**
- Modify: `dashboard/src/lib/api.ts` (`buildFilterParams` ~115-122; the 6 `fetchCloudUsage*` + 6 `getUsage*` already call it; add `ACCOUNT_PATHS.devices` + `fetchAccountDevices`)
- Test: `dashboard/src/lib/api.device.test.ts` (create)

**Interfaces:**
- Consumes: existing `buildFilterParams`, `fetchAccountFunction`, `ACCOUNT_PATHS`.
- Produces:
  - `buildFilterParams({ source, model, device })` → adds `device_id: <device>` when `device` is a non-empty string.
  - `fetchAccountDevices({ from, to, timeZone, tzOffsetMinutes, accessToken })` → calls `tokentracker-account-devices`, returns `{ from, to, devices }`.
  - All 6 `fetchCloudUsage*` and `getUsage*`/`getUsageDaily/Hourly/Monthly/Heatmap/ModelBreakdown` accept an optional `device` arg and forward it.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/lib/api.device.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCloudUsageSummary, fetchAccountDevices } from "./api";

vi.mock("./insforge-config", () => ({
  getInsforgeRemoteUrl: () => "https://edge.example.test",
  getInsforgeAnonKey: () => "anon-key",
}));
vi.mock("./auth-token", () => ({
  isValidJwtShape: () => true,
}));
vi.mock("./mock-data", () => ({
  isMockEnabled: () => false,
}));

const JWT = "header.payload.sig";

function lastFetchUrl() {
  const calls = (globalThis.fetch as any).mock.calls;
  return new URL(calls[calls.length - 1][0]);
}

describe("api device filter", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ devices: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as any;
  });
  afterEach(() => vi.restoreAllMocks());

  it("encodes device_id on cloud usage requests when a device is given", async () => {
    await fetchCloudUsageSummary({ from: "2026-06-01", to: "2026-06-30", device: "dev-1", accessToken: JWT });
    expect(lastFetchUrl().searchParams.get("device_id")).toBe("dev-1");
  });

  it("omits device_id when no device is given", async () => {
    await fetchCloudUsageSummary({ from: "2026-06-01", to: "2026-06-30", accessToken: JWT });
    expect(lastFetchUrl().searchParams.get("device_id")).toBeNull();
  });

  it("fetchAccountDevices hits the account-devices slug", async () => {
    await fetchAccountDevices({ from: "2026-06-01", to: "2026-06-30", accessToken: JWT });
    expect(lastFetchUrl().pathname).toContain("tokentracker-account-devices");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/lib/api.device.test.ts`
Expected: FAIL — `fetchAccountDevices` is not exported / `device_id` not encoded.

- [ ] **Step 3: Implement**

In `dashboard/src/lib/api.ts`:

(a) Extend `buildFilterParams` (~line 115):

```ts
function buildFilterParams({ source, model, device }: AnyRecord = {}) {
  const params: AnyRecord = {};
  const normalizedSource = typeof source === "string" ? source.trim().toLowerCase() : "";
  if (normalizedSource) params.source = normalizedSource;
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (normalizedModel) params.model = normalizedModel;
  const normalizedDevice = typeof device === "string" ? device.trim() : "";
  if (normalizedDevice) params.device_id = normalizedDevice;
  return params;
}
```

(b) For each cloud fetcher that takes filters, add `device` to its destructured args and pass it to `buildFilterParams`. The five that build filters from `{ source, model }` → `{ source, model, device }`: `fetchCloudUsageSummary`, `fetchCloudUsageDaily`, `fetchCloudUsageHourly`, `fetchCloudUsageMonthly`, `fetchCloudUsageHeatmap`. The one that builds from `{ source }` only → `{ source, device }`: `fetchCloudUsageModelBreakdown`. Example (`fetchCloudUsageSummary`):

```ts
export async function fetchCloudUsageSummary({
  from, to, source, model, device,
  timeZone, tzOffsetMinutes, rolling = false, accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  const rollingParams = rolling ? { rolling: "1" } : {};
  return fetchAccountFunction(
    ACCOUNT_PATHS.summary,
    { from, to, ...filterParams, ...tzParams, ...rollingParams },
    accessToken,
  );
}
```

Apply the same one-line change (`device` in args + in `buildFilterParams(...)`) to the other five cloud fetchers, and to the local `getUsageSummary/Daily/Hourly/Monthly/Heatmap/ModelBreakdown` (so the prop is accepted everywhere and silently ignored by the local CLI endpoint — local rows are single-device).

(c) Add the devices slug + fetcher. In the `ACCOUNT_PATHS` object add `devices: "tokentracker-account-devices"`, then append:

```ts
export async function fetchAccountDevices({
  from, to, timeZone, tzOffsetMinutes, accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  return fetchAccountFunction(ACCOUNT_PATHS.devices, { from, to, ...tzParams }, accessToken);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/lib/api.device.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd dashboard && npx tsc --noEmit && cd ..
git add dashboard/src/lib/api.ts dashboard/src/lib/api.device.test.ts
git commit -m "feat(dashboard): thread device_id through api + add fetchAccountDevices"
```

---

### Task 4: Dashboard hooks — accept and forward `deviceId`

**Files:**
- Modify: `dashboard/src/hooks/use-usage-data.ts`
- Modify: `dashboard/src/hooks/use-usage-model-breakdown.ts`
- Modify: `dashboard/src/hooks/use-trend-data.ts`
- Modify: `dashboard/src/hooks/use-activity-heatmap.ts`
- Test: `dashboard/src/hooks/use-usage-data.device.test.tsx` (create)

**Interfaces:**
- Consumes: `fetchCloudUsage*` (now accept `device`).
- Produces: each hook accepts `deviceId` (default `null`), forwards it as `device: deviceId` to its fetcher(s), includes it in `storageKey`, and lists it in the `refresh` dependency array.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/hooks/use-usage-data.device.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCloudUsageDaily, fetchCloudUsageSummary } from "../lib/api";
import { useUsageData } from "./use-usage-data";

vi.mock("../lib/api", () => ({
  fetchCloudUsageDaily: vi.fn(async () => ({ from: "2026-06-01", to: "2026-06-30", data: [] })),
  fetchCloudUsageSummary: vi.fn(async () => ({ totals: { total_tokens: 0 }, rolling: null })),
  getUsageDaily: vi.fn(async () => ({ data: [] })),
  getUsageSummary: vi.fn(async () => ({ totals: {} })),
}));
vi.mock("../lib/auth-token", () => ({
  isAccessTokenReady: () => true,
  resolveAuthAccessToken: async (t: any) => t || "test-token",
}));
vi.mock("../lib/mock-data", () => ({ isMockEnabled: () => false }));

describe("useUsageData device scope", () => {
  beforeEach(() => {
    vi.mocked(fetchCloudUsageDaily).mockClear();
    vi.mocked(fetchCloudUsageSummary).mockClear();
    window.localStorage.clear();
  });

  it("forwards deviceId to the cloud daily fetcher", async () => {
    renderHook(() =>
      useUsageData({
        baseUrl: "https://app.tokentracker.cc",
        from: "2026-06-01",
        to: "2026-06-30",
        includeDaily: true,
        cacheKey: "u1",
        timeZone: "UTC",
        accountView: true,
        accountAccessToken: "jwt-token",
        deviceId: "dev-7",
      }),
    );
    await waitFor(() => expect(fetchCloudUsageDaily).toHaveBeenCalled());
    expect(vi.mocked(fetchCloudUsageDaily).mock.calls[0][0]).toMatchObject({ device: "dev-7" });
  });

  it("writes a device-scoped cache key (no collision with all-devices)", async () => {
    renderHook(() =>
      useUsageData({
        baseUrl: "https://app.tokentracker.cc",
        from: "2026-06-01", to: "2026-06-30", includeDaily: false,
        cacheKey: "u1", timeZone: "UTC",
        accountView: true, accountAccessToken: "jwt-token", deviceId: "dev-7",
      }),
    );
    await waitFor(() => expect(fetchCloudUsageSummary).toHaveBeenCalled());
    const keys = Object.keys(window.localStorage);
    expect(keys.some((k) => k.includes("dev-7"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/hooks/use-usage-data.device.test.tsx`
Expected: FAIL — fetcher called without `device`, no cache key contains `dev-7`.

- [ ] **Step 3: Implement `use-usage-data.ts`**

(a) Add `deviceId = null` to the destructured params (after `accountViewResolving = false`).

(b) Add a stable device scope token and put it in `storageKey` (line ~42-48):

```ts
  const deviceScope = deviceId || "all";
  const storageKey = (() => {
    if (!cacheKey) return null;
    const host = safeHost(baseUrl) || "default";
    const dailyKey = includeDaily ? "daily" : "summary";
    const tzKey = getTimeZoneCacheKey({ timeZone, offsetMinutes: tzOffsetMinutes });
    return `tokentracker.usage.${cacheKey}.${scopeKey}.${host}.${from}.${to}.${dailyKey}.${tzKey}.${deviceScope}`;
  })();
```

(c) In `refresh`, pass `device: deviceId` to BOTH fetcher calls (the `dailyFetcher(...)` and every `summaryFetcher(...)` call — there are three summary call sites: the `Promise.allSettled` one, the `else` branch, and the fallback). Each object gains one line, e.g.:

```ts
          dailyFetcher({
            baseUrl,
            accessToken: tokenForFetch,
            from,
            to,
            device: deviceId,
            timeZone,
            tzOffsetMinutes,
          }),
```

(d) Add `deviceId` to the `refresh` `useCallback` dependency array (the list ending at line ~266).

- [ ] **Step 4: Implement the other three hooks (same pattern)**

`use-usage-model-breakdown.ts`:
- Add `deviceId = null` param.
- `storageKey` (line ~35): append `.${deviceId || "all"}` to the returned template, and add `deviceId` to its `useMemo` dep array.
- `breakdownFetcher({ ... })` call: add `device: deviceId`.
- Add `deviceId` to the `refresh` dependency array.

`use-trend-data.ts`:
- Add `deviceId = null` param.
- `storageKey` (lines ~58-72): append `.${deviceId || "all"}` to ALL THREE returned templates (hourly, monthly, daily).
- In `refresh`, add `device: deviceId` to all three fetcher calls (`hourlyFetcher`, `monthlyFetcher`, `dailyFetcher`).
- Add `deviceId` to the `refresh` dependency array.

`use-activity-heatmap.ts`:
- Add `deviceId = null` param.
- `storageKey` (line ~49-53): append `.${deviceId || "all"}`, and add `deviceId` to its `useMemo` dep array.
- In `refresh`, add `device: deviceId` to BOTH the `heatmapFetcher(...)` and the fallback `dailyFetcher(...)` calls.
- Add `deviceId` to the `refresh` dependency array.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd dashboard && npx vitest run src/hooks/use-usage-data.device.test.tsx src/hooks/use-trend-data.test.tsx src/hooks/use-usage-data.account-resolving.test.tsx`
Expected: PASS (new device test + existing hook tests still green — regression check that the all-devices path is unchanged).

- [ ] **Step 6: Typecheck + commit**

```bash
cd dashboard && npx tsc --noEmit && cd ..
git add dashboard/src/hooks/use-usage-data.ts dashboard/src/hooks/use-usage-model-breakdown.ts dashboard/src/hooks/use-trend-data.ts dashboard/src/hooks/use-activity-heatmap.ts dashboard/src/hooks/use-usage-data.device.test.tsx
git commit -m "feat(dashboard): forward deviceId through usage hooks + cache scoping"
```

---

### Task 5: Dashboard — `useAccountDevices` hook

**Files:**
- Create: `dashboard/src/hooks/use-account-devices.ts`
- Test: `dashboard/src/hooks/use-account-devices.test.tsx` (create)

**Interfaces:**
- Consumes: `fetchAccountDevices` from `../lib/api`.
- Produces: `useAccountDevices({ from, to, timeZone, tzOffsetMinutes, accountView, accountAccessToken, accountRevision }) → { devices, loading, error }` where `devices: Array<{ id, device_name, platform, total_tokens }>`. Returns `[]` when not in account view.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/hooks/use-account-devices.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAccountDevices } from "../lib/api";
import { useAccountDevices } from "./use-account-devices";

vi.mock("../lib/api", () => ({ fetchAccountDevices: vi.fn() }));
vi.mock("../lib/auth-token", () => ({
  resolveAuthAccessToken: async (t: any) => t || "test-token",
}));

describe("useAccountDevices", () => {
  beforeEach(() => vi.mocked(fetchAccountDevices).mockReset());

  it("returns devices in account view", async () => {
    vi.mocked(fetchAccountDevices).mockResolvedValue({
      from: "2026-06-01", to: "2026-06-30",
      devices: [{ id: "d1", device_name: "MacBook", platform: "darwin", total_tokens: 10 }],
    });
    const { result } = renderHook(() =>
      useAccountDevices({
        from: "2026-06-01", to: "2026-06-30", timeZone: "UTC",
        accountView: true, accountAccessToken: "jwt",
      }),
    );
    await waitFor(() => expect(result.current.devices).toHaveLength(1));
    expect(result.current.devices[0]).toMatchObject({ id: "d1", device_name: "MacBook" });
  });

  it("returns empty and does not fetch outside account view", async () => {
    const { result } = renderHook(() =>
      useAccountDevices({ from: "2026-06-01", to: "2026-06-30", accountView: false, accountAccessToken: null }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.devices).toEqual([]);
    expect(fetchAccountDevices).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/hooks/use-account-devices.test.tsx`
Expected: FAIL — module `./use-account-devices` not found.

- [ ] **Step 3: Implement**

Create `dashboard/src/hooks/use-account-devices.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import { resolveAuthAccessToken } from "../lib/auth-token";
import { fetchAccountDevices } from "../lib/api";

/**
 * Lists the signed-in account's active devices with per-device usage totals
 * for [from, to]. Only fetches in account view (cross-device cloud reads);
 * outside it the dashboard is single-device and there is nothing to compare.
 */
export function useAccountDevices({
  from,
  to,
  timeZone,
  tzOffsetMinutes,
  accountView = false,
  accountAccessToken = null,
  accountRevision = 0,
}: any = {}) {
  const enabled = Boolean(accountView && accountAccessToken);
  const [devices, setDevices] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setDevices([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const token = await resolveAuthAccessToken(accountAccessToken);
      const res = await fetchAccountDevices({ from, to, timeZone, tzOffsetMinutes, accessToken: token });
      setDevices(Array.isArray(res?.devices) ? res.devices : []);
    } catch (e: any) {
      setError(e?.message || String(e));
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }, [enabled, accountAccessToken, from, to, timeZone, tzOffsetMinutes, accountRevision]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { devices, loading, error, refresh };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/hooks/use-account-devices.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd dashboard && npx tsc --noEmit && cd ..
git add dashboard/src/hooks/use-account-devices.ts dashboard/src/hooks/use-account-devices.test.tsx
git commit -m "feat(dashboard): add useAccountDevices hook"
```

---

### Task 6: Dashboard — copy strings for the device filter + card

**Files:**
- Modify: `dashboard/src/content/copy.csv`
- Modify: `dashboard/src/content/i18n/zh/dashboard.json`
- Modify: `dashboard/src/content/i18n/zh-TW/dashboard.json`
- Modify: `dashboard/src/content/i18n/ja/dashboard.json`
- Modify: `dashboard/src/content/i18n/ko/dashboard.json`

**Interfaces:**
- Produces copy keys consumed by Tasks 7 & 8: `dashboard.device_filter.all`, `dashboard.device_filter.aria`, `dashboard.device_card.title`, `dashboard.device_card.unnamed`.

- [ ] **Step 1: Add rows to `copy.csv`** (8 columns: `key,module,page,component,slot,text,notes,status`)

Append:

```csv
dashboard.device_filter.all,dashboard,DashboardPage,UsageOverview,option_all,"All devices",,active
dashboard.device_filter.aria,dashboard,DashboardPage,UsageOverview,select_aria,"Filter by device",,active
dashboard.device_card.title,dashboard,DashboardPage,DeviceUsageCard,title,"By device",,active
dashboard.device_card.unnamed,dashboard,DashboardPage,DeviceUsageCard,unnamed,"Unnamed device",,active
```

- [ ] **Step 2: Add translations to each i18n `dashboard.json`**

zh (`dashboard/src/content/i18n/zh/dashboard.json`):

```json
  "dashboard.device_filter.all": "全部设备",
  "dashboard.device_filter.aria": "按设备筛选",
  "dashboard.device_card.title": "按设备",
  "dashboard.device_card.unnamed": "未命名设备",
```

zh-TW:

```json
  "dashboard.device_filter.all": "全部裝置",
  "dashboard.device_filter.aria": "依裝置篩選",
  "dashboard.device_card.title": "依裝置",
  "dashboard.device_card.unnamed": "未命名裝置",
```

ja:

```json
  "dashboard.device_filter.all": "すべてのデバイス",
  "dashboard.device_filter.aria": "デバイスで絞り込む",
  "dashboard.device_card.title": "デバイス別",
  "dashboard.device_card.unnamed": "名称未設定のデバイス",
```

ko:

```json
  "dashboard.device_filter.all": "모든 기기",
  "dashboard.device_filter.aria": "기기별 필터",
  "dashboard.device_card.title": "기기별",
  "dashboard.device_card.unnamed": "이름 없는 기기",
```

(Insert each as new members of the existing JSON object; mind trailing commas.)

- [ ] **Step 3: Validate copy registry**

Run: `npm run validate:copy`
Expected: PASS (no missing translations for the new keys).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/content/copy.csv dashboard/src/content/i18n/*/dashboard.json
git commit -m "feat(dashboard): copy for device filter + per-device card"
```

---

### Task 7: Dashboard — device dropdown in `UsageOverview`

**Files:**
- Modify: `dashboard/src/ui/dashboard/components/UsageOverview.jsx`
- Test: `dashboard/src/ui/dashboard/components/UsageOverview.device.test.jsx` (create)

**Interfaces:**
- Consumes: `Select` from `../../components` (re-exported) or `../../components/Select` — confirm the export path; `Select` props are `{ value, onValueChange, options:[{value,label}], ariaLabel, matchTriggerWidth }`.
- Produces: `UsageOverview` accepts `deviceOptions = []`, `selectedDevice = ""`, `onDeviceChange`. Renders a device `Select` in the top-right actions row (before Share) only when `deviceOptions.length > 1`.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/ui/dashboard/components/UsageOverview.device.test.jsx`:

```jsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UsageOverview } from "./UsageOverview";

const baseProps = {
  period: "month", periods: ["day", "month"], onPeriodChange: () => {},
  summaryValue: "0", summaryLabel: "Total", fleetData: [],
  from: "2026-06-01", to: "2026-06-30",
};

describe("UsageOverview device dropdown", () => {
  it("renders the device select when 2+ devices and fires onDeviceChange", async () => {
    const onDeviceChange = vi.fn();
    render(
      <UsageOverview
        {...baseProps}
        deviceOptions={[
          { value: "", label: "All devices" },
          { value: "d1", label: "MacBook" },
          { value: "d2", label: "Mac mini" },
        ]}
        selectedDevice=""
        onDeviceChange={onDeviceChange}
      />,
    );
    const trigger = screen.getByLabelText("Filter by device");
    expect(trigger).toBeTruthy();
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByText("Mac mini"));
    expect(onDeviceChange).toHaveBeenCalledWith("d2");
  });

  it("hides the device select with fewer than 2 devices", () => {
    render(
      <UsageOverview {...baseProps} deviceOptions={[{ value: "", label: "All devices" }]} selectedDevice="" onDeviceChange={() => {}} />,
    );
    expect(screen.queryByLabelText("Filter by device")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/ui/dashboard/components/UsageOverview.device.test.jsx`
Expected: FAIL — no element labeled "Filter by device".

- [ ] **Step 3: Implement**

In `UsageOverview.jsx`:

(a) Add the import near the top (verify the path resolves; `Select` lives at `dashboard/src/ui/components/Select.jsx`):

```jsx
import { Select } from "../../components/Select.jsx";
```

(b) Add props to the destructure (after `to,`):

```jsx
  deviceOptions = [],
  selectedDevice = "",
  onDeviceChange,
```

(c) In the actions row (`<div className="flex items-center gap-1.5 shrink-0">`, ~line 269), insert the dropdown as the FIRST child, before the Share button:

```jsx
            {deviceOptions.length > 1 ? (
              <Select
                value={selectedDevice}
                onValueChange={onDeviceChange}
                options={deviceOptions}
                ariaLabel={copy("dashboard.device_filter.aria")}
                matchTriggerWidth
                className="h-8 px-2.5 text-xs"
              />
            ) : null}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/ui/dashboard/components/UsageOverview.device.test.jsx`
Expected: PASS. (If the base-ui Select portal makes `findByText` flaky in jsdom, assert `onDeviceChange` via the listbox role instead; the trigger-label assertion is the key gate.)

- [ ] **Step 5: Commit**

```bash
cd dashboard && npx tsc --noEmit && cd ..
git add dashboard/src/ui/dashboard/components/UsageOverview.jsx dashboard/src/ui/dashboard/components/UsageOverview.device.test.jsx
git commit -m "feat(dashboard): device dropdown in UsageOverview top bar"
```

---

### Task 8: Dashboard — `DeviceUsageCard` component

**Files:**
- Create: `dashboard/src/ui/dashboard/components/DeviceUsageCard.jsx`
- Test: `dashboard/src/ui/dashboard/components/DeviceUsageCard.test.jsx` (create)

**Interfaces:**
- Consumes: `Card` from `../../components`; `lucide-react` icons (`Laptop`, `Monitor`, `MonitorSmartphone`); `copy` from `../../../lib/copy`.
- Produces: `DeviceUsageCard({ devices, selectedDeviceId, onSelectDevice })` — renders a titled card listing each device with a platform icon, name, and percentage of summed `total_tokens`; clicking a row calls `onSelectDevice(id)` (or `onSelectDevice("")` when re-clicking the selected one to clear).

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/ui/dashboard/components/DeviceUsageCard.test.jsx`:

```jsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DeviceUsageCard } from "./DeviceUsageCard";

const devices = [
  { id: "d1", device_name: "MacBook Pro", platform: "darwin", total_tokens: 600 },
  { id: "d2", device_name: "Mac mini", platform: "darwin", total_tokens: 400 },
];

describe("DeviceUsageCard", () => {
  it("shows each device with its share of total tokens", () => {
    render(<DeviceUsageCard devices={devices} selectedDeviceId="" onSelectDevice={() => {}} />);
    expect(screen.getByText("MacBook Pro")).toBeTruthy();
    expect(screen.getByText("60.0%")).toBeTruthy();
    expect(screen.getByText("40.0%")).toBeTruthy();
  });

  it("selects a device on click and clears it when re-clicked", async () => {
    const onSelectDevice = vi.fn();
    const { rerender } = render(
      <DeviceUsageCard devices={devices} selectedDeviceId="" onSelectDevice={onSelectDevice} />,
    );
    await userEvent.click(screen.getByText("MacBook Pro"));
    expect(onSelectDevice).toHaveBeenCalledWith("d1");

    rerender(<DeviceUsageCard devices={devices} selectedDeviceId="d1" onSelectDevice={onSelectDevice} />);
    await userEvent.click(screen.getByText("MacBook Pro"));
    expect(onSelectDevice).toHaveBeenLastCalledWith("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/ui/dashboard/components/DeviceUsageCard.test.jsx`
Expected: FAIL — module `./DeviceUsageCard` not found.

- [ ] **Step 3: Implement**

Create `dashboard/src/ui/dashboard/components/DeviceUsageCard.jsx`:

```jsx
import React from "react";
import { Laptop, Monitor, MonitorSmartphone } from "lucide-react";
import { Card } from "../../components";
import { copy } from "../../../lib/copy";

// Platform → icon. device.platform comes from tokentracker_devices (e.g.
// "darwin", "win32"/"windows", "linux", "web"); fall back to a generic monitor.
function PlatformIcon({ platform, className }) {
  const p = String(platform || "").toLowerCase();
  if (p.includes("darwin") || p.includes("mac")) return <Laptop className={className} aria-hidden />;
  if (p.includes("win")) return <Monitor className={className} aria-hidden />;
  if (p.includes("linux")) return <Monitor className={className} aria-hidden />;
  return <MonitorSmartphone className={className} aria-hidden />;
}

export function DeviceUsageCard({ devices = [], selectedDeviceId = "", onSelectDevice }) {
  const total = devices.reduce((sum, d) => sum + (Number(d.total_tokens) || 0), 0);

  return (
    <Card>
      <div className="text-xs text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wider mb-3">
        {copy("dashboard.device_card.title")}
      </div>
      <div className="space-y-3">
        {devices.map((d) => {
          const tokens = Number(d.total_tokens) || 0;
          const percent = total > 0 ? ((tokens / total) * 100).toFixed(1) : "0.0";
          const isSelected = selectedDeviceId === d.id;
          const name = d.device_name || copy("dashboard.device_card.unnamed");
          return (
            <button
              key={d.id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelectDevice?.(isSelected ? "" : d.id)}
              className={`w-full text-left rounded-lg px-2 py-1.5 transition-colors ${
                isSelected
                  ? "bg-oai-gray-100 dark:bg-oai-gray-800"
                  : "hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/60"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <PlatformIcon platform={d.platform} className="h-3.5 w-3.5 shrink-0 text-oai-gray-500 dark:text-oai-gray-300" />
                <span className="flex-1 min-w-0 truncate text-sm text-oai-black dark:text-oai-white" title={name}>
                  {name}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-oai-black dark:text-oai-white">
                  {percent}%
                </span>
              </div>
              <div className="h-[3px] bg-oai-gray-100 dark:bg-oai-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-oai-brand transition-[width] duration-500 ease-out"
                  style={{ width: `${percent}%`, opacity: 0.55 }}
                />
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/ui/dashboard/components/DeviceUsageCard.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd dashboard && npx tsc --noEmit && cd ..
git add dashboard/src/ui/dashboard/components/DeviceUsageCard.jsx dashboard/src/ui/dashboard/components/DeviceUsageCard.test.jsx
git commit -m "feat(dashboard): DeviceUsageCard component"
```

---

### Task 9: Dashboard — wire device state through DashboardPage + DashboardView

**Files:**
- Modify: `dashboard/src/pages/DashboardPage.jsx`
- Modify: `dashboard/src/ui/dashboard/views/DashboardView.jsx`

**Interfaces:**
- Consumes: `useAccountDevices` (Task 5), `DeviceUsageCard` (Task 8), the `deviceId` hook params (Task 4), the `deviceOptions/selectedDevice/onDeviceChange` props on `UsageOverview` (Task 7).
- Produces: a `selectedDevice` state in `DashboardPage`, threaded into all four usage hooks and surfaced as the dropdown + the left-column card, gated on `accountView && devices.length >= 2`.

- [ ] **Step 1: DashboardPage — state, devices, gating**

In `dashboard/src/pages/DashboardPage.jsx`:

(a) Import the hook and the card near the other imports:

```jsx
import { useAccountDevices } from "../hooks/use-account-devices.js";
import { DeviceUsageCard } from "../ui/dashboard/components/DeviceUsageCard.jsx";
```

(b) After `from`/`to` are computed (~line 404), add device state + data:

```jsx
  const [selectedDevice, setSelectedDevice] = useState(null);
  const { devices: accountDevices } = useAccountDevices({
    from,
    to,
    timeZone,
    tzOffsetMinutes,
    accountView,
    accountAccessToken,
    accountRevision,
  });
  // Device filter is meaningful only across 2+ devices in account view.
  const showDeviceFilter = accountView && accountDevices.length >= 2;
  // Reset the filter when leaving account view, or when the selected device
  // disappears (revoked / not in the latest list).
  useEffect(() => {
    if (!showDeviceFilter) {
      if (selectedDevice !== null) setSelectedDevice(null);
      return;
    }
    if (selectedDevice && !accountDevices.some((d) => d.id === selectedDevice)) {
      setSelectedDevice(null);
    }
  }, [showDeviceFilter, accountDevices, selectedDevice]);

  const deviceOptions = useMemo(() => {
    if (!showDeviceFilter) return [];
    return [
      { value: "", label: copy("dashboard.device_filter.all") },
      ...accountDevices.map((d) => ({
        value: d.id,
        label: d.device_name || copy("dashboard.device_card.unnamed"),
      })),
    ];
  }, [showDeviceFilter, accountDevices, resolvedLocale]);

  const deviceUsageBlock = showDeviceFilter ? (
    <DeviceUsageCard
      devices={accountDevices}
      selectedDeviceId={selectedDevice || ""}
      onSelectDevice={(id) => setSelectedDevice(id || null)}
    />
  ) : null;
```

(c) Pass `deviceId: selectedDevice` into the four account-scoped usage hooks: `useUsageData` (the MAIN instance at ~line 446 — leave the `daily-breakdown` instance unfiltered so the always-30-day table stays whole), `useUsageModelBreakdown`, `useTrendData`, `useActivityHeatmap`. Add this one line to each hook's config object:

```jsx
    deviceId: selectedDevice,
```

(d) In the `<DashboardView ... />` props, add:

```jsx
      deviceOptions={deviceOptions}
      selectedDevice={selectedDevice || ""}
      onDeviceChange={(v) => setSelectedDevice(v || null)}
      deviceUsageBlock={deviceUsageBlock}
```

- [ ] **Step 2: DashboardView — pass dropdown props down + render the card**

In `dashboard/src/ui/dashboard/views/DashboardView.jsx`:

(a) Destructure the new props (in the big `const { ... } = props;` block):

```jsx
    deviceOptions,
    selectedDevice,
    onDeviceChange,
    deviceUsageBlock,
```

(b) Pass the dropdown props to `<UsageOverview ... />` (add three lines among its props):

```jsx
                    deviceOptions={deviceOptions}
                    selectedDevice={selectedDevice}
                    onDeviceChange={onDeviceChange}
```

(c) Render the card in the LEFT column, right after the `StatsPanel` `</FadeIn>` (~line 262):

```jsx
                {deviceUsageBlock ? (
                  <FadeIn delay={nextLeft()}>
                    {deviceUsageBlock}
                  </FadeIn>
                ) : null}
```

- [ ] **Step 3: Typecheck + verify existing tests still pass**

Run: `cd dashboard && npx tsc --noEmit && npx vitest run`
Expected: PASS (whole dashboard suite, including the new tests from Tasks 3–8).

- [ ] **Step 4: Manual verification (no automated DashboardPage test exists)**

Run the real backend so cloud reads work:

```bash
node bin/tracker.js serve --no-sync
```

Open `http://localhost:7680`, sign in, enable Cloud sync (Settings → Account). With 2+ devices on the account, verify:
1. A "设备 ▾ / All devices" dropdown appears in the top-right of the usage panel; a "By device / 按设备" card appears in the left column.
2. Selecting a device (via dropdown OR by clicking a card row) filters the big total, cost, daily details, trend, and heatmap to that device; the dropdown and card stay in sync.
3. Re-clicking the selected card row, or choosing "All devices", restores the aggregate.
4. Switching time tabs (日/周/月/总计/自定义) re-queries within the selected device (time × device crossing).
5. Sign out / disable cloud sync → both controls disappear; local view unchanged.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/pages/DashboardPage.jsx dashboard/src/ui/dashboard/views/DashboardView.jsx
git commit -m "feat(dashboard): wire device filter (dropdown + card) into dashboard"
```

---

### Task 10: Full validation + release prep

**Files:**
- Modify (version bump, only if releasing): `package.json`, `TokenTrackerBar/project.yml` (two `MARKETING_VERSION`), `TokenTrackerWin/TokenTrackerWin.csproj` `<Version>`.

- [ ] **Step 1: Run the full local CI gate**

Run: `npm run ci:local`
Expected: PASS — runs `npm test` (incl. `account-device-filter` + `edge-pricing-parity`), `validate:copy`, `validate:ui-hardcode`, `validate:guardrails`, architecture guardrails, and `dashboard` build.

- [ ] **Step 2: Run the dashboard unit suite**

Run: `cd dashboard && npx vitest run && npx tsc --noEmit && cd ..`
Expected: PASS.

- [ ] **Step 3: Deploy the touched edge functions**

Deploy the 6 modified `account-*` endpoints **and** the new `tokentracker-account-devices` to InsForge. (The dashboard fetches devices + filtered usage directly from InsForge; without deploy the new endpoint 404s and the card stays empty.)

- [ ] **Step 4: Release decision (ask the user — do not auto-release)**

This change touches `dashboard/`, so per CLAUDE.md it ships npm + DMG + Windows (the desktop apps bundle the built dashboard). If the user says "release", bump all four version locations in lockstep, commit, push, and trigger the release workflow. Otherwise stop here.

- [ ] **Step 5: Final commit (if version bumped)**

```bash
git add package.json TokenTrackerBar/project.yml TokenTrackerWin/TokenTrackerWin.csproj
git commit -m "chore: bump version for per-device usage breakdown"
```

---

## Self-Review Notes

- **Spec coverage:** §6.1 → Task 1; §6.2 → Task 2; §6.3 → Task 3; §6.4 → Task 4; new devices hook (§6.4) → Task 5; §6.6 copy → Task 6; UX dropdown (§4) → Task 7; per-device card (§4) → Task 8; wiring + account-view gating + single-device hide (§4, §10) → Task 9; testing/deploy/release (§8, §9) → Task 10.
- **Security (§6.1):** the `includes(requestedDeviceId)` guard is asserted by `test/account-device-filter.test.js`.
- **Cache scoping (§10):** `deviceId` added to every usage hook `storageKey`; asserted by `use-usage-data.device.test.tsx`.
- **Default-unchanged (§3):** all `device`/`deviceId` params default to empty/null and are dropped by `buildFilterParams`; existing hook tests re-run in Task 4 Step 5 as the regression gate.
- **Pricing parity:** no `MODEL_PRICING` block is edited; `edge-pricing-parity.test.js` re-run in Task 1 Step 5.
- **Project usage** (`useProjectUsageSummary`) and the **daily-breakdown** `useUsageData` instance are intentionally NOT device-filtered (project rollups aren't device-scoped; the 30-day breakdown table is a fixed whole-account view). Noted so a reviewer doesn't read it as a gap.
