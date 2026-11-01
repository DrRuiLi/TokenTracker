#!/usr/bin/env node
// Local preview for dashboard/edge-patches/tokentracker-embed-svg.ts without
// deploying to InsForge. The render helpers (renderProfileCard, placeholderSvg,
// PALETTE) are pure — a snapshot row in, an SVG string out — so only the
// cloud-only bits (the @insforge/sdk import and Deno.env reads) need stubbing.
//
// How it works: reads the edge file, strips the single `npm:@insforge/sdk`
// import, appends an export of the render helpers, writes the patched copy to
// a temp dir, and imports it with a `Deno` global stub. Node >= 22.6 strips
// the TypeScript types natively, so no build step is needed — that floor is
// higher than the package's `engines.node` (>=20), because Node 20 cannot
// import a .ts file at all, so it is checked for explicitly below.
//
// Usage:
//   node scripts/preview-embed-svg.mjs [--theme dark|light] [--period week|month|total]
//                                      [--name "Display Name"]
//                                      [--all-providers] [--out file.svg] [--no-open]
//
// The mock row mirrors a tokentracker_leaderboard_snapshots row (12.52B total,
// Claude 60% / Codex 26% / Hermes 13%) so output matches a real badge closely.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Importing the edge file needs native TypeScript handling, which
// `engines.node: ">=20"` does not guarantee — Node 20 cannot do it at all, and
// the failure it produces is an opaque ERR_UNKNOWN_FILE_EXTENSION. Ask Node
// rather than parsing a version string: `process.features.typescript` exists from
// 22.10 and reads "strip" (on by default from 22.18, or 22.6-22.17 behind
// --experimental-strip-types) or "transform" under --experimental-transform-types.
// Either mode imports the file, so requiring "strip" would refuse a Node that can
// run this. Before 22.10 the property is absent, so fall back to the version and
// the flag, the only combination that worked there.
const TS_MODE = process.features.typescript;
const CAN_IMPORT_TS =
  !!TS_MODE ||
  (() => {
    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj > 22) return min >= 6;
    if (maj < 22) return false;
    return min >= 6 && process.execArgv.some((a) => a.startsWith("--experimental-strip-types"));
  })();
if (!CAN_IMPORT_TS) {
  console.error(
    `preview-embed-svg.mjs needs Node's TypeScript support to import the edge ` +
      `file: Node ${process.versions.node} reports ` +
      `typescript=${TS_MODE ?? "unavailable"}. ` +
      `Use Node 22.18+, or 22.6-22.17 with --experimental-strip-types.`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const get = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const theme = get("--theme", "dark");
const period = get("--period", "total");
const name = get("--name", "Rafi Ahmed");
const outFlag = get("--out", "embed-svg-preview.svg");
const shouldOpen = !args.includes("--no-open");

if (!["dark", "light"].includes(theme)) {
  console.error(`bad --theme: ${theme} (use dark|light)`);
  process.exit(1);
}
if (!["week", "month", "total"].includes(period)) {
  console.error(`bad --period: ${period} (use week|month|total)`);
  process.exit(1);
}
// Each theme writes its own file unless --out says otherwise, so rendering dark
// and light in a row doesn't silently overwrite one another.
const defaultOut = `embed-svg-preview-${theme}.svg`;
const out = args.includes("--out") ? outFlag : defaultOut;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const edgePath = path.join(root, "dashboard", "edge-patches", "tokentracker-embed-svg.ts");
let source = fs.readFileSync(edgePath, "utf8");
if (!/export \{ renderProfileCard/.test(source)) {
  source = source
    .replace(/^import \{ createClient \} from "npm:@insforge\/sdk";\r?\n/m, "")
    .concat("\nexport { renderProfileCard, placeholderSvg, PALETTE };\n");
}
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-svg-"));
const patchedPath = path.join(tmpDir, "embed.ts");
fs.writeFileSync(patchedPath, source);
fs.writeFileSync(path.join(tmpDir, "package.json"), '{"type":"module"}');

// The edge module reads Deno.env at top level (blocked-user list); the render
// helpers never touch it, so an always-empty stub is enough for previews.
globalThis.Deno = { env: { get: () => "" } };
const { renderProfileCard } = await import(pathToFileURL(patchedPath).href + `?v=${Date.now()}`);

// --all-providers spreads usage across every column so the preview shows the
// full provider panel (and every logo symbol) at once.
const mockRow = {
  user_id: "00000000-0000-0000-0000-000000000000",
  display_name: name,
  rank: 685,
  total_tokens: 12_520_000_000,
  estimated_cost_usd: 696.4,
  gpt_tokens: 3_000_000_000,
  claude_tokens: 6_900_000_000,
  gemini_tokens: 0,
  cursor_tokens: 0,
  hermes_tokens: 1_650_000_000,
  copilot_tokens: 0,
  is_public: true,
  generated_at: new Date().toISOString(),
  ...(args.includes("--all-providers")
    ? {
        gemini_tokens: 900_000_000,
        cursor_tokens: 600_000_000,
        copilot_tokens: 300_000_000,
      }
    : {}),
};

const svg = renderProfileCard({ row: mockRow, theme, period });
fs.writeFileSync(out, svg);
console.log(`wrote ${out} (theme=${theme} period=${period})`);
if (shouldOpen) {
  // No shell anywhere on this path. exec() built a command string, so a crafted
  // --out ran arbitrary commands; execFile() with a real executable closes that,
  // because the path is passed as its own argv entry and never re-parsed.
  //
  // Windows notably does NOT go through `cmd /c start`: that hands the path back
  // to cmd, which splits on `&`, and Node's argv quoting only triggers on spaces
  // and quotes, so an unspaced `a&calc.svg` would execute calc. rundll32's
  // FileProtocolHandler is the shell-free way to reach the same default handler,
  // and it accepts paths with spaces because Node quotes those for us.
  const [opener, openerArgs] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", path.resolve(out)]]
      : process.platform === "darwin"
        ? ["open", [out]]
        : ["xdg-open", [out]];
  execFile(opener, openerArgs, () => {});
}
