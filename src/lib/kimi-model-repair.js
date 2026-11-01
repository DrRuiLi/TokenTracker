"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const KIMI_MODEL_REPAIR_KEY = "kimiModelAttribution_2026_10";
const TOKEN_FIELDS = ["input_tokens", "cached_input_tokens", "cache_creation_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
const keyOf = (row) => row?.source === "kimi" && typeof row.model === "string" && typeof row.hour_start === "string"
  ? `kimi|${row.model}|${row.hour_start}` : null;
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function readBytes(file) {
  try { return await fs.readFile(file); } catch (error) { if (error.code === "ENOENT") return Buffer.alloc(0); throw error; }
}
async function readJson(file) {
  const bytes = await readBytes(file);
  return bytes.length ? JSON.parse(bytes.toString("utf8")) : null;
}
function latestRows(bytes) {
  const rows = new Map();
  for (const line of bytes.toString("utf8").split("\n")) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const key = keyOf(row);
    if (key) rows.set(key, row);
  }
  return rows;
}
function sumsByHour(rows) {
  const totals = new Map();
  for (const row of rows.values()) {
    const total = totals.get(row.hour_start) || Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
    for (const field of TOKEN_FIELDS) {
      const count = Number(row[field] || 0);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Kimi repair encountered invalid token totals");
      total[field] += count;
    }
    if (TOKEN_FIELDS.some((field) => total[field] !== 0)) totals.set(row.hour_start, total);
  }
  return totals;
}
function sameTotals(before, after) {
  const left = sumsByHour(before), right = sumsByHour(after);
  return left.size === right.size && [...left].every(([hour, total]) => right.has(hour)
    && TOKEN_FIELDS.every((field) => total[field] === right.get(hour)[field]));
}
function sameSnapshot(left, right) {
  return left && right && [...TOKEN_FIELDS, "conversation_count", "billable_total_tokens"]
    .every((field) => Number(left[field] || 0) === Number(right[field] || 0));
}
async function fileSignature(file) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Kimi repair source is not a file");
    return { size: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } finally { await handle.close(); }
}
async function writeJournal(file, journal) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(journal), { mode: 0o600, flag: "wx" });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

// Caller holds sync.lock and commits cursors after this returns, before upload.
// Only append to queue.jsonl; the caller compacts its pending suffix with
// minPendingBytes:0 after cursor commit, preserving uploaded bytes and offset.
// Parsers are injected to keep rollout.js independent of its migration helper.
async function repairKimiModelAttribution({ cursors, queuePath, queueStatePath, legacyFiles = [], officialFiles = [], parseLegacy, parseOfficial, env = process.env }) {
  const journalPath = `${queuePath}.kimi-model-repair.json`;
  const migrations = cursors.migrations || {};
  const applied = migrations[KIMI_MODEL_REPAIR_KEY];
  if (applied?.status === "applied" || applied?.status === "noop") {
    await fs.rm(journalPath, { force: true });
    return { repaired: false, pendingCompaction: applied.pendingCompaction === true };
  }
  let journal = await readJson(journalPath);
  if (!journal) {
    const rawQueue = await readBytes(queuePath);
    const live = latestRows(rawQueue);
    for (const [key, bucket] of Object.entries(cursors.hourly?.buckets || {})) {
      if (!key.startsWith("kimi|") || live.has(key)) continue;
      const [, model, hour_start] = key.split("|");
      live.set(key, { source: "kimi", model, hour_start, ...bucket.totals });
    }
    if (![...live.values()].some((row) => Number(row.total_tokens) > 0)) {
      (cursors.migrations ||= {})[KIMI_MODEL_REPAIR_KEY] = { status: "noop", appliedAt: new Date().toISOString() };
      return { repaired: false, pendingCompaction: false };
    }
    const files = [...new Set([...legacyFiles, ...officialFiles])];
    const discovered = new Set(files);
    const previousFiles = Object.entries(cursors.kimi?.fileOffsets || {}).concat(Object.entries(cursors.kimiCode?.fileOffsets || {}));
    if (!officialFiles.length || previousFiles.some(([file]) => !discovered.has(file))) {
      return { repaired: false, pendingCompaction: false, deferred: "missing-source" };
    }
    const signatures = new Map();
    try {
      for (const file of files) signatures.set(file, await fileSignature(file));
      if (previousFiles.some(([file, prior]) => signatures.get(file).size < Number(prior.size || 0))) {
        return { repaired: false, pendingCompaction: false, deferred: "truncated-source" };
      }
    } catch {
      return { repaired: false, pendingCompaction: false, deferred: "unreadable-source" };
    }
    const scratch = await fs.mkdtemp(path.join(path.dirname(queuePath), ".kimi-model-repair-"));
    const rebuilt = { version: 1, hourly: { version: 3, buckets: {}, groupQueued: {} } };
    let corrected;
    try {
      const scratchQueue = path.join(scratch, "queue.jsonl");
      await parseLegacy({ wireFiles: legacyFiles, cursors: rebuilt, queuePath: scratchQueue, env });
      await parseOfficial({ wireFiles: officialFiles, cursors: rebuilt, queuePath: scratchQueue, env });
      corrected = latestRows(await readBytes(scratchQueue));
      for (const file of files) {
        if (JSON.stringify(await fileSignature(file)) !== JSON.stringify(signatures.get(file))) {
          return { repaired: false, pendingCompaction: false, deferred: "source-changed" };
        }
      }
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
    // Missing/corrupt history or newly appended usage must first settle through
    // ordinary sync. A model-only repair may never change per-hour token totals.
    if (!sameTotals(live, corrected)) return { repaired: false, pendingCompaction: false, deferred: "totals-not-conserved" };
    const currentQueue = await readBytes(queuePath);
    if (!currentQueue.equals(rawQueue)) return { repaired: false, pendingCompaction: false, deferred: "queue-changed" };
    const state = await readJson(queueStatePath) || {};
    const offset = Number(state.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > rawQueue.length || (offset > 0 && rawQueue[offset - 1] !== 10)) {
      return { repaired: false, pendingCompaction: false, deferred: "invalid-upload-offset" };
    }
    const corrections = [];
    for (const [key, old] of live) {
      if (!corrected.has(key)) corrections.push({ source: "kimi", model: old.model, hour_start: old.hour_start,
        ...Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0])), billable_total_tokens: 0, conversation_count: 0 });
    }
    for (const [key, row] of corrected) if (!sameSnapshot(live.get(key), row)) corrections.push(row);
    journal = { version: 1, uploadedOffset: offset, uploadedPrefixSha256: digest(rawQueue.subarray(0, offset)),
      rows: corrections, kimi: rebuilt.kimi || {}, kimiCode: rebuilt.kimiCode || {}, hourly: rebuilt.hourly,
      preparedAt: new Date().toISOString() };
    await writeJournal(journalPath, journal);
  }
  const rawQueue = await readBytes(queuePath);
  const state = await readJson(queueStatePath) || {};
  if (journal.version !== 1 || !Number.isSafeInteger(journal.uploadedOffset) || journal.uploadedOffset < 0
    || rawQueue.length < journal.uploadedOffset || Number(state.offset || 0) < journal.uploadedOffset
    || digest(rawQueue.subarray(0, journal.uploadedOffset)) !== journal.uploadedPrefixSha256) {
    return { repaired: false, pendingCompaction: false, deferred: "uploaded-prefix-changed" };
  }
  if (journal.rows.length) {
    // A prior append can have stopped halfway through a JSON line. Preserve
    // those bytes, terminate that incomplete record, then append complete LWW
    // snapshots again. The journal bypasses conservation checks on partial work.
    const separator = rawQueue.length && rawQueue.at(-1) !== 10 ? "\n" : "";
    await fs.appendFile(queuePath, separator + journal.rows.map(JSON.stringify).join("\n") + "\n");
  }
  const hourly = (cursors.hourly ||= { version: 3, buckets: {}, groupQueued: {} });
  for (const field of ["buckets", "groupQueued"]) {
    hourly[field] ||= {};
    for (const key of Object.keys(hourly[field])) if (key.startsWith("kimi|")) delete hourly[field][key];
    for (const [key, value] of Object.entries(journal.hourly?.[field] || {})) if (key.startsWith("kimi|")) hourly[field][key] = value;
  }
  cursors.kimi = journal.kimi;
  cursors.kimiCode = journal.kimiCode;
  (cursors.migrations ||= {})[KIMI_MODEL_REPAIR_KEY] = {
    status: "applied", appliedAt: new Date().toISOString(), correctedBuckets: journal.rows.length,
    pendingCompaction: journal.rows.length > 0,
  };
  // Leave the journal until the next call observes the persisted marker.
  return { repaired: true, pendingCompaction: journal.rows.length > 0 };
}

module.exports = { KIMI_MODEL_REPAIR_KEY, repairKimiModelAttribution };
