#!/usr/bin/env node
// Generates the inlined provider-logo markup embedded in the README badge SVG.
//
// Why inline instead of <image href="/brand-logos/…">: GitHub re-serves badge
// SVGs through its camo proxy, which will not fetch a relative path from the
// app's own origin. The badge must be one self-contained document, so each
// logo becomes a <symbol> of plain <path> data inside the card.
//
// Sources are the official brand assets already vendored in
// dashboard/public/brand-logos/ — the same files the dashboard renders — so the
// badge cannot drift from the app or carry an unlicensed redraw. Each is
// normalized for this context:
//
//   * inner id references are namespaced per provider (gemini/codex ship
//     gradient + mask/clip ids that would otherwise collide across providers);
//   * `currentColor` becomes a literal (it does not resolve inside an <img>);
//   * dark-on-dark fills (hermes' #0a0a0a) become a legible light color;
//   * gemini's 11 <filter> elements are dropped, along with the filter="url(#…)"
//     references they left behind — filters rasterize poorly through camo, each
//     would add hundreds of bytes, and a pointer to a deleted id is an error.
//
// Usage: node scripts/build-badge-logos.mjs [--write] [--json]
//   (default prints a summary; --write regenerates the const in
//    dashboard/edge-patches/tokentracker-embed-svg.ts)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGO_DIR = path.join(ROOT, "dashboard", "public", "brand-logos");
const EDGE_FILE = path.join(ROOT, "dashboard", "edge-patches", "tokentracker-embed-svg.ts");

// Snapshot column -> vendored asset. Mirrors providerShares() in the edge file.
const SOURCES = {
  Claude: "claude-code.svg",
  Codex: "codex.svg",
  Gemini: "gemini.svg",
  Cursor: "cursor.svg",
  Copilot: "copilot.svg",
  Hermes: "hermes.svg",
};

const BEGIN = "// --- BEGIN GENERATED: badge provider logos ---";
const END = "// --- END GENERATED: badge provider logos ---";

/**
 * Strips the outer <svg> wrapper and returns the inner markup plus its
 * viewBox, with ids namespaced so two providers can't collide on url(#…).
 */
function extract(src, prefix) {
  const viewBox = (src.match(/viewBox="([^"]+)"/) || [, "0 0 24 24"])[1];
  let inner = src.replace(/^[\s\S]*?<svg[^>]*>/i, "").replace(/<\/svg>\s*$/i, "");
  // Namespace every id= and its matching url(#…) / href="#…" reference.
  inner = inner
    .replace(/id="([^"]+)"/g, (_, id) => `id="${prefix}-${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${prefix}-${id})`)
    .replace(/(xlink:href|href)="#([^"]+)"/g, (_, attr, id) => `${attr}="#${prefix}-${id}"`);
  return { viewBox, inner };
}

/**
 * A logo is "mono" when its only ink is currentColor or a near-black fill.
 * Those have to be theme-aware — near-white on the dark card, near-black on
 * the light one — so instead of baking a color in, the fill attribute is
 * dropped entirely and the path inherits from the <use> element's fill.
 */
function isMono(inner) {
  const fills = [...inner.matchAll(/fill="([^"]*)"/g)].map((m) => m[1]);
  const meaningful = fills.filter((f) => f !== "none");
  if (!meaningful.length) return true;
  return meaningful.every(
    (f) => f === "currentColor" || /^#0a0a0a$/i.test(f) || f === "#000" || f === "#000000",
  );
}

/** Removes filter elements (and their contents) — camo-unfriendly. */
function stripFilters(inner) {
  let out = inner;
  for (let guard = 0; guard < 40; guard++) {
    const next = out.replace(/<filter\b[\s\S]*?<\/filter>/gi, "");
    if (next === out) break;
    out = next;
  }
  // Drop the references those elements left behind. A filter="url(#…)" pointing
  // at an id nothing defines is an error, and browsers disagree about what to do
  // with it: some skip the filter, some refuse to render the element at all. The
  // affected logo then loses its coloured layers in one browser and nothing in
  // another, so the markup has to carry neither the definition nor the pointer.
  return out.replace(/\sfilter="url\(#[^)]+\)"/gi, "");
}

function normalize(inner, prefix, opts) {
  let out = stripFilters(inner);
  if (opts.mono) {
    // Drop the literal ink; the <use> site's fill takes over. Also drop
    // `fill="none"` on a <g>, which would otherwise suppress inheritance.
    out = out.replace(/\sfill="(currentColor|#0a0a0a|#000|#000000)"/gi, "");
    out = out.replace(/(<g\b[^>]*)\sfill="none"/gi, "$1");
  }
  out = roundCoords(out);
  return out;
}

/**
 * Rounds every coordinate in path data to `places` decimals.
 *
 * The brand assets come from Figma at 3 decimals. A logo is drawn ~11px inside
 * a 600px-wide card, so at 2 decimals the third decimal is ~1/500th of a
 * pixel — invisible. Hermes is the extreme case (3 paths, 103 arc commands,
 * 19.5KB of path data) and dominates the payload, so precision is the lever
 * that keeps the badge from ballooning.
 */
function roundCoords(inner, places = 2) {
  const re = new RegExp(`(\\d*\\.\\d{${places}})(\\d*)`, "g");
  return inner.replace(re, "$1");
}

const build = () => {
  const entries = Object.entries(SOURCES).map(([label, file]) => {
    const src = fs.readFileSync(path.join(LOGO_DIR, file), "utf8");
    const prefix = `bpl-${label.toLowerCase()}`;
    const { viewBox, inner } = extract(src, prefix);
    const mono = isMono(inner);
    const cleaned = normalize(inner, prefix, { mono })
      .replace(/\s+/g, " ")
      .replace(/>\s+</g, "><")
      .trim();
    return { label, file, viewBox, mono, markup: cleaned, bytes: cleaned.length };
  });
  return entries;
};

const entries = build();
const total = entries.reduce((s, e) => s + e.bytes, 0);

for (const e of entries) {
  console.log(
    `${e.label.padEnd(8)} ${String(e.bytes).padStart(6)}B  viewBox="${e.viewBox}"` +
      `${e.mono ? "  (mono — inherits theme ink)" : "  (brand colors)"}`,
  );
}
console.log(`total    ${String(total).padStart(6)}B across ${entries.length} logos`);

const asConst = () => {
  const lines = entries.map(
    (e) =>
      `  ${e.label}: { viewBox: "${e.viewBox}", mono: ${e.mono}, markup: ${JSON.stringify(e.markup)} },`,
  );
  return [
    BEGIN,
    "// Generated by scripts/build-badge-logos.mjs from",
    "// dashboard/public/brand-logos/. Do not edit by hand — re-run the script.",
    "//",
    "// `mono` logos ship without a fill so they inherit the theme ink set at the",
    "// <use> site (see providerLogoUse); brand-color logos keep their own fills.",
    "// Only the providers a card actually renders get a <symbol>, so a user on",
    "// three providers doesn't ship the other three logos' path data.",
    "function badgeLogoSymbols(labels: string[]): string {",
    "  return labels",
    "    .filter((label) => BADGE_PROVIDER_LOGOS[label])",
    "    .map((label) => {",
    "      const { viewBox, markup } = BADGE_PROVIDER_LOGOS[label];",
    '      return `<symbol id="bpl-${label}" viewBox="${viewBox}">${markup}</symbol>`;',
    "    })",
    '    .join("");',
    "}",
    "",
    "const BADGE_PROVIDER_LOGOS: Record<string, { viewBox: string; mono: boolean; markup: string }> = {",
    ...lines,
    "};",
    END,
  ].join("\n");
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(entries, null, 2));
}

if (process.argv.includes("--write")) {
  const block = asConst();
  let edge = fs.readFileSync(EDGE_FILE, "utf8");
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
  if (re.test(edge)) {
    const eol = edge.includes("\r\n") ? "\r\n" : "\n";
    edge = edge.replace(re, block.replace(/\n/g, eol));
  } else {
    // Insert directly after the PROVIDER_HUES map it belongs with. The file
    // uses CRLF on Windows checkouts, so match line endings loosely.
    const anchor = edge.match(/const PROVIDER_HUES[\s\S]*?\r?\n\};\r?\n/);
    if (!anchor) throw new Error("could not find PROVIDER_HUES anchor in the edge file");
    const eol = anchor[0].includes("\r\n") ? "\r\n" : "\n";
    edge = edge.replace(
      anchor[0],
      `${anchor[0]}${eol}${block.replace(/\n/g, eol)}${eol}`,
    );
  }
  fs.writeFileSync(EDGE_FILE, edge);
  console.log(`\nwrote ${path.relative(ROOT, EDGE_FILE)} (${total}B of logo markup)`);
} else if (!process.argv.includes("--json")) {
  console.log("\n(dry run — pass --write to update the edge file)");
}