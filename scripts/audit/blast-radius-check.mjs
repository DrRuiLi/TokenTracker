#!/usr/bin/env node
// Blast-radius guard for destructive bulk operations on cloud usage tables.
//
// Run this BEFORE any bulk quarantine / delete / update that is scoped by a
// heuristic WHERE clause, and pass the accounts you actually intend to act on.
// It reports every user the clause would touch and fails when that set is wider
// than your list.
//
// Why: on 2026-07-21 a batch quarantine keyed on a conversation-spike heuristic
// was run to act on 8 accounts. The clause matched 40. The other 32 had 51.1B
// tokens withheld for five weeks, and it surfaced only when one of them opened
// issue #534. The decision about those 8 was a judgement call; the 32 were never
// a decision at all -- nobody compared "who I meant" against "what the clause
// hits", because nothing made that comparison a step.
//
// Usage:
//   node scripts/audit/blast-radius-check.mjs \
//     --table tokentracker_hourly \
//     --where "source = 'codex' AND hour_start >= '2026-07-15'" \
//     --intended <uuid>,<uuid>,...
//
//   --intended-file <path>   newline- or comma-separated ids instead of inline
//   --allow-wider            report the difference but exit 0 (explicit override)
//
// Exit codes: 0 the clause is within the intended set; 1 it is wider (or error).
// Read-only: this script never writes. It shells out to the InsForge CLI, which
// must run from the repo root holding the production .insforge link.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const run = promisify(execFile);
const PROJECT_ROOT = process.env.TOKENTRACKER_INSFORGE_ROOT
  ?? `${process.env.HOME}/tokentracker`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseIds(raw) {
  const ids = raw
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  const bad = ids.filter((id) => !UUID_RE.test(id));
  if (bad.length > 0) fail(`not a uuid: ${bad.slice(0, 3).join(", ")}`);
  return [...new Set(ids)];
}

// The clause is operator-supplied SQL by design: this tool previews exactly the
// clause that is about to be run, so rewriting or escaping it would defeat the
// purpose. Refuse only the shapes that would make the preview diverge from the
// real statement.
function assertClauseIsPreviewable(where) {
  if (where.includes(";")) {
    fail("the WHERE clause must be a single expression (no ';')");
  }
  if (where.includes("--") || where.includes("/*")) {
    fail("strip SQL comments from the clause: they can hide terms from this preview");
  }
}

async function query(sql) {
  const { stdout } = await run(
    "npx",
    ["@insforge/cli", "db", "query", sql],
    { cwd: PROJECT_ROOT, maxBuffer: 32 * 1024 * 1024 },
  );
  // The CLI renders a box table. Strip ANSI colour, then pull the cell values.
  const ansi = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
  return stdout
    .replace(ansi, "")
    .split("\n")
    .filter((line) => line.includes("│"))
    .map((line) => line.split("│").map((cell) => cell.trim()).filter(Boolean))
    .filter((cells) => cells.length > 0);
}

const args = parseArgs(process.argv.slice(2));
const table = args.table;
const where = args.where;

if (typeof table !== "string" || !/^[a-z0-9_]+$/.test(table)) {
  fail("--table must be a bare table name");
}
if (typeof where !== "string" || !where.trim()) {
  fail("--where is required");
}
assertClauseIsPreviewable(where);

let intended = [];
if (typeof args["intended-file"] === "string") {
  intended = parseIds(readFileSync(args["intended-file"], "utf8"));
} else if (typeof args.intended === "string") {
  intended = parseIds(args.intended);
} else {
  fail("--intended or --intended-file is required (pass an empty file to preview only)");
}

const intendedSql = intended.length > 0
  ? `ARRAY[${intended.map((id) => `'${id}'`).join(",")}]::uuid[]`
  : "ARRAY[]::uuid[]";

const totals = await query(`
  select json_build_object(
    'rows', count(*),
    'users', count(distinct user_id)
  )::text
  from public.${table}
  where (${where})
`);
const summary = JSON.parse(totals.at(-1)[0]);

const unintendedRows = await query(`
  select user_id::text, count(*) as rows, coalesce(sum(total_tokens),0) as tokens
  from public.${table}
  where (${where}) and not (user_id = any(${intendedSql}))
  group by 1 order by 3 desc
`);
const unintended = unintendedRows.filter((cells) => UUID_RE.test(cells[0]));

const untouchedRows = await query(`
  select u.id::text
  from unnest(${intendedSql}) as u(id)
  where not exists (
    select 1 from public.${table} t
    where t.user_id = u.id and (${where})
  )
`);
const untouched = untouchedRows.filter((cells) => UUID_RE.test(cells[0]));

console.log(`table:          ${table}`);
console.log(`where:          ${where}`);
console.log(`rows matched:   ${summary.rows}`);
console.log(`users matched:  ${summary.users}`);
console.log(`users intended: ${intended.length}`);
console.log("");

if (untouched.length > 0) {
  console.log(`${untouched.length} intended account(s) are NOT matched by this clause:`);
  for (const [id] of untouched) console.log(`  ${id}`);
  console.log("");
}

if (unintended.length === 0) {
  console.log("OK: the clause touches nobody outside the intended set.");
  process.exit(0);
}

const totalTokens = unintended.reduce((sum, cells) => sum + Number(cells[2] || 0), 0);
console.log(`BLAST RADIUS: ${unintended.length} account(s) outside the intended set would be affected`);
console.log(`              ${totalTokens.toLocaleString()} tokens across their matched rows`);
console.log("");
for (const [id, rows, tokens] of unintended.slice(0, 50)) {
  console.log(`  ${id}  rows=${rows}  tokens=${tokens}`);
}
if (unintended.length > 50) {
  console.log(`  ... and ${unintended.length - 50} more`);
}
console.log("");
console.log("Narrow the clause, extend --intended deliberately, or pass --allow-wider.");
process.exit(args["allow-wider"] ? 0 : 1);
