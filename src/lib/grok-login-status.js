"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Presence only. Never select cookie names or values.
const GROK_HOST_SQL =
  "SELECT 1 AS present FROM cookies WHERE host_key = 'grok.com' OR host_key LIKE '%.grok.com' LIMIT 1";

function fileUrl(cookiesPath) {
  const abs = path.resolve(cookiesPath).replace(/\\/g, "/");
  const prefixed = abs.startsWith("/") ? abs : `/${abs}`;
  return `file://${prefixed}?mode=ro&immutable=1`;
}

function readGrokHostPresent(cookiesPath) {
  const { DatabaseSync } = require("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(fileUrl(cookiesPath), { readOnly: true });
  } catch {
    db = new DatabaseSync(cookiesPath, { readOnly: true });
  }
  try {
    const rows = db.prepare(GROK_HOST_SQL).all();
    return Array.isArray(rows) && rows.length > 0;
  } finally {
    db.close();
  }
}

/**
 * @returns {Promise<boolean|null>} true when a grok.com host cookie exists,
 * false when the profile has no cookie database, null when the database
 * cannot be read.
 */
async function grokComSignedIn(cookiesPath, { readPresent = readGrokHostPresent } = {}) {
  if (!cookiesPath) return false;
  try {
    if (!fs.existsSync(cookiesPath)) return false;
  } catch {
    return null;
  }
  try {
    return (await readPresent(cookiesPath)) === true;
  } catch {
    return null;
  }
}

module.exports = {
  fileUrl,
  GROK_HOST_SQL,
  grokComSignedIn,
  readGrokHostPresent,
};
