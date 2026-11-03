const fssync = require("node:fs");
const path = require("node:path");
const { readSqliteJsonRowsAsync } = require("./sqlite-reader");
const {
  discoverOpencodeDbPaths,
  resolveOpencodeDataDir,
} = require("./opencode-go-limits");

// Mimo (Xiaomi) Token Plan quota row for the Limits page.
//
// Xiaomi does not expose a quota/credits endpoint to API keys: the gateway
// answers 404 for /v1/credits and friends, and the platform console only
// accepts cookie sessions (401 + loginUrl for every API key probe). So this
// provider is a LOCAL ESTIMATE in the opencode-go mold: it sums the token
// usage recorded in the local `opencode.db` for the xiaomi-token-plan-*
// providers and compares it against the plan's monthly token allowance.
//
// The estimate cannot prove the subscription is still active — the database
// holds historical turns but no entitlement state — so the row only renders
// as configured when the user's opencode auth.json still lists a
// xiaomi-token-plan-* key (key NAMES only; values are never read) or an
// explicit plan override is configured via env.
//
// Sources of truth for the numbers, all overridable:
//   TOKENTRACKER_MIMO_PLAN_TOKENS     total tokens per cycle (default 100,000,000)
//   TOKENTRACKER_MIMO_PLAN_RESET_DAY  reset day of month, 1-31 (default 1)
//   TOKENTRACKER_MIMO_PROVIDERS       comma list of opencode provider ids
//                                     (default the three regional token-plan ids)
//   TOKENTRACKER_MIMO_PLAN_LABEL      window label (default "Token Plan")
//   TOKENTRACKER_MIMO_DISABLE         truthy → row reports not configured

const MIMO_PLAN_DEFAULT_TOKENS = 100_000_000;
const MIMO_PLAN_DEFAULT_RESET_DAY = 1;
const MIMO_PLAN_DEFAULT_LABEL = "Token Plan";
// The three regional Xiaomi Token Plan gateways opencode can be pointed at
// (mirrors of the provider directory inside the mimocode CLI binary).
const MIMO_PLAN_DEFAULT_PROVIDERS = [
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
];

const TOKEN_SUM_FIELDS = [
  "$.tokens.input",
  "$.tokens.output",
  "$.tokens.reasoning",
  "$.tokens.cache.read",
  "$.tokens.cache.write",
];

function isTruthyEnvValue(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function parseMimoPlanTokens(env = process.env) {
  const raw = Number.parseInt(String(env.TOKENTRACKER_MIMO_PLAN_TOKENS ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : MIMO_PLAN_DEFAULT_TOKENS;
}

function parseMimoPlanResetDay(env = process.env) {
  const raw = Number.parseInt(String(env.TOKENTRACKER_MIMO_PLAN_RESET_DAY ?? "").trim(), 10);
  return Number.isFinite(raw) && raw >= 1 && raw <= 31 ? raw : MIMO_PLAN_DEFAULT_RESET_DAY;
}

function parseMimoPlanProviders(env = process.env) {
  const raw = String(env.TOKENTRACKER_MIMO_PROVIDERS ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return raw.length > 0 ? raw : [...MIMO_PLAN_DEFAULT_PROVIDERS];
}

function isMimoPlanProviderId(id, env = process.env) {
  return parseMimoPlanProviders(env).includes(id);
}

function parseMimoPlanLabel(env = process.env) {
  const raw = String(env.TOKENTRACKER_MIMO_PLAN_LABEL ?? "").trim();
  return raw || MIMO_PLAN_DEFAULT_LABEL;
}

// Monthly cycle boundaries in the LOCAL timezone — the reset day is a calendar
// day (subscription anniversary style), not a UTC anchor. Before the reset day
// the current cycle started last month; on/after it, this month.
function computeMimoPlanPeriod(nowMs, resetDay) {
  const now = new Date(nowMs);
  const year = now.getFullYear();
  const month = now.getMonth();
  // Clamp: Feb 31 would otherwise roll into March and break the "same day
  // next month" end calculation.
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const day = Math.min(Math.max(resetDay, 1), daysInMonth);
  const start = now.getDate() >= day
    ? new Date(year, month, day)
    : new Date(year, month - 1, day);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate());
  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
    resetMs: end.getTime(),
  };
}

// Read the provider KEY NAMES from opencode's auth.json. The values are API
// key credentials: only Object.keys() is touched, and no value is ever
// returned, logged, or thrown. Missing/malformed file → no configured keys.
function readMimoPlanAuthKeyNames({ home, env = process.env, providers = parseMimoPlanProviders(env) }) {
  const dataDir = resolveOpencodeDataDir({ home, env });
  if (!dataDir) return { authPath: null, keyNames: [] };
  const authPath = path.join(dataDir, "auth.json");
  try {
    const parsed = JSON.parse(fssync.readFileSync(authPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { authPath, keyNames: [] };
    }
    const keyNames = Object.keys(parsed).filter((key) => providers.includes(key));
    return { authPath, keyNames };
  } catch (_e) {
    return { authPath, keyNames: [] };
  }
}

// Token sum for the plan window, in one SQLite aggregate (the message table
// has no index on the JSON fields — summing in SQL keeps the limits poll
// cheap). Two schema generations share the file (see src/lib/rollout.js):
//   v1: `message`, flat `$.providerID`, role in `$.role`.
//   v2: `session_message`, nested `$.model.providerID`, role in `type`.
// The token fields are the five-field cost basis (normalizeOpencodeTokens):
// input + output + reasoning + cache.read + cache.write.
function buildMimoAggregateSql({ startMs, endMs }, providers, variant = "v1") {
  const isV2 = variant === "v2";
  const table = isV2 ? "session_message" : "message";
  const rolePredicate = isV2 ? "type = 'assistant'" : "json_extract(data,'$.role') = 'assistant'";
  const providerExpr = isV2
    ? "json_extract(data,'$.model.providerID')"
    : "json_extract(data,'$.providerID')";
  const providerList = providers.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(", ");
  const tokenExpr = TOKEN_SUM_FIELDS.map(
    (field) => `COALESCE(json_extract(data,'${field}'),0)`,
  ).join(" + ");
  return (
    "SELECT " +
    `COALESCE(SUM(CASE WHEN createdMs >= ${startMs} AND createdMs < ${endMs} THEN tokens ELSE 0 END), 0) AS periodTokens, ` +
    "COUNT(*) AS rowCount " +
    "FROM (" +
    "SELECT CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) AS createdMs, " +
    `(${tokenExpr}) AS tokens ` +
    `FROM ${table} ` +
    "WHERE json_valid(data) " +
    `AND ${providerExpr} IN (${providerList}) ` +
    `AND ${rolePredicate}` +
    ")"
  );
}

// Shared opencode2 probe (see src/lib/opencode-go-limits.js): a pure v1
// database has an empty session_message table, so the probe result drives
// variant ordering. A database carrying BOTH tables resolves to "v1 first"
// on purpose — the aggregate is a blind SUM with no dedup key, so unioning
// the two generations could double-count; undercounting is the safe side.
async function detectMimoHasSessionMessages(dbPath, sqliteOptions = {}) {
  let rows;
  try {
    rows = await readSqliteJsonRowsAsync(
      dbPath,
      `SELECT (SELECT 1 FROM session_message LIMIT 1) AS hasRows`,
      { label: "Mimo", timeout: 5_000, ...sqliteOptions },
    );
  } catch (_e) {
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return Boolean(rows[0]?.hasRows);
}

// Sum plan-window tokens across every discoverable opencode.db. Returns
// { periodTokens, rowCount, error } — error is the first read failure (the
// row still renders; the panel shows the error only when nothing could be
// read), and rowCount 0 with no error means "no mimo turns in this cycle".
async function collectMimoLocal({
  home,
  env = process.env,
  nowMs = Date.now(),
  sqliteOptions = {},
  providers,
  period,
} = {}) {
  const paths = discoverOpencodeDbPaths({ home, env });
  let periodTokens = 0;
  let rowCount = 0;
  let firstError = null;

  for (const dbPath of paths) {
    const hasRows = await detectMimoHasSessionMessages(dbPath, sqliteOptions);
    const variants = hasRows === true ? ["v2", "v1"] : ["v1", "v2"];
    for (const variant of variants) {
      const sql = buildMimoAggregateSql(period, providers, variant);
      let rows;
      try {
        rows = await readSqliteJsonRowsAsync(dbPath, sql, {
          label: "Mimo",
          timeout: 5_000,
          ...sqliteOptions,
          throwOnReadFailure: true,
        });
      } catch (err) {
        if (!firstError) firstError = err;
        continue;
      }
      const row = rows && rows[0];
      if (!row) continue;
      const rowsFound = Number(row.rowCount) || 0;
      if (rowsFound <= 0) continue;
      periodTokens += Number(row.periodTokens) || 0;
      rowCount += rowsFound;
      break; // this database answered — don't re-run the other schema on it
    }
  }

  return {
    periodTokens,
    rowCount,
    error: firstError ? String(firstError.message || firstError) : null,
  };
}

function clampLocalPercent(value) {
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return value;
}

async function fetchMimoLimits({
  home,
  env = process.env,
  nowMs = Date.now(),
  sqliteOptions = {},
} = {}) {
  const disabled = isTruthyEnvValue(env.TOKENTRACKER_MIMO_DISABLE);
  const providers = parseMimoPlanProviders(env);
  const planTokens = parseMimoPlanTokens(env);
  const resetDay = parseMimoPlanResetDay(env);
  const planLabel = parseMimoPlanLabel(env);
  const period = computeMimoPlanPeriod(nowMs, resetDay);
  const resetAt = new Date(period.resetMs).toISOString();

  const { authPath, keyNames } = readMimoPlanAuthKeyNames({ home, env, providers });
  const configured = !disabled && keyNames.length > 0;

  const base = {
    configured,
    source: "local-estimate",
    plan_label: planLabel,
    plan_tokens: planTokens,
    reset_day: resetDay,
    auth_path: authPath,
    provider_ids: providers,
    period_start_at: new Date(period.startMs).toISOString(),
    period_end_at: new Date(period.endMs).toISOString(),
    reset_at: resetAt,
  };

  // Disabled or no surviving xiaomi-token-plan-* credential → the panel's
  // generic "not connected" state; no DB work at all.
  if (!configured) {
    return { ...base, disabled, error: null, period_tokens: 0, rows: 0, primary_window: null };
  }

  let collected;
  try {
    collected = await collectMimoLocal({ home, env, nowMs, sqliteOptions, providers, period });
  } catch (err) {
    return {
      ...base,
      disabled,
      error: String(err?.message || err),
      period_tokens: 0,
      rows: 0,
      primary_window: null,
    };
  }

  const used = Math.max(0, collected.periodTokens);
  const usedPercent = clampLocalPercent((used / planTokens) * 100) ?? 0;
  const window = {
    key: "plan",
    label: planLabel,
    limit: planTokens,
    used,
    remaining: Math.max(0, planTokens - used),
    used_percent: usedPercent,
    reset_at: resetAt,
    status:
      used >= planTokens
        ? "limit-reached"
        : used >= planTokens * 0.9
          ? "warning"
          : null,
  };

  // A read failure with zero rows must not paint the row as 0% used — surface
  // the error instead. Partial reads (some DBs answered) keep the estimate.
  const error = collected.rowCount > 0 ? null : collected.error;

  return {
    ...base,
    disabled,
    error,
    period_tokens: used,
    rows: collected.rowCount,
    primary_window: error ? null : window,
  };
}

module.exports = {
  fetchMimoLimits,
  collectMimoLocal,
  buildMimoAggregateSql,
  computeMimoPlanPeriod,
  readMimoPlanAuthKeyNames,
  parseMimoPlanTokens,
  parseMimoPlanResetDay,
  parseMimoPlanProviders,
  parseMimoPlanLabel,
  isMimoPlanProviderId,
  MIMO_PLAN_DEFAULT_TOKENS,
  MIMO_PLAN_DEFAULT_RESET_DAY,
  MIMO_PLAN_DEFAULT_LABEL,
  MIMO_PLAN_DEFAULT_PROVIDERS,
};
