import { createClient } from "npm:@insforge/sdk";
import { billingUserId } from "./cloud/auth.ts";
import { cloudEnvironment } from "./cloud/access.ts";
import { BillingError, object, uuid } from "./cloud/contracts.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Cache-Control": "no-store",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: cors });
}

function identifier(value: unknown): string {
  try { return uuid(value).toLowerCase(); }
  catch { throw new BillingError("cloud_usage_reset_invalid_request", 400); }
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, code: "method_not_allowed", status: 405 }, 405);
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 4096) {
      return json({ ok: false, code: "cloud_usage_reset_invalid_request", status: 413 }, 413);
    }
    let body: Record<string, unknown>;
    try { body = object(JSON.parse(raw)); }
    catch { throw new BillingError("cloud_usage_reset_invalid_request", 400); }
    const operationId = identifier(body.operation_id);
    const environment = cloudEnvironment();
    let name: string;
    let deviceId: string | undefined;
    let args: Record<string, unknown>;
    if (body.action === "reset") {
      const userId = await billingUserId(req.headers.get("Authorization"), {
        jwtSecret: Deno.env.get("JWT_SECRET"), jwtPublicKey: Deno.env.get("JWT_PUBLIC_KEY"),
      });
      name = "cloud_reset_device_usage";
      deviceId = identifier(body.device_id);
      args = { p_user_id: userId, p_device_id: deviceId, p_operation_id: operationId };
    } else if (body.action === "refresh") {
      const header = req.headers.get("Authorization");
      const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token || token.length > 2048 || token.includes(".")) {
        throw new BillingError("cloud_device_token_rejected", 401);
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      name = "cloud_refresh_device_usage";
      args = { p_token_hash: hash, p_operation_id: operationId };
    } else {
      throw new BillingError("cloud_usage_reset_invalid_request", 400);
    }
    const baseUrl = Deno.env.get("INSFORGE_BASE_URL");
    const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
    if (!baseUrl || !serviceRoleKey) throw new Error("Cloud reset configuration unavailable");
    const client = createClient({ baseUrl, edgeFunctionToken: serviceRoleKey,
      anonKey: Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY"), isServerMode: true });
    const { data, error } = await client.database.rpc(name, { ...args, p_environment: environment });
    if (error || !data || typeof data !== "object" || typeof data.ok !== "boolean") {
      throw new Error("Cloud reset RPC unavailable");
    }
    if (!data.ok) {
      const status = Number.isInteger(data.status) && data.status >= 400 && data.status < 600 ? data.status : 503;
      return json(data, status);
    }
    if (data.operation_id !== operationId || !["reset", "complete"].includes(data.status)
      || !Number.isSafeInteger(data.removed_rows) || data.removed_rows < 0
      || body.action === "refresh" && data.status !== "complete"
      || deviceId && data.device_id !== deviceId) {
      throw new Error("Invalid Cloud reset response");
    }
    try { uuid(data.device_id); uuid(data.machine_id); }
    catch { throw new Error("Invalid Cloud reset response"); }
    return json(data);
  } catch (error) {
    const code = error instanceof BillingError ? error.code : "cloud_usage_reset_unavailable";
    const status = error instanceof BillingError ? error.status : 503;
    return json({ ok: false, code, status }, status);
  }
}
