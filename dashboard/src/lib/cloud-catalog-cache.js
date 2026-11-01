import { getInsforgeInstanceFingerprint } from "./insforge-config";
import { readCloudPromptState } from "./cloud-prompt-policy.js";

export const CLOUD_CATALOG_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function storageKey(fingerprint = getInsforgeInstanceFingerprint()) {
  return `tt.cloud.catalog.${encodeURIComponent(fingerprint || "unconfigured")}`;
}

function usableCatalog(catalog) {
  return Boolean(catalog && typeof catalog === "object" && Array.isArray(catalog.prices) && catalog.prices.length > 0);
}

function freshAt(at, now) {
  return Number.isFinite(at) && now >= at && now - at <= CLOUD_CATALOG_CACHE_MAX_AGE_MS;
}

export function readCloudCatalogCache(now = Date.now(), fingerprint = getInsforgeInstanceFingerprint()) {
  try {
    const raw = sessionStorage.getItem(storageKey(fingerprint));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!usableCatalog(parsed?.catalog) || !freshAt(parsed?.at, now)) return null;
    return parsed.catalog;
  } catch {
    return null;
  }
}

export function writeCloudCatalogCache(catalog, now = Date.now(), fingerprint = getInsforgeInstanceFingerprint()) {
  if (!usableCatalog(catalog)) return;
  try {
    sessionStorage.setItem(storageKey(fingerprint), JSON.stringify({ at: now, catalog }));
  } catch {
    /* quota / private mode */
  }
}

export function clearCloudCatalogCache(fingerprint = getInsforgeInstanceFingerprint()) {
  try { sessionStorage.removeItem(storageKey(fingerprint)); } catch { /* ignore */ }
}

/** Prefer session cache, then same-tab in-memory catalog from billing responses. */
export function seedCloudCatalog(now = Date.now()) {
  const session = readCloudCatalogCache(now);
  if (session) return session;
  try {
    const state = readCloudPromptState(null);
    if (!usableCatalog(state?.catalog) || !freshAt(state?.catalogObservedAt, now)) return null;
    return state.catalog;
  } catch {
    return null;
  }
}
