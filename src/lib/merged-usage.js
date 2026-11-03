const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// The TRCC side screen and its X-subscription billing export are anchored to
// Asia/Shanghai (UTC+8), matching trcc/grok_billing.py and trcc/worker.py. The
// offset is a whole number of hours, so flooring an instant to its hour is the
// same boundary in UTC and UTC+8; only the calendar *date* needs the shift.
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Queue row kinds that are bookkeeping, not usage; readQueueData drops them and
// so must the merged view.
const NON_USAGE_KINDS = new Set(["account_session_state", "account_sync_watermark"]);

// Same key readQueueData dedupes by, so the merged file round-trips through the
// dashboard reader with no behavioural drift.
function queueRowKey(row) {
  return `${row.source || ""}|${row.model || ""}|${row.hour_start || ""}`;
}

// Billing store path, mirroring trcc/grok_billing.py#app_dir + store_path.
//
// The store is machine-global (%LOCALAPPDATA%), but it belongs to the same
// user profile as the queue. When a queuePath is given, only trust the store
// if it lives under that queue's profile home — test sandboxes redirect
// HOME/USERPROFILE to a temp dir while leaving LOCALAPPDATA pointing at the
// real profile, and merging real billing rows into a fixture would corrupt
// totals and leak user data. Returns null when no store applies.
function resolveGrokBillingPath(queuePath) {
  const base =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  if (queuePath) {
    // <home>/.tokentracker/tracker/queue.jsonl -> <home>
    const queueHome = path.dirname(
      path.dirname(path.dirname(path.resolve(queuePath))),
    );
    const rel = path.relative(queueHome, path.resolve(base));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  }
  return path.join(base, "trcc-token-dash", "grok-billing.jsonl");
}

// The merged view lives beside the queue so it inherits the queue directory and
// is discoverable from queuePath alone.
function resolveMergedUsagePath(queuePath) {
  return path.join(path.dirname(queuePath), "merged-usage.jsonl");
}

// Asia/Shanghai calendar date (YYYY-MM-DD) for an epoch-ms instant.
function localDateKey(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

// Floor an instant to its containing hour (epoch ms).
function floorHour(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function parseInstant(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return null;
  // Python writes "...Z"; Date.parse also accepts offsets and bare ISO forms.
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A truncated final line from a concurrent writer is expected; skip it.
    }
  }
  return out;
}

// Dedupe queue rows by (source, model, hour_start), last row wins — the same
// rule readQueueData applies — so the merged file is a faithful superset of the
// queue for every source it keeps. Returns rows in first-seen key order.
// Async (fsp.readFile) so a multi-MB queue never blocks the event loop.
async function readQueueRowsForMerge(queuePath) {
  let text;
  try {
    text = await fsp.readFile(queuePath, "utf8");
  } catch {
    return [];
  }
  const latest = new Map();
  for (const row of parseJsonl(text)) {
    if (!row || NON_USAGE_KINDS.has(row.kind)) continue;
    latest.set(queueRowKey(row), row);
  }
  return Array.from(latest.values());
}

// Parse the billing store into [{ ms, model, tokens, product }]. Only rows with
// a usable timestamp and a positive token total participate in the merge.
// Async like readQueueRowsForMerge — the store only ever grows.
async function readBillingEvents(billingPath) {
  let text;
  try {
    text = await fsp.readFile(billingPath, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const row of parseJsonl(text)) {
    if (!row) continue;
    const ms = parseInstant(row.t);
    if (ms == null) continue;
    const tokens = Number(row.tokens);
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    events.push({
      ms,
      model: String(row.model || "unknown"),
      tokens: Math.round(tokens),
      product: String(row.product || ""),
    });
  }
  return events;
}

// The core merge.
//
//   queueRows      deduped raw queue rows (all sources)
//   billingEvents  parsed grok-billing rows
//
// Returns queue-shaped rows:
//   - non-cursor queue sources (opencode, codex, ...) always pass through;
//   - queue *cursor* and *grok-bot* rows are dropped on any UTC+8 date the
//     billing export covers for the matching product (billing is authoritative
//     there), and kept elsewhere;
//   - every billing event becomes a synthesized row (cursor or grok-bot) with
//     total = billable = tokens and no input/output split, so its cost is $0.
//
// Coverage is computed per product: billing for one product never suppresses
// queue rows for another product on the same date.
function buildMergedRows(queueRows, billingEvents) {
  const cursorCoveredDates = new Set();
  const grokBotCoveredDates = new Set();
  for (const event of billingEvents) {
    if (event.product === "cursor") cursorCoveredDates.add(localDateKey(event.ms));
    if (event.product === "grok-bot") grokBotCoveredDates.add(localDateKey(event.ms));
  }

  const rows = [];
  const seen = new Set();
  for (const row of queueRows) {
    if (!row || NON_USAGE_KINDS.has(row.kind)) continue;
    const ms = row.hour_start ? parseInstant(row.hour_start) : null;
    if (row.source === "cursor" && ms != null && cursorCoveredDates.has(localDateKey(ms))) {
      continue; // billing owns cursor on this date
    }
    if (row.source === "grok-bot" && ms != null && grokBotCoveredDates.has(localDateKey(ms))) {
      continue; // billing owns Grok Bot on this date
    }
    const key = queueRowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }

  // Bucket billing events by (product, model, hour) so many fine-grained line
  // items collapse into one queue-shaped row per hour.
  const buckets = new Map();
  for (const event of billingEvents) {
    const hourStart = new Date(floorHour(event.ms)).toISOString();
    const key = `${event.product}|${event.model}|${hourStart}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { source: event.product || "unknown", model: event.model, hour_start: hourStart, tokens: 0 };
      buckets.set(key, bucket);
    }
    bucket.tokens += event.tokens;
  }
  for (const bucket of buckets.values()) {
    rows.push({
      source: bucket.source,
      model: bucket.model,
      hour_start: bucket.hour_start,
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: bucket.tokens,
      billable_total_tokens: bucket.tokens,
      conversation_count: 0,
      total_cost_usd: 0,
    });
  }

  return rows;
}

function serializeRows(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

// Cheap file identity for the rebuild gate: any append or rewrite changes it.
// bigint stat, same shape async-queue-reader uses — a plain statSync has no
// mtimeNs (undefined would silently degrade the signature to size-only), and
// ctimeNs catches same-size in-place rewrites.
function fileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return "absent";
  }
}

const metaPathFor = (mergedPath) => `${mergedPath}.meta.json`;

function readMeta(mergedPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPathFor(mergedPath), "utf8"));
  } catch {
    return null;
  }
}

function writeMeta(mergedPath, meta) {
  const tmp = `${metaPathFor(mergedPath)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta), "utf8");
  fs.renameSync(tmp, metaPathFor(mergedPath));
}

// Concurrent-call dedup: the dashboard fans out to several usage endpoints at
// once, and each awaits ensureMergedUsage. Without this map they would all
// rebuild in parallel and race the same .tmp write. Keyed by merged path; the
// entry is removed as soon as the rebuild settles.
const inFlightMerges = new Map();

// Ensure merged-usage.jsonl reflects the current queue + billing store.
//
// Returns the merged path, or null when no billing export applies — there is
// nothing to merge, so callers read the raw queue and no derived file is
// written (any stale artifact from an earlier run is removed so readers never
// serve ghost rows after the store disappears).
//
// Rebuilds only when either input's signature changed since the last build
// (tracked in a sidecar meta file), so calling this on every dashboard request
// or on a timer is cheap when nothing has moved. When the rebuilt content is
// byte-identical to what is already on disk the write is skipped, preserving
// the dashboard reader's parse cache.
async function ensureMergedUsage({ queuePath, billingPath, mergedPath } = {}) {
  const queue = queuePath || resolveQueuePath();
  const billing =
    billingPath !== undefined ? billingPath : resolveGrokBillingPath(queue);
  const merged = mergedPath || resolveMergedUsagePath(queue);

  if (!billing || !fs.existsSync(billing)) {
    await fsp.rm(merged, { force: true }).catch(() => {});
    await fsp.rm(metaPathFor(merged), { force: true }).catch(() => {});
    return null;
  }

  const pending = inFlightMerges.get(merged);
  if (pending) return pending;

  const job = (async () => {
    const inputs = { queue: fileSignature(queue), billing: fileSignature(billing) };
    const meta = readMeta(merged);
    if (
      meta &&
      meta.queue === inputs.queue &&
      meta.billing === inputs.billing &&
      fs.existsSync(merged)
    ) {
      return merged;
    }

    const rows = buildMergedRows(
      await readQueueRowsForMerge(queue),
      await readBillingEvents(billing),
    );
    const payload = serializeRows(rows);

    let current = null;
    try {
      current = await fsp.readFile(merged, "utf8");
    } catch {
      // no merged file yet
    }
    if (current !== payload) {
      const tmp = `${merged}.tmp`;
      await fsp.writeFile(tmp, payload, "utf8");
      await fsp.rename(tmp, merged);
    }
    writeMeta(merged, inputs);
    return merged;
  })().finally(() => {
    inFlightMerges.delete(merged);
  });
  inFlightMerges.set(merged, job);
  return job;
}

// The queue path local-api resolves; exported so callers can derive the merged
// path without duplicating the directory layout.
function resolveQueuePath() {
  return path.join(os.homedir(), ".tokentracker", "tracker", "queue.jsonl");
}

module.exports = {
  ensureMergedUsage,
  buildMergedRows,
  readQueueRowsForMerge,
  readBillingEvents,
  resolveGrokBillingPath,
  resolveMergedUsagePath,
  resolveQueuePath,
  localDateKey,
  floorHour,
};
