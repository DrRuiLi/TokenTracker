// Client for the trcc-token-dash control API (Python side-screen pusher).
// It listens on 127.0.0.1 only and accepts loopback origins, so this works
// from the local dashboard (WebView2 / http://127.0.0.1:<port>) but not from
// the hosted web build.

export const TRCC_DEFAULT_PORT = 17691;
const PORT_KEY = "tt.trcc.port";
const TIMEOUT_MS = 4000;

export function isValidTrccPort(v) {
  return Number.isInteger(v) && v >= 1024 && v <= 65535;
}

export function readTrccPort() {
  try {
    const v = Number.parseInt(window.localStorage.getItem(PORT_KEY) || "", 10);
    if (isValidTrccPort(v)) return v;
  } catch {
    // storage blocked: fall through to default
  }
  return TRCC_DEFAULT_PORT;
}

export function saveTrccPort(port) {
  try {
    window.localStorage.setItem(PORT_KEY, String(port));
  } catch {
    // ignore
  }
}

export function trccBase(port) {
  return `http://127.0.0.1:${port}`;
}

export function trccPreviewUrl(port, seq) {
  return `${trccBase(port)}/api/preview.png?seq=${encodeURIComponent(seq ?? 0)}`;
}

export class TrccApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(port, path, body) {
  let res;
  try {
    res = await fetch(`${trccBase(port)}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new TrccApiError("unreachable", 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON error body
  }
  if (!res.ok) throw new TrccApiError(data?.error || `HTTP ${res.status}`, res.status);
  return data;
}

export const trccApi = {
  state: (port) => request(port, "/api/state"),
  updateSettings: (port, patch) => request(port, "/api/settings", patch),
  reset: (port) => request(port, "/api/settings/reset", {}),
  setPushing: (port, on) => request(port, "/api/push", { on }),
  refreshCursor: (port) => request(port, "/api/cursor/refresh", {}),
  showWindow: (port) => request(port, "/api/window/show", {}),
  relaunchAdmin: (port) => request(port, "/api/admin/relaunch", {}),
};
