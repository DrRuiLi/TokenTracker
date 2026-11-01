"use strict";

/**
 * Optional Sentry error reporting for the Node CLI / EmbeddedServer runtime.
 *
 * Privacy contract (keep in sync with docs/PRIVACY.md and dashboard/src/lib/sentry.js):
 * - Off unless TOKENTRACKER_SENTRY_DSN (or SENTRY_DSN) is set.
 * - Honors the same telemetry opt-out as the daily heartbeat
 *   (TOKENTRACKER_NO_TELEMETRY / DO_NOT_TRACK / config.json `"telemetry": false`).
 * - Fail-closed in the node test runner.
 * - Never intended to carry prompts, code, or provider secrets; beforeSend
 *   scrubs common secret patterns from event payloads.
 */

const path = require("node:path");
const pkg = require("../../package.json");
const { readJson } = require("./fs");
const { isTelemetryDisabled } = require("./telemetry");

const SECRET_PATTERN =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|secret|password|dsn)[=:\s]+["']?[^\s"'\\]{8,}/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g;

let initialized = false;

function resolveDsn(env = process.env) {
  const raw = env?.TOKENTRACKER_SENTRY_DSN || env?.SENTRY_DSN || "";
  return typeof raw === "string" ? raw.trim() : "";
}

function resolveEnvironment(env = process.env) {
  const raw = typeof env?.TOKENTRACKER_SENTRY_ENVIRONMENT === "string"
    ? env.TOKENTRACKER_SENTRY_ENVIRONMENT.trim()
    : "";
  if (raw) return raw;
  if (env?.NODE_ENV === "production") return "production";
  return "development";
}

function resolveShell(env = process.env) {
  const raw = typeof env?.TOKENTRACKER_APP_SHELL === "string"
    ? env.TOKENTRACKER_APP_SHELL.trim().toLowerCase()
    : "";
  if (raw === "macos" || raw === "windows" || raw === "linux" || raw === "cli") return raw;
  return "cli";
}

function scrubString(value) {
  if (typeof value !== "string" || !value) return value;
  return value
    .replace(BEARER_PATTERN, "Bearer [Filtered]")
    .replace(JWT_PATTERN, "[Filtered]")
    .replace(SECRET_PATTERN, "[Filtered]");
}

function scrubValue(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("authorization") ||
        lower.includes("cookie") ||
        lower.includes("password") ||
        lower.includes("secret") ||
        lower.includes("token") ||
        lower.includes("api_key") ||
        lower.includes("apikey")
      ) {
        out[key] = "[Filtered]";
      } else {
        out[key] = scrubValue(nested, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function truncateMaybe(value, max = 240) {
  if (typeof value !== "string") return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated]`;
}

function scrubEvent(event) {
  if (!event || typeof event !== "object") return event;
  const next = { ...event };
  if (next.message) next.message = truncateMaybe(scrubString(next.message));
  if (next.extra) next.extra = scrubValue(next.extra);
  if (next.contexts) next.contexts = scrubValue(next.contexts);
  if (next.request) next.request = scrubValue(next.request);
  // Console breadcrumbs can carry parser / JSON.parse excerpts of local logs
  // (prompt text). Drop them entirely; keep only non-console crumbs and scrub.
  if (Array.isArray(next.breadcrumbs)) {
    next.breadcrumbs = next.breadcrumbs
      .filter((crumb) => crumb && crumb.category !== "console")
      .map((crumb) => scrubValue(crumb));
  }
  if (next.exception?.values) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((item) => ({
        ...item,
        value: truncateMaybe(scrubString(item?.value)),
      })),
    };
  }
  // Never attach IP / user PII by default.
  if (next.user) {
    next.user = { id: typeof next.user.id === "string" ? next.user.id : undefined };
  }
  return next;
}

/**
 * Initialise Sentry once for this process. Never throws.
 * @returns {Promise<{ enabled: boolean, reason?: string }>}
 */
async function initSentry({
  env = process.env,
  trackerDir,
  version = pkg.version,
} = {}) {
  try {
    if (initialized) return { enabled: true, reason: "already-initialized" };
    if (env?.NODE_TEST_CONTEXT !== undefined) {
      return { enabled: false, reason: "test-env" };
    }

    const dsn = resolveDsn(env);
    if (!dsn) return { enabled: false, reason: "no-dsn" };

    let config = {};
    if (trackerDir) {
      config = (await readJson(path.join(trackerDir, "config.json"))) || {};
    }
    if (isTelemetryDisabled({ env, config })) {
      return { enabled: false, reason: "opt-out" };
    }

    // Honor the same outbound proxy / fail-closed policy as the rest of the CLI.
    // Sentry's Node transport uses node:https (not undici), so pass proxy explicitly.
    const {
      readPersistedProxyConfig,
      resolveEffectiveProxySource,
    } = require("./proxy-env");
    const proxyConfig = readPersistedProxyConfig();
    const proxyResolved = resolveEffectiveProxySource({ env, proxyConfig });
    if (proxyResolved?.source === "blocked") {
      return { enabled: false, reason: "proxy-blocked" };
    }

    // Lazy require keeps unit tests that never call init from paying the
    // module graph cost at import time of unrelated modules.
    const Sentry = require("@sentry/node");
    Sentry.init({
      dsn,
      environment: resolveEnvironment(env),
      release: `tokentracker@${String(version || "").trim() || "0.0.0"}`,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      // Errors only: drop process-session + console; replace Http so request
      // sessions stay off (Http defaults sessions:true and bypasses beforeSend).
      integrations(defaults) {
        const filtered = defaults.filter((integration) => {
          const name = integration?.name || "";
          return name !== "ProcessSession" && name !== "Console" && name !== "Http";
        });
        filtered.push(Sentry.httpIntegration({ sessions: false }));
        return filtered;
      },
      transportOptions: proxyResolved?.proxyUrl
        ? { proxy: proxyResolved.proxyUrl }
        : undefined,
      beforeSend(event) {
        return scrubEvent(event);
      },
      initialScope: {
        tags: {
          shell: resolveShell(env),
          runtime: "node",
        },
      },
    });
    initialized = true;
    return { enabled: true };
  } catch {
    return { enabled: false, reason: "init-failed" };
  }
}

function captureException(error, context) {
  if (!initialized) return;
  try {
    const Sentry = require("@sentry/node");
    if (context) {
      Sentry.withScope((scope) => {
        if (context.tags) {
          for (const [key, value] of Object.entries(context.tags)) {
            scope.setTag(key, String(value));
          }
        }
        if (context.extra) scope.setExtras(scrubValue(context.extra));
        Sentry.captureException(error);
      });
      return;
    }
    Sentry.captureException(error);
  } catch {
    /* never break the CLI */
  }
}

module.exports = {
  initSentry,
  captureException,
  resolveDsn,
  resolveEnvironment,
  resolveShell,
  scrubEvent,
  scrubString,
  // test helpers
  _resetForTests() {
    initialized = false;
  },
};
