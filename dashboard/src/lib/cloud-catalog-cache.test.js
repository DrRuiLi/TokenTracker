import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCloudCatalogCache,
  CLOUD_CATALOG_CACHE_MAX_AGE_MS,
  readCloudCatalogCache,
  seedCloudCatalog,
  writeCloudCatalogCache,
} from "./cloud-catalog-cache.js";
import { clearCloudPromptBackendState, publishCloudPromptBilling } from "./cloud-prompt-policy.js";
import { getInsforgeInstanceFingerprint } from "./insforge-config";

const anonKey = `${btoa('{"alg":"HS256"}').replace(/=+$/, "")}.${btoa('{"role":"anon"}').replace(/=+$/, "")}.signature`;
const catalog = {
  environment: "live",
  policy: { phase: "active", launch_at: "2000-01-01", hosting_mode: "hosted" },
  prices: [{ sku: "cloud_usd_yearly", currency: "USD", amount_cents: 3999, term_months: 12, billing_mode: "recurring" }],
  providers: { waffo: true },
};

function setInstance(baseUrl) {
  window.__TOKENTRACKER_RUNTIME_CONFIG__ = { baseUrl, anonKey };
}

beforeEach(() => {
  sessionStorage.clear();
  clearCloudPromptBackendState();
  setInstance("https://cache-a.example");
});
afterEach(() => {
  sessionStorage.clear();
  clearCloudPromptBackendState();
  delete window.__TOKENTRACKER_RUNTIME_CONFIG__;
});

describe("cloud catalog cache", () => {
  it("round-trips a priced catalog under a configured instance key", () => {
    const fingerprint = getInsforgeInstanceFingerprint();
    expect(fingerprint).toBeTruthy();
    expect(fingerprint).not.toBe("unconfigured");
    writeCloudCatalogCache(catalog, 1_000);
    expect(readCloudCatalogCache(1_000)).toEqual(catalog);
    expect(sessionStorage.getItem(`tt.cloud.catalog.${encodeURIComponent(fingerprint)}`)).toBeTruthy();
  });

  it("keeps A and B instance caches separate", () => {
    writeCloudCatalogCache(catalog, 1_000);
    setInstance("https://cache-b.example");
    expect(readCloudCatalogCache(1_000)).toBeNull();
    const other = { ...catalog, prices: [{ ...catalog.prices[0], amount_cents: 1111 }] };
    writeCloudCatalogCache(other, 1_000);
    expect(readCloudCatalogCache(1_000)).toEqual(other);
    setInstance("https://cache-a.example");
    expect(readCloudCatalogCache(1_000)).toEqual(catalog);
  });

  it("ignores empty or expired caches", () => {
    writeCloudCatalogCache({ ...catalog, prices: [] }, 1_000);
    expect(readCloudCatalogCache(1_000)).toBeNull();
    writeCloudCatalogCache(catalog, 1_000);
    expect(readCloudCatalogCache(1_000 + CLOUD_CATALOG_CACHE_MAX_AGE_MS + 1)).toBeNull();
  });

  it("prefers session cache, then fresh in-memory billing catalog", () => {
    publishCloudPromptBilling("catalog", catalog, null, 2_000);
    expect(seedCloudCatalog(2_000)).toEqual(catalog);
    const sessionOnly = { ...catalog, prices: [{ ...catalog.prices[0], amount_cents: 1111 }] };
    writeCloudCatalogCache(sessionOnly, 2_000);
    expect(seedCloudCatalog(2_000)).toEqual(sessionOnly);
    clearCloudCatalogCache();
    expect(seedCloudCatalog(2_000)).toEqual(catalog);
  });

  it("does not resurrect an expired in-memory catalog", () => {
    publishCloudPromptBilling("catalog", catalog, null, 1_000);
    expect(seedCloudCatalog(1_000 + CLOUD_CATALOG_CACHE_MAX_AGE_MS + 1)).toBeNull();
  });
});
