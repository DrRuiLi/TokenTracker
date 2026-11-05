import { getLocalApiAuthHeaders } from "./local-api-auth";

export const GROK_LOGIN_PATH = "/api/grok-x-login";

async function payload(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

async function authed(method, body) {
  const auth = await getLocalApiAuthHeaders();
  const init = {
    method,
    headers: { Accept: "application/json", ...auth },
    cache: "no-store",
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return payload(await fetch(GROK_LOGIN_PATH, init));
}

export function fetchGrokLoginStatus() {
  return authed("GET");
}

export function openGrokLoginWindow() {
  return authed("POST");
}

export function setGrokBillingRefreshInterval(refreshIntervalSeconds) {
  return authed("PUT", { refreshIntervalSeconds });
}
