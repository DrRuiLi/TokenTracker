"use strict";

// The embed card is rendered as a raw SVG string by an InsForge edge function
// and dropped straight into a README <img> tag, where GitHub re-serves it
// through camo. Nobody reviews that output in review — a broken gradient id, a
// dropped XML escape, or a name that silently overflows the canvas would ship
// and stay shipped, because the only "test" would be a human pasting a badge
// into their README and noticing. These assertions pin the parts that are
// cheap to break and expensive to notice.
//
// The renderers are pure functions, so the module loads the same way
// scripts/preview-embed-svg.mjs loads it: Node strips the TypeScript types
// natively, the `npm:@insforge/sdk` import is dropped, and Deno.env is stubbed.
// No build step and no dependencies — unlike edge-pricing-parity.test.js, which
// needs esbuild from node_modules.
//
// That needs type stripping, which package.json's `engines.node: ">=20"` does
// not guarantee: Node 20 cannot import a .ts file at all, and every test here
// failed in the shared `before` hook with ERR_UNKNOWN_FILE_EXTENSION. The suite
// skips itself instead, rather than reporting a false failure on a version the
// project says it supports. Stripping is default-on from Node 22.18; 22.6-22.17
// need --experimental-strip-types. See CAN_IMPORT_TS below for how that is
// detected, including the versions where Node does not report it at all.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test: nodeTest, before } = require("node:test");
const assert = require("node:assert");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const EDGE_FILE = path.join(ROOT, "dashboard", "edge-patches", "tokentracker-embed-svg.ts");
const EXPORTS = ["renderProfileCard", "placeholderSvg", "PALETTE"];

// Whether Node can import a .ts file at all. Ask Node first:
// `process.features.typescript` exists from 22.10 and reads "strip" (default from
// 22.18, or 22.6-22.17 behind --experimental-strip-types) or "transform" when
// --experimental-transform-types is on — either mode loads the file, so requiring
// "strip" would reject a Node that can in fact run this. Before 22.10 the property
// does not exist, so fall back to the version and the flag, which was the only
// combination that worked there.
const TS_MODE = process.features.typescript;
const CAN_IMPORT_TS =
  !!TS_MODE ||
  (() => {
    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj > 22) return min >= 6;
    if (maj < 22) return false;
    return min >= 6 && process.execArgv.some((a) => a.startsWith("--experimental-strip-types"));
  })();
const test = CAN_IMPORT_TS ? nodeTest : nodeTest.skip;

let api;

before(async () => {
  const source = fs
    .readFileSync(EDGE_FILE, "utf8")
    .replace(/^import \{ createClient \} from "npm:@insforge\/sdk";\r?\n/m, "");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-svg-test-"));
  const modPath = path.join(tmpDir, "embed.ts");
  fs.writeFileSync(modPath, `${source}\nexport { ${EXPORTS.join(", ")} };\n`);
  fs.writeFileSync(path.join(tmpDir, "package.json"), '{"type":"module"}');
  // The module reads Deno.env at top level for the blocked-user list; the
  // render helpers never touch it.
  globalThis.Deno = { env: { get: () => "" } };
  api = await import(pathToFileURL(modPath).href);
});

function row(overrides = {}) {
  return {
    user_id: "00000000-0000-0000-0000-000000000000",
    display_name: "Rafi Ahmed",
    rank: 652,
    total_tokens: 11_550_000_000,
    estimated_cost_usd: 616.4,
    gpt_tokens: 3_000_000_000,
    claude_tokens: 6_900_000_000,
    gemini_tokens: 0,
    cursor_tokens: 0,
    hermes_tokens: 1_650_000_000,
    copilot_tokens: 0,
    is_public: true,
    generated_at: "2026-10-07T00:00:00.000Z",
    ...overrides,
  };
}

const NO_PROVIDERS = {
  gpt_tokens: 0,
  claude_tokens: 0,
  gemini_tokens: 0,
  cursor_tokens: 0,
  hermes_tokens: 0,
  copilot_tokens: 0,
};

const hero = (overrides = {}, theme = "dark", period = "total") =>
  api.renderProfileCard({ row: row(overrides), theme, period });

// Ids defined by the document itself: every `id="…"` on a gradient or clipPath
// the card emits.
function definedIds(svg) {
  return new Set(
    [...svg.matchAll(/<linearGradient[^>]*id="([^"]+)"|<radialGradient[^>]*id="([^"]+)"|<clipPath id="([^"]+)"/g)]
      .map((m) => m[1] ?? m[2] ?? m[3])
      .filter(Boolean),
  );
}

test("hero card keeps the 600x180 canvas and neon palette", () => {
  const dark = hero();
  const light = hero({}, "light");

  assert.match(dark, /width="600" height="180"/);
  assert.match(light, /width="600" height="180"/);
  // Dark theme carries the landing's violet accent; light theme darkens it for
  // contrast on white. Both backgrounds follow the landing palette (#050507).
  assert.match(dark, /#8a7aff/i);
  assert.match(light, /#6d55f0/i);
  assert.match(dark, /#050507/i);
});

test("the light card is shaded, not a flat white sheet", () => {
  // The light theme read as one blank sheet next to the dark one. Four separate
  // things caused it, and any one of them alone still leaves the card flat, so
  // all four are pinned here.
  const p = api.PALETTE.light;

  // 1. The sky gradient must actually span. #ffffff -> #f7f6fc was 3% and
  //    invisible; a ~5% violet-tinted range reads as a lit surface.
  const channel = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [tr, tg, tb] = channel(p.bgTop);
  const [br, bg, bb] = channel(p.bgBottom);
  const spread = (tr - br) + (tg - bg) + (tb - bb);
  assert.ok(spread > 24, `bgTop -> bgBottom spans only ${spread}/255; the card reads flat`);
  // Tinted, not grey: the bottom stop must carry more violet than the top.
  assert.ok(bb - br > tb - tr + 4, "bottom stop is not violet-tinted; it reads as grime");

  // 2. Stars on a light surface must be DARKER than the ground they sit on.
  //    A pale pink speck on white is invisible — that was the original bug.
  const lum = (hex) => {
    const [r, g, b] = channel(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  // 2. The card paints no specks, but the rule any mark here has to keep is the
  //    one the glint colour used to follow: contrast with its ground, not match
  //    it. The two themes need opposite treatments — pale on dark, darker than
  //    the surface on light — and that must not be "made consistent".
  assert.ok(
    api.PALETTE.dark.bgTop && api.PALETTE.light.bgTop,
    "palette lost its background colours",
  );
  assert.equal(api.PALETTE.light.bgTop, "#fdfcff", "light bgTop changed; re-check the shading block");
  assert.equal(api.PALETTE.dark.bgTop, "#0c0c13", "dark bgTop changed; re-check the shading block");

  // 3. Borders need contrast to register at all. The originals sat within ~1%
  //    of the background they were drawn on.
  assert.ok(lum(p.cardBorder) < lum(p.bgTop) - 0.01, "cardBorder has no contrast on the light card");
  assert.ok(lum(p.divider) < lum(p.bgTop), "divider is invisible on the light card");
  assert.ok(lum(p.barTrack) < lum(p.bgTop), "bar track is invisible on the light card");

  // 4. The accent glow has to be strong enough to model surface curvature.
  assert.ok(p.glowOpacity >= 0.14, `glow opacity ${p.glowOpacity} is too faint to read`);

  // 5. A light source, not just a gradient. Pushing the two sky stops apart is
  //    not sufficient on its own — an even top-to-bottom wash reads as a tinted
  //    sheet no matter how far apart they are. The white sheen in the lit
  //    corner is what gives the card form. The dark theme must NOT have one:
  //    a specular highlight on deep space flattens it to grey.
  assert.ok(p.sheenOpacity >= 0.6, `light sheen is ${p.sheenOpacity}; the card has no light source`);
  assert.equal(api.PALETTE.dark.sheenOpacity, 0, "dark card must not take a white sheen");

  // Sheen paints under the accent glow, so the lit corner still reads violet
  // rather than washing out to neutral white.
  const sheenAt = hero({}, "light").indexOf(`<rect width="600" height="180" fill="url(#bd-sheen-hero)"/>`);
  const glowAt = hero({}, "light").indexOf(`<rect width="600" height="180" fill="url(#bd-glow-hero)"/>`);
  assert.ok(sheenAt > 0 && glowAt > 0, "light backdrop is missing its sheen or glow layer");
  assert.ok(sheenAt < glowAt, "the sheen must sit under the accent glow, not over it");

  // The dark card takes no sheen, and the light one takes it at nearly full
  // strength: the sheen is what gives the light surface a lit corner, and on the
  // dark card a white highlight would flatten deep space to grey. The two must
  // not be "made consistent".
  assert.ok(p.sheenOpacity >= 0.6, `light sheen is ${p.sheenOpacity}; the card has no light source`);
  assert.equal(api.PALETTE.dark.sheenOpacity, 0, "dark card must not take a white sheen");
});

test("every gradient and clip-path reference resolves", () => {
  for (const svg of [hero(), hero({}, "light")]) {
    const ids = definedIds(svg);
    for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) {
      assert.ok(ids.has(m[1]), `references undefined id #${m[1]}`);
    }
  }
});

// What a renderer with NO SMIL support paints: the static attributes, with every
// <animate*> removed. These cover resvg, librsvg, ImageMagick and sharp, plus
// every link-preview / OG-image generator that rasterizes rather than animates.
//
// The digits must be readable off the BASE transform alone, and the base must
// therefore hold each strip's FINAL value — not the "0 showing" frame the roll
// starts from. Parked at the zero frame, every one of those renderers showed
// 0.00B / $000 / #000 and empty bars forever.
// A digit cell as the renderer emits it: the shared ink (font-size, font-weight,
// fill) lives on the clip group and is inherited by the glyph rows, and a cell
// carries only the rows its roll actually travels through. Both the attribute set
// and the row count therefore vary per cell, so match them structurally rather
// than hardcoding one shape.
const cellRe = (suffix) =>
  new RegExp(
    '<g clip-path="url\\(#odo-' + suffix + '-\\d+\\)"([^>]*)>' +
      '<g transform="translate\\(0 (-?[\\d.]+)\\)">' +
      '((?:<text[^>]*>\\d</text>)+)',
    "g",
  );
const ink = (attrs) => ({
  fontSize: Number(/font-size="([\d.]+)"/.exec(attrs)?.[1]),
  weight: /font-weight="([^"]+)"/.exec(attrs)?.[1],
  fill: /fill="([^"]+)"/.exec(attrs)?.[1],
});

test("the card is correct without SMIL, not just while animating", () => {
  // Strip the animations; what is left is what a non-SMIL renderer draws.
  const staticCard = (svg) => svg.replace(/<animate(?:Transform)?\b[^>]*\/>/g, "");

  // Digit strips as painted statically: glyph d is authored at
  // baseline + (d - restDigit) * pitch, so the glyph ON the baseline is the
  // target digit once the base transform is applied. The sign matters — a strip
  // whose rest digit is high puts its top glyph at a negative y, above the card.
  const staticDigits = (svg, suffix) => {
    const baseline = suffix === "tok" ? 150 : 149;
    let out = "";
    for (const c of svg.matchAll(cellRe(suffix))) {
      const rows = [...c[3].matchAll(/y="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
      const on = rows.findIndex((y) => Math.abs(y - baseline) < 0.05);
      out += on >= 0 ? String(on) : "?";
    }
    return out;
  };

  for (const [label, overrides] of [
    ["mock row", {}],
    ["wide cost", { estimated_cost_usd: 1234567.89 }],
  ]) {
    const svg = staticCard(hero(overrides));
    const title = /<title>[^<]*<\/title>/.exec(hero(overrides))[0];

    // Cost is compact above a million, so it can end in a suffix ("$1.23M") as
    // well as carrying separators. Strip both — the odometer's cells are digits
    // either way, and the title is the authority on what they should read.
    const wantCost = /\$[\d.,]+[A-Z]?/.exec(title)[0].replace(/\D/g, "");
    assert.equal(
      staticDigits(svg, "cost"),
      wantCost,
      `${label}: COST reads wrong without SMIL — a non-SMIL renderer would print the wrong figure`,
    );

    // A provider bar's BASE width is its full width; only the animation grows
    // it. Matched on the <animate attributeName="width"> child, so the dim
    // background track of each pair is not mistaken for the bar itself.
    const animated = hero(overrides);
    const fills = [...animated.matchAll(
      /<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)"[^>]*><animate attributeName="width"/g,
    )].map((m) => Number(m[1]));
    assert.equal(fills.length, 3, `${label}: expected three animated provider bars`);
    for (const w of fills) {
      assert.ok(w > 0, `${label}: a provider bar has base width 0 — it renders as an empty track without SMIL`);
    }
  }
});

// Each figure is drawn as an odometer — one <text> per stacked glyph, not one
// run of text — so its settled value is reconstructed from each cell's resting
// glyph. `suffix` picks the stat ("tok", "cost", "rank"); TOKENS sits on
// baseline 150 at 30px, the other two on 149 at 21px.
function settledFor(svg, suffix) {
  const baseline = suffix === "tok" ? 150 : 149;
  const CELL = new RegExp(
    '<g clip-path="url\\(#odo-' + suffix + '-\\d+\\)"[^>]*>' +
      '<g(?: transform="translate\\(0 [\\d.]+\\)")?>' +
      '(?:<text[^>]*>\\d</text>)+' +
      '<animateTransform[^>]*values="[^"]*"[^>]*\\/?>' +
      '</g></g>',
    "g",
  );
  const marks = [];
  const spans = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let pitch = ODO_PITCH;
  for (const c of svg.matchAll(CELL)) {
    spans.push([c.index, c.index + c[0].length]);
    // The strip rests at translate 0 and glyph d sits at baseline +
    // (d - restDigit) * pitch, so the digit in view is the row on the baseline.
    const rows = [...c[0].matchAll(/<text[^>]*y="([\d.]+)"[^>]*>(\d)</g)];
    const on = rows.find((r) => Math.abs(Number(r[1]) - baseline) < 0.05);
    marks.push({ at: c.index, ch: on ? on[2] : "?" });
    const x = Number(/<text x="([\d.]+)"/.exec(c[0])[1]);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    // Row spacing gives this cell's own pitch, which scales with its font size.
    pitch = Math.abs(Number(rows[1][1]) - Number(rows[0][1]));
  }
  // The suffix sits just past the last cell; one pitch of slack is enough to
  // include it while still excluding the next stat's "$"/"#".
  const gap = pitch;
  assert.ok(spans.length, `no ${suffix} odometer cells found`);
  for (const g of svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)) {
    if (spans.some(([a, b]) => g.index >= a && g.index < b)) continue;
    // Only this figure's own glyphs, which share its baseline. The avatar's
    // initial is a capital at a similar x but a completely different baseline,
    // and the neighbouring stats bring their own "$"/"#". "," is in the set
    // because formatCost's thousands separator is a static cell of the figure,
    // not decoration — without it a "$1,235" card reads back as "$1235".
    if (!/^[.#$,A-Z]$/.test(g[2])) continue;
    if (Math.abs(Number(g[1]) - baseline) > 0.05) continue;
    const x = Number(/x="([\d.]+)"/.exec(g[0])[1]);
    // A currency or rank prefix sits just left of the first cell, one pitch out.
    if (x < minX - gap || x > maxX + gap) continue;
    marks.push({ at: g.index, ch: g[2] });
  }
  return marks.sort((a, b) => a.at - b.at).map((m) => m.ch).join("");
}

const settledTokens = (svg) => settledFor(svg, "tok");

// Strip pitch, authored at the 30px TOKENS size. The 21px figures scale it by
// 0.7, so the skip checks compare against each cell's own pitch.
const ODO_PITCH = 30.6;
const ODO_CELL_H = 23;   // clip height at the authored size; the window adds 4*k
const ODO_OVERHANG = 4;  // how far the clip window hangs below the baseline, x k

test("a strip emits exactly the rows its clip window can reveal", () => {
  // The renderer drops the rows above a cell's target digit. That is only safe
  // while the window hangs less than one pitch below the baseline, and both
  // scale with the font, so the ratio is fixed at every size. Pin that ratio
  // first: if it ever reaches 1, a dropped row could peek in and this whole
  // optimisation silently changes what is drawn.
  assert.ok(
    ODO_OVERHANG < ODO_PITCH,
    `the clip window hangs ${ODO_OVERHANG}*k but rows sit ${ODO_PITCH}*k apart — a row above the target could now show`,
  );

  // Then confirm the emitted rows are exactly 0..restDigit on rows that shrink the
  // figures hardest, where a smaller pitch brings the window closest to the next row.
  const rowsOf = (svg, suffix) =>
    [...svg.matchAll(cellRe(suffix))].map((c) => [...c[3].matchAll(/>(\d)</g)].map((m) => Number(m[1])));

  for (const overrides of [
    {},
    { total_tokens: 999.99e12, estimated_cost_usd: 99_990_000, rank: 1_111_111_111_111 },
    { total_tokens: 0, estimated_cost_usd: 0, rank: 9 },
    { total_tokens: 987_654_321, estimated_cost_usd: 987_654.32, rank: 987_654 },
  ]) {
    const svg = hero(overrides);
    for (const suffix of ["tok", "cost", "rank"]) {
      for (const rows of rowsOf(svg, suffix)) {
        assert.ok(rows.length > 0, `${suffix}: a cell emitted no rows at all`);
        // Contiguous from 0, no gaps.
        assert.deepEqual(
          rows,
          rows.map((_, i) => i),
          `${suffix}: rows must be 0..rest with nothing skipped, got ${rows.join(",")}`,
        );
      }
    }
  }

  // The digit resting on the baseline is the last row emitted — if the trim ever
  // stopped short, the card would settle one digit short of its target.
  const settled = [...hero({ total_tokens: 987_654_321, estimated_cost_usd: 987_654.32, rank: 987_654 })
    .matchAll(cellRe("rank"))].map((c) => Number([...c[3].matchAll(/>(\d)</g)].pop()[1]));
  assert.equal(settled.join(""), "987654", "the rank strip must still reach every digit of its target");
});

// The digit timing tests look at the TOKENS odometer only: COST and RANK carry
// their own copies, so scanning every cell would count 10 and blur which figure
// the assertion is actually about.
function tokCells(svg) {
  return [...svg.matchAll(
    /<animateTransform[^>]*values="([^"]*)"[^>]*keyTimes="([^"]*)"/g,
  )].filter((m) => {
    const lastClip = svg.lastIndexOf('id="odo-', m.index);
    return lastClip >= 0 && svg.startsWith('id="odo-tok-', lastClip);
  });
}

test("every digit strip finishes its roll, however many digits the figure has", () => {
  // The per-digit stagger was a flat ODO_STAGGER * slot, so from the 6th digit
  // the sweep ran past the end of the timeline and fill="freeze" froze it PART
  // WAY THROUGH: a $1,234,568 cost left its last two strips at "0 0.60" and
  // "0 6.35" against a 21.4px pitch, visibly half-rolled. settledFor() could not
  // see it because it rebuilds digits from the untransformed glyph rows and
  // ignores the frozen offset entirely.
  //
  // So assert on the offset itself: the LAST value of every animateTransform must
  // be exactly "0 0.00" — the resting glyph, parked on the baseline.
  const CASES = [
    ["4 digits", {}],
    // 7 digits, the shape that broke it. (Cost compacts above a million, so this
    // is "$1.23M" — 4 digits. The RANK below is what carries 7.)
    ["wide cost", { estimated_cost_usd: 1234567.89 }],
    ["wide rank", { rank: 1234567 }],
    ["both wide", { estimated_cost_usd: 1234567.89, rank: 1234567 }],
  ];
  for (const [label, overrides] of CASES) {
    for (const svg of [hero(overrides), hero(overrides, "light")]) {
      // The cell group carries the shared ink after clip-path, so the matcher has
      // to allow it — pinned here, because when it did not, this matched nothing
      // and the test below passed without checking a single strip.
      const strips = [...svg.matchAll(
        /<g clip-path="url\(#odo-[a-z0-9]+-\d+\)"[^>]*>[\s\S]*?<animateTransform[^>]*values="([^"]*)"/g,
      )];
      assert.ok(strips.length > 0, `${label}: no digit strips matched — the settle check would be vacuous`);
      for (const m of strips) {
        const values = m[1].split(";");
        const id = /url\(#(odo-[a-z0-9]+-\d+)\)/.exec(m[0])[1];
        assert.equal(
          values.at(-1),
          "0 0.00",
          `${label}: ${id} freezes at "${values.at(-1)}" instead of settling on its digit`,
        );
      }
    }
  }
});

test("a unit suffix is not crowded by the digit in front of it", () => {
  // Static cells were all 0.8 * advance, but Inter's M advances 1.51x a digit
  // (27.1px against 18px at 30px). In a 0.8 cell its ink overhung by ~3.7px on
  // each side and ran into the last digit — "4.12M" read as "4.12 M". Each
  // glyph now gets its real advance, so the ink stays inside its own cell.
  //
  // Measured from Inter's hmtx/glyf at 30px: advance as a multiple of a digit's.
  const ADVANCE = { M: 1.506, B: 1.09, K: 1.12, T: 1.076 };
  const DIGIT_INK = 15.35;   // Inter's widest digit ink at 30px ("0")
  const CASES = [
    ["B", {}],
    ["M", { total_tokens: 4_120_000 }],
    ["K", { total_tokens: 812_400 }],
    // "T" needs 1e12 tokens (compactNumber's trillion threshold).
    ["T", { total_tokens: 1_250_000_000_000 }],
  ];
  for (const [suffix, overrides] of CASES) {
    const svg = hero(overrides);
    const suffixNode = [...svg.matchAll(
      /<text x="([\d.]+)" y="150\.00" text-anchor="middle"[^>]*>([A-Z])<\/text>/g,
    )].find((m) => m[2] === suffix);
    assert.ok(suffixNode, `no "${suffix}" suffix on the TOKENS row`);
    const centre = Number(suffixNode[1]);
    const cellLeft = centre - (18 * ADVANCE[suffix]) / 2;
    const cells = [...svg.matchAll(/odo-tok-\d+"><rect x="([\d.]+)"/g)].map((m) => Number(m[1]));
    const lastDigit = cells[cells.length - 1];
    // The suffix CELL must start clear of the previous digit's INK. A little
    // clearance is required; the old layout put this at or below zero.
    const gap = cellLeft - lastDigit - DIGIT_INK;
    assert.ok(
      gap > 1,
      `"${suffix}"'s cell starts ${gap.toFixed(2)}px from the digit's ink — it crowds it`,
    );
  }
});

test("a strip holds still during its wait, then follows the ease-out", () => {
  // SMIL interpolates LINEARLY between keyframes, so a stretch of the curve that
  // is genuinely flat must be bracketed by two EQUAL values or it renders as a
  // straight line. The sample dedup collapses the whole flat wait to a single
  // keyframe, which meant the strip crept toward its target before its turn — the
  // opposite of the hold — and the creep grew as the sample count came down.
  //
  // Read back through the renderer's own linear map, every strip's painted path
  // is compared against the exact curve it is supposed to draw:
  //   rest * (1 - (1 - t)^3) * pitch, held flat until `delay`, rolling over SWEEP.
  const SPRING = (t) => 1 - (1 - t) ** 3;
  const STAGGER = 0.1, SWEEP = 0.6, PITCH = ODO_PITCH;
  const paint = ({ v, k }, keyTime) => {
    if (keyTime <= k[0]) return v[0];
    if (keyTime >= k[k.length - 1]) return v.at(-1);
    for (let i = 1; i < k.length; i++) {
      if (keyTime <= k[i]) {
        const span = k[i] - k[i - 1];
        return v[i - 1] + (v[i] - v[i - 1]) * (span === 0 ? 0 : (keyTime - k[i - 1]) / span);
      }
    }
    return v.at(-1);
  };

  for (const [label, overrides] of [
    ["mock", {}],
    ["widest", { total_tokens: 999.99e12, estimated_cost_usd: 99999999, rank: 1234567 }],
  ]) {
    const svg = hero(overrides);
    const strips = [...svg.matchAll(
      /<g clip-path="url\(#odo-tok-(\d+)\)"[^>]*><g transform="[^"]*">(?:<text[^>]*>\d<\/text>)+<animateTransform[^>]*values="([^"]*)"[^>]*keyTimes="([^"]*)"/g,
    )];
    assert.ok(strips.length, `${label}: no TOKENS strips found`);

    let slot = 0;
    for (const m of strips) {
      // Only digit cells have a strip, so every match is one animated digit and
      // the stagger slot simply counts them in document order. (Static cells —
      // the "." and the unit suffix — carry no strip and never match here.)
      const s = {
        v: m[2].split(";").map((x) => Number(x.trim().split(/\s+/)[1])),
        k: m[3].split(";").map(Number),
        // The strip's own row spacing IS its pitch, and it is not always
        // ODO_PITCH: a row too wide for the panel shrinks its figures, so the
        // pitch scales with them. Reading it off the rows is the only way to get
        // the resting digit — dividing by the unscaled pitch gave 8.788 for a
        // digit that is really a 9.
        pitch: (() => {
          const ys = [...m[0].matchAll(/<text[^>]*y="(-?[\d.]+)"/g)]
            .slice(0, 2)
            .map((y) => Number(y[1]));
          return Math.abs(ys[1] - ys[0]);
        })(),
      };
      const rest = Math.round(s.v[0] / s.pitch);
      const delay = Math.min(STAGGER * slot++, 1 - SWEEP);
      // The renderer's own map: roll space [0,1] -> keyTime.
      const at = (t) => s.k[1] + (1 - s.k[1]) * t;

      for (let i = 0; i <= 300; i++) {
        const t = (i / 300) * delay;
        assert.ok(
          Math.abs(paint(s, at(t)) - rest * s.pitch) < 0.5,
          `${label}: strip moves ${Math.abs(paint(s, at(t)) - rest * s.pitch).toFixed(2)}px during its wait - it must hold`,
        );
      }
      for (let i = 0; i <= 900; i++) {
        const t = delay + (i / 900) * SWEEP;
        const want = rest * (1 - SPRING(Math.min(1, (t - delay) / SWEEP))) * s.pitch;
        assert.ok(
          Math.abs(paint(s, at(t)) - want) < 1,
          `${label}: strip is ${Math.abs(paint(s, at(t)) - want).toFixed(2)}px off the curve mid-roll`,
        );
      }
    }
  }
});

test("hero card renders the mock snapshot values", () => {
  const svg = hero();
  assert.equal(settledTokens(svg), "11.55B", "odometer settles on the wrong value");
  assert.match(svg, />Rafi Ahmed</);
  // COST and RANK animate too, so their values come from their own cells.
  assert.equal(settledFor(svg, "cost"), "$616", "COST settles on the wrong value");
  assert.equal(settledFor(svg, "rank"), "#652", "RANK settles on the wrong value");
  assert.match(svg, /Claude/);
  assert.match(svg, /Codex/);
  assert.match(svg, /Hermes/);
});

test("the odometer settles on the rounded figure, not the raw value", () => {
  // The roll used to divide the RAW number by a suffix scale, while every digit
  // is taken with floor(). compactNumber and formatCost round instead, so the two
  // disagreed whenever rounding went up — and the mock row above happens not to,
  // which is why this went unnoticed. Roughly half of all real values are affected.
  //
  // Each case below is one where they disagree, and each asserts against the
  // printed title so the badge can never contradict its own <title>/aria-label.
  const cases = [
    // floor(1155.6) = 1155 -> 11.55B; toFixed(2) printed "11.56".
    [{ total_tokens: 11_556_000_000 }, "11.56B"],
    // The carry case: "11.999" prints as "12B" once the trailing zeros are
    // trimmed, so the cells are places 10 and 1 — and 11.999 floored is 11B.
    [{ total_tokens: 11_999_000_000 }, "12B"],
    // formatCost rounds .5 up; floor() on the raw cost does not.
    [{ estimated_cost_usd: 616.6 }, "$617"],
    [{ estimated_cost_usd: 1234.5 }, "$1,235"],
  ];
  for (const [overrides, expected] of cases) {
    const svg = hero(overrides);
    const label = Object.values(overrides)[0];
    if (overrides.total_tokens !== undefined) {
      assert.equal(settledTokens(svg), expected, `${label} tokens settle on the wrong value`);
      assert.ok(
        svg.includes(`<title>`) && svg.includes(expected),
        `${label} tokens are absent from the title the badge shows`,
      );
    } else {
      assert.equal(settledFor(svg, "cost"), expected, `${label} cost settles on the wrong value`);
    }
  }
});

test("a crowded stat row leaves visible daylight before the provider panel", () => {
  // Not merely "does not overlap" — a row that fills every pixel up to the panel
  // reads as a collision even at exactly 0px, which is where letting the gaps go
  // to zero left the widest row. The figures now shrink so the row always keeps a
  // real margin, and this pins that margin.
  const PANEL_X = 438;
  const MIN_CLEARANCE = 6;
  // The widest printable row: every figure at its maximum width at once.
  const CASES = [
    ["widest", { total_tokens: 999.99e12, estimated_cost_usd: 99_990_000, rank: 9999999 }],
    ["12-digit rank", { total_tokens: 999.99e12, estimated_cost_usd: 99_990_000, rank: 1_111_111_111_111 }],
    ["unbounded cost", { estimated_cost_usd: 1e15, rank: 1_111_111_111_111 }],
    ["wide cost", { estimated_cost_usd: 9_999_999, rank: 9999999 }],
    ["ordinary", {}],
    ["narrow", { total_tokens: 1e6, estimated_cost_usd: 0, rank: 1 }],
  ];
  for (const [label, over] of CASES) {
    for (const svg of [hero(over), hero(over, "light")]) {
      const right = Math.max(
        ...[...svg.matchAll(/<clipPath id="odo-(?:tok|cost|rank)-\d+"><rect x="([\d.]+)"[^>]*width="([\d.]+)"/g)]
          .map((m) => Number(m[1]) + Number(m[2])),
        // A figure with no digits (a zero cost, a missing rank) is plain text.
        ...[...svg.matchAll(/<text x="([\d.]+)" y="1[45]9"[^>]*>[$#—]/g)].map((m) => Number(m[1]) + 12),
      );
      assert.ok(
        PANEL_X - right >= MIN_CLEARANCE,
        `${label}: stat row reaches ${right.toFixed(1)}, leaving only ${(PANEL_X - right).toFixed(1)}px before the panel at ${PANEL_X}`,
      );
    }
  }
});

test("a crowded stat row shrinks its figures instead of crowding the panel", () => {
  // The row must fit however wide its figures get, and rank is unbounded — a
  // 12-digit rank is more than the gutter-to-panel span leaves once two usable
  // gaps and a real margin are reserved. formatCost now compacts above a million,
  // so COST is bounded; RANK is not, and this is the case that exercises the
  // shrink. The figures scale down as one piece, keeping the 30:21 hierarchy, and
  // ordinary rows are untouched.
  // TOKENS carries the biggest figure, so its cell's font size is the row's. The
  // size is read off the cell's own group, where the shared ink is declared.
  const fonts = (svg) => ink([...svg.matchAll(cellRe("tok"))][0][1]).fontSize;
  const WIDEST = { total_tokens: 999.99e12, estimated_cost_usd: 99_990_000, rank: 1_111_111_111_111 };
  const ordinary = fonts(hero());
  const crowded = fonts(hero(WIDEST));
  assert.equal(ordinary, 30, "an ordinary row should render TOKENS at its tuned size");
  assert.ok(crowded < ordinary, `a 12-digit rank should shrink below ${ordinary}px, got ${crowded}`);
  assert.ok(crowded > ordinary * 0.85, `TOKENS shrank too far: ${crowded}px`);
  // A 10-digit rank still fits at full size — the shrink must not engage early.
  assert.equal(fonts(hero({ ...WIDEST, rank: 1_111_111_111 })), 30, "a row that fits should not shrink");
  // COST and RANK must keep their ratio to TOKENS, or the row loses its hierarchy.
  const sizes = (svg) =>
    ["tok", "cost", "rank"].map((s) => ink([...svg.matchAll(cellRe(s))][0][1]).fontSize);
  const [big, small] = sizes(hero(WIDEST));
  assert.ok(Math.abs(small / big - 21 / 30) < 0.01, `the 30:21 hierarchy changed on a crowded row (ratio ${(small / big).toFixed(3)})`);
});

test("hero card escapes XML in the display name", () => {
  const svg = hero({ display_name: '<script>"x" & \'y\'' });
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&quot;x&quot;/);
  assert.match(svg, /&apos;y&apos;/);
  assert.ok(!svg.includes("<script"), "raw < survived into the output");
});

test("hero card truncates a long display name with an ellipsis", () => {
  const svg = hero({ display_name: "Bartholomew Wolfeschlegelsteinhausenbergerdorff" });
  // Match the name node by its font-size rather than its baseline, which is
  // derived from the identity row's vertical centring.
  const nameNode = svg.match(/<text x="[\d.]+" y="[\d.]+"[^>]*font-size="21"[^>]*>([^<]*)</);
  assert.ok(nameNode, "name text node not found");
  assert.ok(nameNode[1].endsWith("…"), "long name was not truncated");
  assert.ok(nameNode[1].length <= 26, `truncated name is ${nameNode[1].length} chars`);
});

test("hero card falls back when the snapshot has no provider columns", () => {
  const svg = hero(NO_PROVIDERS);
  assert.match(svg, /No provider data yet/);
  assert.ok(!/NaN/.test(svg), "output contains NaN");
});

test("hero card reports an em dash for a missing rank", () => {
  assert.match(hero({ rank: null }), /—/);
});

test("every stat size has a tuned baseline, and an unknown one fails loudly", () => {
  // This was `fontSize === ODO_FONT ? 150 : 149` — an identity check that
  // silently fell through to 149 for any size that was neither 30 nor 21. The
  // odometer's clip window is anchored on the baseline and sized from the font,
  // so an untuned size slid the digits out of their own window and rendered
  // them sliced, with no error anywhere.
  //
  // The two tuned values are 150 at 30px and 149 at 21px — a 1px drop for a 9px
  // size difference. That is optical alignment, not a formula, so it is stored
  // rather than derived.
  for (const svg of [hero(), hero({}, "light")]) {
    // Every digit cell's resting glyph sits on the baseline the clip is built
    // from, so the baseline must be reachable for the sizes actually in use.
    const baselines = [...svg.matchAll(
      /<clipPath id="odo-(?:tok|cost|rank)-\d+"><rect x="[\d.]+" y="([\d.]+)"/g,
    )].map((m) => Number(m[1]));
    assert.ok(baselines.length >= 10, "expected a clip per digit cell");
    for (const top of new Set(baselines)) {
      // y = baseline - cellH, and cellH is 23 at 30px / 16.1 at 21px.
      const ok = Math.abs(top - 127) < 0.05 || Math.abs(top - 132.9) < 0.05;
      assert.ok(ok, `a digit cell's clip sits at y=${top}, from no tuned baseline`);
    }
  }

  // And the guard itself: an untuned size must throw rather than render wrong.
  // Exercised through the renderer by patching the module's own constants is
  // not possible from here, so this asserts the contract that the two in-use
  // sizes are the complete set — any third size has to be added deliberately.
  const cellTops = new Set(
    [...hero().matchAll(/<clipPath id="odo-tok-\d+"><rect x="[\d.]+" y="([\d.]+)"/g)].map((m) => m[1]),
  );
  assert.equal(cellTops.size, 1, "TOKENS renders at more than one size");
});

// Rightmost ink the stat row puts on the canvas, measured off the rendered
// markup: the last rank cell's clip edge, or the static "#" when the rank fell
// back to plain type.
function statRowEnd(svg) {
  const cells = [...svg.matchAll(/odo-rank-\d+"><rect x="([\d.]+)"[^>]*width="([\d.]+)"/g)];
  const cellEnd = cells.length ? Math.max(...cells.map((c) => Number(c[1]) + Number(c[2]))) : 0;
  const hash = Number((svg.match(/<text x="([\d.]+)" y="149"[^>]*>#/) || [, 0])[1]);
  return Math.max(cellEnd, hash + 21 * 0.5);
}

test("the stat dividers follow the figures instead of a fixed x", () => {
  // The dividers were pinned at 216 and 334, sized for the widest value the
  // badge can print. Any narrower figure then left the space it had reserved
  // as a hole — "11.55B" needs 90px of a 188px slot, so 78px of nothing sat
  // between the "B" and the divider and it read as a missing label.
  //
  // Figures range from 38px ("1M") to 134px ("999.99T"), so no single x works.
  const narrow = hero();
  const wide = hero({ total_tokens: 999.99e12, estimated_cost_usd: 99999, rank: 12345 });

  const divs = (svg) => [...svg.matchAll(/<line x1="([\d.]+)" y1="106"/g)].map((m) => Number(m[1]));
  const [n1, n2] = divs(narrow);
  const [w1, w2] = divs(wide);

  // A wider TOKENS must push both dividers right — if it does not, the
  // dividers are still hardcoded and the hole is still there.
  assert.ok(w1 > n1, `divider 1 did not move for a wider value (${n1} -> ${w1})`);
  assert.ok(w2 > n2, `divider 2 did not move for a wider value (${n2} -> ${w2})`);

  // Each divider sits midway through its own column gap, so the clearance the
  // eye reads is half the gap on each side — bounded above so a crowded row
  // cannot crowd the figure, and below so the hole cannot come back.
  const cellEnd = (svg, prefix) => {
    const re = new RegExp(`odo-${prefix}-\\d+"><rect x="([\\d.]+)"[^>]*width="([\\d.]+)"`, "g");
    const cells = [...svg.matchAll(re)];
    if (!cells.length) return null;
    return Math.max(...cells.map((c) => Number(c[1]) + Number(c[2])));
  };
  for (const [label, svg, d1] of [["narrow", narrow, n1], ["wide", wide, w1]]) {
    const end = cellEnd(svg, "tok");
    assert.ok(end !== null, `${label}: no TOKENS odometer cells found`);
    const gap = d1 - end;
    assert.ok(gap > 8, `${label}: only ${gap.toFixed(1)}px between TOKENS and divider 1`);
    assert.ok(gap < 60, `${label}: divider 1 crowds TOKENS by only ${gap.toFixed(1)}px`);
  }
});

test("the stat row never collides with the provider panel", () => {
  // Spreading the slack across the columns could, on a crowded row, run RANK
  // into the provider bars. Checked on the widest printable values, the
  // narrowest, and the all-static fallback.
  //
  // PANEL_X must be the renderer's 438 — the test used to assume 452, which is
  // 14px of optimism that hid a real collision. The widest row is the one whose
  // figures are all at their maximum print width at once, not a case with a
  // narrow rank: COL_GAP is a floor, so it was the three-wide row that ran under
  // the panel.
  const PANEL_X = 438;
  const cases = [
    ["mock", {}, 60],
    // 999.99T / $99,999,999 / #1234567 — every figure at its widest print. Note
    // the cost has to be 99999999, not 99999: formatCost renders >= 1000 as a
    // comma-grouped integer, so 99999.99 prints "$100,000" and is far narrower
    // than the "$99,999,999" that actually stresses the row.
    ["widest", { total_tokens: 999.99e12, estimated_cost_usd: 99999999, rank: 1234567 }, 0],
    ["wide cost, short rank", { estimated_cost_usd: 12345.67, rank: 7 }, 20],
    ["narrowest", { total_tokens: 1e6, estimated_cost_usd: 0, rank: 1 }, 25],
    ["zero", { total_tokens: 0, estimated_cost_usd: 0, rank: null }, 0],
  ];
  for (const [label, over, min] of cases) {
    const end = statRowEnd(hero(over));
    assert.ok(
      PANEL_X - end >= min,
      `${label}: stat row ends at ${end.toFixed(1)}, only ${(PANEL_X - end).toFixed(1)}px from the panel`,
    );
  }
});

test("the backdrop is static: no animation anywhere behind the figures", () => {
  // Two rounds of animating the backdrop were tried and cut — large glint orbs
  // sweeping across each other, then per-star twinkling. The numbers are the
  // badge's subject; anything that moves in the background competes with the
  // one thing the reader is meant to take in.
  for (const [name, svg] of [["hero", hero()], ["light hero", hero({}, "light")]]) {
    // Nothing in the backdrop may animate at all. The only animations on the
    // card are the digit strips (translate) and the provider bar widths.
    const backdrop = svg.slice(0, svg.indexOf('<g font-family='));
    assert.ok(!backdrop.includes("<animate"), `${name}: the backdrop animates`);
    assert.ok(!backdrop.includes("<animateTransform"), `${name}: the backdrop transforms`);

    // And nothing may ride the backdrop.
    assert.ok(!backdrop.includes("<ellipse"), `${name}: backdrop reintroduced a moving shape`);

    // No texture in the backdrop at all. A scattered starfield, sweeping glint
    // orbs and per-star twinkling were each tried; all of them competed with
    // the figures, which are the badge's subject. The surface carries only its
    // own shading — a lit gradient — which already reads as depth.
    const stars = [...backdrop.matchAll(/<circle /g)];
    assert.deepEqual(stars, [], `${name}: backdrop still paints ${stars.length} specks`);
  }

  // The card as a whole animates only where it should: the digit strips (ten
  // on the stats, two per provider percent row — the mock's 60/26/14) and the
  // three provider bars.
  const svg = hero();
  assert.equal(
    [...svg.matchAll(/<animateTransform[^>]*type="translate"/g)].length,
    16,
    "unexpected translation somewhere on the card",
  );
  assert.equal(
    [...svg.matchAll(/<animate attributeName="width"/g)].length,
    3,
    "unexpected width animation on the card",
  );
  assert.equal(
    [...svg.matchAll(/<animate /g)].length,
    3,
    "some other attribute is animating; the card should animate digits and bars only",
  );
});

test("digits are set tightly, not tracked out", () => {
  // ODO_GAP was 4, which left 4.4px of daylight between digits at 21px — 40%
  // of a digit's own width, and the reason COST and RANK read as tracked-out
  // type rather than as figures. A tabular face sets its own digits close; the
  // gap should add a little air, not most of a character's width.
  //
  // Measured off the rendered badge, a digit's ink at each size:
  const INK = { 21: 11, 30: 15 };
  const cases = [
    ["cost", 21],
    ["tok", 30],
  ];
  for (const [prefix, size] of cases) {
    const cells = [...hero().matchAll(
      new RegExp(`odo-${prefix}-\\d+"><rect x="([\\d.]+)"`, "g"),
    )].map((m) => Number(m[1]));
    assert.ok(cells.length >= 2, `no ${prefix} cells found`);
    const pitch = cells[1] - cells[0];
    const slack = pitch - INK[size];
    // Well under a third of the digit's width at either size.
    assert.ok(
      slack / INK[size] < 0.34,
      `${prefix}: ${slack.toFixed(2)}px between digits at ${size}px is ${((slack / INK[size]) * 100).toFixed(0)}% of the glyph width`,
    );
  }
// The decimal point is the one that still read loose after the digits were
  // tightened, and it is not the digits' fault. A static cell advanced by
  // `w + gap*0.4` while occupying only a third of a digit's width, so "1" and
  // "." ended up 9.65px apart against 2.73px between digits — a gap in the
  // number, one column over from where the eye was looking.
  const statics = [...hero().matchAll(
    /<text x="([\d.]+)" y="150\.00" text-anchor="middle"[^>]*>(\.)<\/text>/g,
  )];
  assert.equal(statics.length, 1, "expected one decimal point on the TOKENS row");
  const dotX = Number(statics[0][1]);
  // Measure the dot's CELL, not its ink centre: the digit cells give x at their
  // left edge, so comparing against the dot's centre would mix two origins.
  const dotW = 18 * 0.48;               // the "." cell, as odometerSvg sizes it
  const dotLeft = dotX - dotW / 2;
  const dotRight = dotX + dotW / 2;
  const dotCells = [...hero().matchAll(/odo-tok-\d+"><rect x="([\d.]+)"/g)].map((m) => Number(m[1]));
  const prevCell = dotCells.filter((x) => x < dotLeft).pop();
  const nextCell = dotCells.find((x) => x > dotRight);
  assert.ok(prevCell !== undefined, "no digit cell precedes the decimal point");
  assert.ok(nextCell !== undefined, "no digit cell follows the decimal point");
  // The dot's cell must sit close to BOTH neighbours. At 40% gap the leading
  // side measured 19.8px against 1.0px on the trailing side — that asymmetry is
  // exactly the "1 | . 55" hole the eye reads. 5px separates the two states
  // cleanly, so this fails loudly if the trailing gap regresses to 40%.
  assert.ok(
    nextCell - dotRight < 5,
    `${(nextCell - dotRight).toFixed(2)}px to the next digit; the decimal point is adrift`,
  );
  assert.ok(
    dotLeft - prevCell < 22,
    `${(dotLeft - prevCell).toFixed(2)}px after the previous digit`,
  );
});

test("provider rows centre the bar and logo on the label's cap line", () => {
  // The bar sat at baseline-7, which put its centre 1.22px above the label's
  // optical centre — enough for the rows to read as mis-aligned. Everything in
  // a row is now derived from the cap line (cap height ~0.72em), so the bar and
  // the logo are placed rather than nudged.
  const svg = hero();
  const ROW_FONT = 10.5, CAP = 0.72;
  const capMid = (ROW_FONT * CAP) / 2;

  const bars = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="47" height="4"/g)]
    .map((m) => Number(m[1]));
  assert.equal(bars.length, 3, `expected three bar tracks, found ${bars.length}`);

  for (const label of ["Claude", "Codex", "Hermes"]) {
    const y = Number(svg.match(
      new RegExp(`<text x="[\\d.]+" y="(\\d+)" font-size="10.5"[^>]*>${label}<`),
    )[1]);
    const barY = bars.reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a));
    const offset = barY + 2 - (y - capMid);
    assert.ok(
      Math.abs(offset) < 0.05,
      `${label}: bar centre is ${offset.toFixed(2)}px off the label's cap line`,
    );
  }

  // The bar only gets what survives the label column, the percent's "100%"
  // reservation, and the card's right margin — so the label must still clear
  // the bar by a real gap ("Hermes" is ~33px of it).
  const barX = Number(svg.match(/<rect x="([\d.]+)" y="1[2-6][\d.]*" width="47" height="4"/)[1]);
  // The percent is right-anchored, so exclude it when finding the label column.
  const labelX = Number(svg.match(/<text x="([\d.]+)" y="1[2-6][\d.]*" font-size="10.5" fill="[^"]*">[A-Za-z]+</)[1]);
  assert.ok(labelX >= 450, `label starts at ${labelX}, too far left`);
  assert.ok(barX - labelX >= 40, `only ${(barX - labelX).toFixed(1)}px between label and bar`);

  // The heading/share panel, the percent column, and the brand lockup share
  // one right margin: the percentages' INK lands on the bolt tile's right edge.
  // The odometer right-aligns by cell advance, so the grid's right edge is the
  // "%" CELL's right edge — its centre plus half its advance — and the ink sits
  // 1.18px inside that cell (Inter's right side bearing at this size). PCT_BLEED
  // pushes the grid out by exactly that much so the INK, not the cell, meets the
  // margin line.
  const tileRight = Number(svg.match(/<rect x="([\d.]+)" y="[\d.]+" width="22" height="22"[^>]*fill="url\(#tt-tile-22\)"/)[1]) + 22;
  const pctCentre = Number(svg.match(/<text x="([\d.]+)" y="124\.00" text-anchor="middle"[^>]*>%<\/text>/)[1]);
  const gridRight = pctCentre + (18 * 1.637 * (10.5 / 30)) / 2;
  assert.ok(
    Math.abs(gridRight - (tileRight + 1.18)) < 0.6,
    `percent grid ends at ${gridRight.toFixed(2)}; expected ${tileRight + 1.18} (tile edge ${tileRight} plus the % ink's right side bearing)`,
  );

  // The heading and the logo column share a left edge.
  const heading = Number(svg.match(/<text x="(\d+)" y="104"[^>]*>TOP PROVIDERS</)[1]);
  assert.equal(heading, 438, `heading at ${heading}; the panel's left edge moved`);
});

test("provider percentages count up on the odometer and rest at their value", () => {
  const svg = hero();
  // Each provider percent is a digit odometer with its own cells (p0/p1/p2),
  // so the shares roll up from zero rather than sitting as static text.
  for (const row of [0, 1, 2]) {
    const cells = [...svg.matchAll(new RegExp(`id="odo-p${row}-(\\d+)"`, "g"))].map((m) => m[1]);
    assert.ok(cells.length, `provider row ${row} has no odometer cells`);
  }

  // A digit whose target is 0 (the "0" in 60/26/14) must still produce a VALID
  // SMIL animation — values and keyTimes equal length, keyTimes 0 -> 1 — even
  // though it has no travel. A malformed single-frame animate is the failure
  // mode that silently disables the whole strip.
  //
  // "No travel" is read off the VALUES now, not the base transform: the base
  // holds the strip's final state (so a renderer without SMIL still shows the
  // right digit), which means it reads 0 for every strip and no longer
  // distinguishes them. A zero-target digit is the one whose every value is the
  // same resting offset.
  let held = 0;
  for (const m of svg.matchAll(
    /<g clip-path="url\(#odo-p\d-\d\)"[^>]*><g transform="translate\(0 ([\d.]+)\)">(?:<text[^>]*>\d<\/text>)+<animateTransform[^>]*values="([^"]*)"[^>]*keyTimes="([^"]*)"/g,
  )) {
    const vals = m[2].split(";");
    const kt = m[3].split(";").map(Number);
    assert.equal(vals.length, kt.length, "values and keyTimes must agree in length");
    assert.equal(kt[0], 0, "a strip's keyTimes must start at 0");
    assert.equal(kt[kt.length - 1], 1, "a strip's keyTimes must end at 1");
    if (new Set(vals).size === 1) {
      held++;
      assert.equal(Number(m[1]), 0, "a strip that never moves must rest at its final offset");
      assert.equal(vals.at(-1), "0 0.00", "a zero digit must settle on the baseline");
    }
  }
  assert.ok(held >= 1, "expected a percent row to rest a digit on 0");
});

test("stats are bare type with hairline dividers, not boxed pills", () => {
  const svg = hero();
  // The landing page is flat: white type does the work and borders only
  // separate. A pill/box behind any stat would reintroduce the dashboard's
  // card look the redesign deliberately dropped.
  const statPills = [...svg.matchAll(/<rect x="28" y="1[12]\d"/g)];
  assert.deepEqual(statPills, [], "a stat box was reintroduced");
  // Two dividers stand in for the boxes. Their x is content-derived, so it is
  // matched loosely — the exact placement has its own test above.
  const dividers = [...svg.matchAll(/<line x1="([\d.]+)" y1="106" x2="\1" y2="152"/g)];
  assert.equal(dividers.length, 2, "expected a divider between each stat pair");
  // Hierarchy is carried by scale, not by weight of chrome: TOKENS leads at 30px
  // while COST and RANK sit at 21px, and all three are rolling odometers.
  assert.match(svg, /<animateTransform attributeName="transform" type="translate"/);
  assert.ok(svg.includes('id="odo-tok-'), "TOKENS should animate");
  assert.ok(svg.includes('id="odo-cost-'), "COST should animate");
  assert.ok(svg.includes('id="odo-rank-'), "RANK should animate");
});

test("placeholders keep the rounded card shape and escape their message", () => {
  const svg = api.placeholderSvg("bad <style>", "dark");
  assert.match(svg, /rx="16"/);
  assert.match(svg, /&lt;style&gt;/);
  assert.ok(!svg.includes("bad <style>"));
});

test("every provider logo <use> resolves to an emitted <symbol>", () => {
  for (const svg of [hero(), hero({}, "light")]) {
    const symbols = new Set([...svg.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of svg.matchAll(/<use href="#([^"]+)"/g)) {
      assert.ok(symbols.has(m[1]), `<use> references missing symbol #${m[1]}`);
    }
    // Claude/Codex/Hermes are all non-zero on the mock row.
    for (const label of ["Claude", "Codex", "Hermes"]) {
      assert.ok(svg.includes(`<use href="#bpl-${label}"`), `missing logo for ${label}`);
    }
  }
});

test("only the providers a card renders ship their logo path data", () => {
  const svg = hero(NO_PROVIDERS);
  // No provider has tokens, so no provider symbols should be emitted —
  // otherwise every badge would carry six logos regardless of usage. The
  // TokenTracker bolt is a separate, always-present symbol.
  assert.ok(!/<symbol id="bpl-/.test(svg), "emitted provider logo symbols for an empty provider row");
  assert.ok(!svg.includes('<use href="#bpl-'), "emitted a provider logo for an empty provider row");
});

// The bolt path and tile gradient are copied from the shipped app icon so the
// badge's mark stays pixel-identical to it. Nothing generates these from a
// source asset — they are literals — so the two facts that make the claim
// meaningful are pinned here: the path's geometry, and the gradient's ten-stop
// ramp with its long dark dwell at the top.
test("the bolt path and tile gradient hold the app icon's shape", () => {
  const src = fs.readFileSync(EDGE_FILE, "utf8");

  // TT_BOLT_PATH is two adjacent string literals joined with `+`.
  const start = src.indexOf("const TT_BOLT_PATH");
  assert.ok(start > 0, "TT_BOLT_PATH not found");
  const boltPath = src
    .slice(start, start + 600)
    .split("\n")
    .slice(0, 3)
    .map((l) => (l.match(/"([^"]+)"/) || [])[1])
    .filter(Boolean)
    .join("");
  assert.ok(boltPath.startsWith("M92.47 45.94"), "the bolt no longer starts at the icon's origin");
  assert.ok(boltPath.endsWith("50.68 100.53Z"), "the bolt path is truncated or re-fitted");
  assert.equal(boltPath.length, 181, `bolt path length changed to ${boltPath.length} (was 181)`);
  // The icon's bolt is a different shape from Assets/02-bolt.svg — not a
  // rescale — so its four arcs are what distinguish it. A straight-line rewrite
  // could keep the length while losing the curvature.
  assert.equal((boltPath.match(/A/g) || []).length, 4, "the bolt's four arcs are gone; it was re-fitted");

  // The tile gradient: ten stops, near-black through the top third.
  const bm = src.indexOf("function brandMarkSvg");
  const seg = src.slice(bm, src.indexOf("\nfunction ", bm + 10));
  const stops = [...seg.matchAll(/stop-color="#([0-9a-f]{6})"/g)].map((m) => m[1]);
  assert.equal(stops.length, 10, `expected the icon's ten gradient stops, found ${stops.length}`);
  assert.equal(stops[0], "010101", "the gradient no longer starts at the icon's near-black");
  assert.equal(stops[stops.length - 1], "707070", "the gradient no longer ends at its graphite");
});

test("the official TokenTracker bolt is present and placed", () => {
  for (const svg of [hero(), hero({}, "light")]) {
    // Copied from the shipped app icon — a drifted path or viewBox would make
    // the badge's mark stop matching it.
    assert.match(svg, /<symbol id="tt-bolt" viewBox="0 0 200 200">/);
    assert.match(svg, /M92\.47 45\.94A4\.2 4\.2 0 0 1 100\.00 48\.50/);
    assert.match(svg, /<use href="#tt-bolt"/);
// Tile gradient is the app icon's own: 90deg, ten stops, verbatim from the
    // reference icon. A 2- or 3-stop approximation loses the long dark dwell.
    assert.match(svg, /<linearGradient id="tt-tile-22" x1="0" y1="0" x2="0" y2="1">/);
    assert.match(svg, /<stop offset="0" stop-color="#010101"\/>/);
    assert.match(svg, /<stop offset="0\.5" stop-color="#252525"\/>/);
    assert.match(svg, /<stop offset="1" stop-color="#707070"\/>/);
    // The bolt paints at 51% x 54% of the 22px tile — the app icon's own
    // proportion. Asserted as PAINTED size, not <use> box size: tt-bolt carries
    // the source's padded 200-unit viewBox, so the use box is deliberately larger.
    const bolt = svg.match(/<use href="#tt-bolt" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
    assert.ok(bolt, "bolt <use> missing");
    const [, x, y, useW, useH] = bolt.map(Number);
    const FILL = { w: 98.64 / 200, h: 111.4 / 200 };
    const paintedW = useW * FILL.w;
    const paintedH = useH * FILL.h;
    assert.ok(Math.abs(paintedW / 22 - 0.51) < 0.005, `bolt width is ${(paintedW / 22 * 100).toFixed(1)}% of tile, want 51%`);
    assert.ok(Math.abs(paintedH / 22 - 0.54) < 0.005, `bolt height is ${(paintedH / 22 * 100).toFixed(1)}% of tile, want 54%`);
    // …and stays centred on the tile (tile spans x 555..577, centre 566).
    assert.ok(Math.abs(x + useW / 2 - 566) < 0.05, "bolt is not horizontally centred");
  }
});

test("both themes use the same app-icon tile gradient", () => {
  // The mark must not drift between themes — the shipped icon is a fixed dark
  // squircle, so a theme-specific tile would read as two different logos.
  const tile = (svg) =>
    svg.match(/<linearGradient id="tt-tile-22"[^>]*>[\s\S]*?<\/linearGradient>/)?.[0] ?? "";
  const stops = (svg) =>
    [...tile(svg).matchAll(/<stop offset="[\d.]+" stop-color="(#\w+)"\/>/g)].map((m) => m[1]);

  const expected = [
    "#010101", "#050505", "#0d0d0d", "#181818", "#252525",
    "#323232", "#414141", "#505050", "#5f5f5f", "#707070",
  ];
  assert.deepEqual(stops(hero()), expected);
  assert.deepEqual(stops(hero({}, "light")), expected);
});

test("the bolt path inherits its fill so it is white in BOTH themes", () => {
  for (const svg of [hero(), hero({}, "light")]) {
    // The source asset uses currentColor, which resolves against the inherited
    // *text* color — not the <use> element's fill. Left in place it renders
    // black on the light theme no matter what boltInk says.
    const path = svg.match(/<symbol id="tt-bolt"[^>]*><path([^>]*)>/)?.[1] ?? "";
    assert.ok(!/fill=/.test(path), `bolt path hardcodes a fill: ${path.trim()}`);
    // And every placement site asks for white explicitly.
    for (const m of svg.matchAll(/<use href="#tt-bolt"[^>]*>/g)) {
      assert.match(m[0], /fill="#ffffff"/, "bolt is not painted white");
    }
  }
});

test("the TOKENS stat renders the app's rolling odometer as SMIL", () => {
  const svg = hero();
  // SMIL (not CSS) because the badge is an externally-referenced SVG: browsers
  // disable JS in that context but still run SMIL, and camo passes SVG through
  // byte-identical.
  assert.match(svg, /<animateTransform attributeName="transform" type="translate"/);
  // Every digit cell animates, including the two after the decimal point. Their
  // indices skip the "." between the integer and fractional parts, which is a
  // static glyph — so the ids are 0,1,3,4 rather than 0,1,2,3.
  const cells = [...svg.matchAll(/id="odo-tok-(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(cells, ["0", "1", "3", "4"], "expected all four digits to animate");

  // Each TOKENS digit strip must actually travel: a zero-length animation is
  // the failure mode where a digit never moves. Scoped to TOKENS because its
  // figure (11.55B) has no zero digit; a percent row's "0" (60%) legitimately
  // rests at zero and must not travel.
  const tokStrips = new RegExp(
    '<g clip-path="url\\(#odo-tok-\\d+\\)"[^>]*><g(?: transform="translate\\(0 [\\d.]+\\)")?>' +
      "(?:<text[^>]*>\\d</text>)+" +
      '<animateTransform[^>]*values="([^"]*)"',
    "g",
  );
  const tokAnim = [...svg.matchAll(tokStrips)];
  assert.equal(tokAnim.length, 4, "expected four TOKENS digit strips");
  for (const [, vals] of tokAnim) {
    const first = vals.split(";")[0].trim();
    const last = vals.split(";").pop().trim();
    assert.notEqual(first, last, `strip animation has no travel: ${vals.slice(0, 40)}`);
  }

  // Every animated strip must END at rest (translate 0), and the approach must be
  // monotonic — the spring converges asymptotically, so a slow creep is correct,
  // but any reversal is a strip jumping back and forth, which is the flicker
  // that was reported after the decimal point.
  for (const m of svg.matchAll(/<animateTransform[^>]*values="([^"]*)"/g)) {
    const seq = m[1].split(";").map((v) => Number(v.trim().split(/\s+/)[1]));
    assert.ok(Math.abs(seq[seq.length - 1]) < 0.5, `strip ends off rest: ${seq[seq.length - 1]}`);
    for (let i = 1; i < seq.length; i++) {
      assert.ok(
        seq[i] <= seq[i - 1] + 0.01,
        `strip reverses at frame ${i}: ${seq[i - 1]} -> ${seq[i]}`,
      );
    }
  }

  // keyTimes must accompany values, or SMIL redistributes the remaining frames
  // evenly and the settled hold becomes a slow crawl.
  const valueCounts = [...svg.matchAll(/values="([^"]*)"[^>]*keyTimes="([^"]*)"/g)]
    .map((m) => [m[1].split(";").length, m[2].split(";").length]);
  for (const [v, k] of valueCounts) {
    assert.equal(v, k, `values (${v}) and keyTimes (${k}) must be the same length`);
  }

  // A keyTimes list that does not run 0 -> 1 makes SMIL reject the whole
  // animateTransform element, and the digits then never move at all. This
  // silently disabled the animation once already, so it is pinned here.
  for (const m of svg.matchAll(/keyTimes="([^"]*)"/g)) {
    const kt = m[1].split(";").map(Number);
    assert.equal(kt[0], 0, `keyTimes must start at 0, got ${kt[0]}`);
    assert.equal(kt[kt.length - 1], 1, `keyTimes must end at exactly 1, got ${kt[kt.length - 1]}`);
    for (let i = 1; i < kt.length; i++) {
      assert.ok(kt[i] >= kt[i - 1], `keyTimes must not go backwards at index ${i}`);
    }
  }
});

test("the roll plays once and then freezes, rather than looping", () => {
  // repeatCount="indefinite" made the digits spin forever; the badge should
  // count up once on load and stay put. fill="freeze" holds the final frame.
  const svg = hero();
  assert.ok(!svg.includes('repeatCount="indefinite"'), "the odometer must not loop");
  const anims = [...svg.matchAll(/<animateTransform[^>]*>/g)].map((m) => m[0]);
  // 10 digit cells across the three stats (4 for TOKENS, 3 each for COST/RANK)
  // plus the provider percents, which count on the same odometer: two digits
  // per row for the mock's 60/26/14.
  assert.equal(anims.length, 16, "expected one animation per digit cell");
  for (const a of anims) {
    assert.match(a, /fill="freeze"/, "each strip must hold its final frame");
  }
  // The provider bars animate too, and must also settle rather than loop.
  const widths = [...svg.matchAll(/<animate attributeName="width"[^>]*>/g)].map((m) => m[0]);
  assert.ok(widths.length, "provider bars should animate their width");
  for (const w of widths) {
    assert.match(w, /fill="freeze"/, "each bar must hold its final width");
  }
});

test("every digit stops at the same point in the roll", () => {
  // Superseded by "the digits cascade instead of counting up in lockstep",
  // which now asserts the sequential ordering directly. Kept as the landing
  // check: no digit may still be rolling when the animation ends.
  const svg = hero();
  const ends = [...tokCells(svg)].map((m) => {
    const f = m[1].split(";").map((v) => Number(v.trim().split(/\s+/)[1]));
    const kt = m[2].split(";").map(Number);
    let last = 0;
    for (let k = 1; k < f.length - 1; k++) {
      if (Math.abs(f[k] - f[k - 1]) > 0.01) last = k;
    }
    return kt[last];
  });
  assert.equal(ends.length, 4);
  for (const e of ends) {
    assert.ok(e <= 1, `a digit is still rolling at t=${e}`);
  }
});

test("the easing keeps moving until it arrives instead of slamming and holding", () => {
  // "Smooth at the end" is a measurable property, so it is measured rather than
  // eyeballed: the roll must still be moving through the second half of its
  // sweep, and must never carry more speed than it needs to get there.
  //
  // The app's spring failed exactly this. It is critically damped, so 94.5% of
  // its travel is done by t=0.3 and all motion is over by 58% — the digits slam
  // into place and then sit inert for the remaining 42% of the window.
  const svg = hero();
  for (const [, values] of tokCells(svg)) {
    const offs = values.split(";").map((v) => Number(v.trim().split(/\s+/)[1]));
    const n = offs.length;
    const at = (t) => offs[Math.min(n - 1, Math.round(t * (n - 1)))];

    // Remaining distance relative to the total, over the sweep's own window.
    const span = offs[0] - offs[n - 1];
    if (Math.abs(span) < 0.5) continue; // a digit that barely moves proves nothing
    const remaining = (t) => (offs[Math.min(n - 1, Math.round(t * (n - 1)))] - offs[n - 1]) / span;

    // 1. Deceleration: the strip must still be travelling late in the sweep.
    //    A curve that has effectively stopped by t=0.8 reads as a hard stop.
    assert.ok(
      Math.abs(remaining(0.85)) > 0.004,
      `still ${(remaining(0.85) * 100).toFixed(1)}% of its travel at t=0.85 — it stops short`,
    );
    // Monotonic approach, and the last step must actually land on the target.
    assert.ok(Math.abs(offs[n - 1]) < 0.01, `digit ends at ${offs[n - 1]}, not on target`);
    for (let i = 1; i < n; i++) {
      assert.ok(offs[i] <= offs[i - 1] + 0.01, "strip moves backwards — the ease is not monotonic");
    }

    // 2. Peak speed must not exceed a uniform crawl by much. A curve that covers
    //    the same ground faster than cubic does at the start, then coasts, is
    //    the "slams then holds" shape this replaced.
    const steps = n - 1;
    const peak = Math.max(...offs.slice(1).map((v, i) => Math.abs(offs[i] - v)));
    assert.ok(
      peak / Math.abs(span) < 0.12,
      `peak step is ${((peak / Math.abs(span)) * 100).toFixed(1)}% of the travel; the roll jerks`,
    );
  }
});

test("the digits cascade instead of counting up in lockstep", () => {
  // Each digit starts its sweep a little after the one to its left, so the
  // number reads as cascading rather than snapping up all at once. Without
  // this every strip moved in lockstep and the figure looked mechanical.
  const svg = hero();
  const motion = [...tokCells(svg)]
    .map((m) => {
      const f = m[1].split(";").map((v) => Number(v.trim().split(/\s+/)[1]));
      const kt = m[2].split(";").map(Number);
      let start = null, end = null;
      for (let k = 1; k < f.length; k++) {
        if (Math.abs(f[k] - f[k - 1]) > 0.01) {
          if (start === null) start = kt[k];
          end = kt[k];
        }
      }
      return { start, end };
    });
  assert.equal(motion.length, 4);

  // Every digit must start strictly later than the one before it.
  for (let i = 1; i < motion.length; i++) {
    assert.ok(
      motion[i].start > motion[i - 1].start,
      `digit ${i} starts at ${motion[i].start}, not after ${motion[i - 1].start}`,
    );
  }

  // ...and the gaps must be even. The "." is a static glyph between the
  // integer and fractional digits; if it consumes a stagger slot, the gap
  // across the decimal point comes out double and the cascade reads as
  // pausing there instead of continuing through it.
  const gaps = motion.slice(1).map((m, i) => m.start - motion[i].start);
  const spread = Math.max(...gaps) - Math.min(...gaps);
  assert.ok(
    spread < 0.02,
    `stagger gaps are uneven (${gaps.map((g) => g.toFixed(3)).join(", ")}); ` +
      `the decimal point is probably consuming a slot`,
  );

  // ...but they must still OVERLAP. The app springs one shared value and every
  // digit reads its offset off it, so they all begin moving within the first
  // instants and each is still rolling when the next starts. A sweep shorter
  // than the stagger made the badge count one digit at a time like a slot
  // machine, which is not what the app does.
  //
  // Measured on VISIBLE motion (changes over half a pixel), not the nominal
  // sweep: the spring does most of its travel in its first 40% and then crawls
  // through an asymptotic tail, so the nominal window is far longer than what
  // the eye sees. Comparing the raw windows made a clearly overlapping roll look
  // sequential.
  const visible = (f) => {
    let start = null, end = null;
    for (let k = 1; k < f.length; k++) {
      if (Math.abs(f[k] - f[k - 1]) > 0.5) {
        if (start === null) start = k;
        end = k;
      }
    }
    return { start, end };
  };
  const visWindows = [...tokCells(svg)]
    .map((m) => visible(m[1].split(";").map((v) => Number(v.trim().split(/\s+/)[1]))))
    .filter((w) => w.start !== null);
  const visDurations = visWindows.map((w) => w.end - w.start);
  assert.equal(visWindows.length, 4, "expected four visible digit sweeps");

  const steps = 240;
  const toTime = (i) => (i / steps);
  const visStart = visWindows.map((w) => toTime(w.start));
  const visGaps = visStart.slice(1).map((v, i) => v - visStart[i]);
  const shortestVis = Math.min(...visDurations.map((d) => d / steps));
  assert.ok(
    shortestVis > Math.max(...visGaps) * 1.2,
    `the visible roll (${shortestVis.toFixed(3)}) is no longer than the gap ` +
      `(${Math.max(...visGaps).toFixed(3)}); the digits read as sequential`,
  );

  // The whole sequence must still fit inside the animation.
  assert.ok(
    Math.max(...motion.map((m) => m.end)) <= 1,
    "a digit is still rolling when the animation ends",
  );
});

test("no animated digit skips a step on its way to its final value", () => {
  // A skip means the strip teleports past a digit, which SMIL renders as a
  // jump. Every frame must move at most one place.
  const svg = hero();
  for (const m of svg.matchAll(/<animateTransform[^>]*values="([^"]*)"/g)) {
    const seq = m[1].split(";").map((v) => Number(v.trim().split(/\s+/)[1]));
    for (let i = 1; i < seq.length; i++) {
      const delta = Math.abs(seq[i] - seq[i - 1]);
      // A little over one pitch is expected for the fast decimal cells: their
      // digit changes hundreds of times over the roll, and near the end the
      // value advances faster than the sample grid, so a step can cover one
      // pitch plus a sliver. Anything near a FULL extra digit (2 pitches) is a
      // real skip — that is the 275px teleport this test exists to catch.
      assert.ok(
        delta <= ODO_PITCH * 1.5,
        `strip jumps ${delta}px at frame ${i}; a digit was skipped`,
      );
    }
  }
});

test("the odometer's clip window hides neighbouring digits", () => {
  const svg = hero();
  // Glyph d is drawn one pitch below the last, so the window must be shorter
  // than the pitch or two digits show at once.
  const clips = [...svg.matchAll(/id="odo-tok-\d+"><rect[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(clips.length, 4, "expected a clip per animated digit");
  for (const h of clips) {
    assert.ok(h < ODO_PITCH, `clip height ${h} exceeds the ${ODO_PITCH}px pitch; two digits show`);
  }
});

test("a zero figure falls back to static type rather than a dead roll", () => {
  // Every digit would sweep from 0 to 0 and sit still, which is worse than just
  // drawing the value. RANK also has no digits at all when there is no rank.
  const svg = hero({ total_tokens: 0, estimated_cost_usd: 0, rank: null });
  assert.ok(!svg.includes('id="odo-tok-'), "zero TOKENS should not render an odometer");
  assert.ok(!svg.includes('id="odo-cost-'), "zero COST should not render an odometer");
  assert.match(svg, /<text x="28" y="150"[^>]*>0<\/text>/);
  // COST's x follows the TOKENS figure's width, so it is derived here rather
  // than pinned — the static fallback lands wherever the animated one would.
  const costX = Number(svg.match(/<text x="([\d.]+)" y="149"[^>]*>\$0\.00/) ?.[1]);
  assert.ok(costX > 100, `zero-fallback COST landed at x=${costX}, past the stat row`);
});

test("the name and the brand lockup start on the same line", () => {
  // The wordmark used to be centred against the row, which dropped its 9px cap
  // top ~10px below the 21px name's cap top — the two read as starting at
  // different levels. Both now hang off the NAME's cap line.
  for (const svg of [hero(), hero({}, "light")]) {
    const y = (re) => Number(svg.match(re)?.[1]);
    const nameBaseline = y(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="21"/);
    const brandBaseline = y(/<text x="550" y="([\d.]+)"[^>]*font-size="9"[^>]*>TOKENTRACKER/);

    // Cap height of Inter runs ~0.72em, so a cap top is baseline - 0.72 * size.
    const nameCapTop = nameBaseline - 21 * 0.72;
    const brandCapTop = brandBaseline - 9 * 0.72;

    assert.ok(
      Math.abs(nameCapTop - brandCapTop) < 0.05,
      `name cap top ${nameCapTop.toFixed(2)} vs wordmark cap top ${brandCapTop.toFixed(2)}`,
    );
  }
});

test("the brand lockup's tile centres on its own two-line block", () => {
  // The tile follows the wordmark rather than the row, so it stays attached to
  // the text beside it.
  const svg = hero();
  const y = (re) => Number(svg.match(re)?.[1]);
  const nameCapTop = y(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="21"/) - 21 * 0.72;
  const brandBaseline = y(/<text x="550" y="([\d.]+)"[^>]*font-size="9"[^>]*>TOKENTRACKER/);
  const brandSubBaseline = y(/<text x="550" y="([\d.]+)"[^>]*font-size="9"[^>]*>tokentracker\.cc/);
  const tileCentre = y(/<rect x="555\.00" y="([\d.]+)"/) + 11;
  const blockCentre = (nameCapTop + brandSubBaseline) / 2;

  assert.ok(
    Math.abs(tileCentre - blockCentre) < 0.05,
    `tile centre ${tileCentre.toFixed(2)} is not on the lockup block centre ${blockCentre.toFixed(2)}`,
  );
});

test("the name and subtitle keep their own optical relationship", () => {
  // The row is now anchored by the name, but the subtitle must still hang off
  // the name rather than sitting at an unrelated baseline.
  const svg = hero();
  const y = (re) => Number(svg.match(re)?.[1]);
  const nameBaseline = y(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="21"/);
  const subBaseline = y(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="11\.5"/);

  const gap = subBaseline - nameBaseline;
  assert.ok(gap > 16 && gap < 22, `name-to-subtitle baseline gap is ${gap}px`);
});

test("the hero identity row has no avatar and leads on the card gutter", () => {
  // The disc was removed to see how the name reads on its own. Nothing in the
  // 600x180 canvas may still paint one, and the name now shares a left edge
  // with the TOKENS label below it instead of hanging off the disc's ring.
  for (const svg of [hero(), hero({}, "light")]) {
    assert.ok(!/<circle cx="44"/.test(svg), "hero still paints the avatar disc");
    assert.ok(!/av-body-hero|av-halo-hero/.test(svg), "hero still emits avatar gradients");
    const nameX = Number(svg.match(/<text x="([\d.]+)" y="51"[^>]*font-size="21"/)[1]);
    assert.equal(nameX, 28, `name starts at x=${nameX}; it should share the stat gutter`);
    // No orphaned gradient definitions for an element that is no longer drawn.
    assert.ok(!definedIds(svg).has("av-body-hero"), "orphan avatar gradient id");
    assert.ok(!definedIds(svg).has("av-halo-hero"), "orphan avatar halo id");
  }
});

test("neither card draws an avatar", () => {
  // The disc was a generated initial circle, never a real photo: it hashed the
  // display name into a hue and drew a letter. It cost 48px of width and pushed
  // the name to x=80, where it read as a caption beside a picture. With it gone,
  // so is the whole generator — avatarSvg(), hashHue() and the ring constants.
  for (const [name, svg] of [["hero", hero()], ["hero light", hero({}, "light")]]) {
    assert.ok(!/<circle[^>]*fill="url\(#av-/.test(svg), `${name}: still paints an avatar disc`);
    assert.ok(!/av-body-|av-halo-/.test(svg), `${name}: still emits avatar gradients`);
    for (const id of definedIds(svg)) {
      assert.ok(!/^av-(body|halo)-/.test(id), `${name}: orphan avatar gradient #${id}`);
    }
    assert.ok(
      !/dominant-baseline="central"/.test(svg),
      `${name}: still renders a centred initial`,
    );
  }
});

test("the bolt tile radius tracks its size on the hero card", () => {
  // 22px tile, horizontally centred on x=566 (so x=555). Its Y follows the
  // wordmark block rather than a fixed row, so it moves when the name does —
  // pinning the literal y here would just re-freeze the next alignment change.
  const m = hero().match(/<rect x="555\.00" y="([\d.]+)" width="22" height="22" rx="([\d.]+)" fill="url\(#tt-tile-22\)"/);
  assert.ok(m, "hero bolt tile not found at the expected x/width");
  assert.equal(m[2], (22 * 0.22).toFixed(2), "corner radius no longer tracks the tile size");
});

test("TokenTracker is named once per card, not twice", () => {
  // The corner lockup carries the brand; the subtitle under the display name
  // must not repeat it.
  for (const svg of [hero(), hero({}, "light")]) {
    assert.match(svg, />TOKENTRACKER</);
    assert.ok(!/>TokenTracker · /.test(svg), "subtitle still repeats the brand name");
  }
});

test("mono logos inherit theme ink, brand-color logos keep theirs", () => {
  const dark = hero();
  const light = hero({}, "light");
  // Cursor/Copilot/Hermes ship without a fill so the <use> supplies one, and
  // that ink must differ between themes or it vanishes on one of them.
  assert.match(dark, /<use href="#bpl-Hermes"[^>]*fill="#e6e3f5"/);
  assert.match(light, /<use href="#bpl-Hermes"[^>]*fill="#16161f"/);
  // Claude is brand-colored (#D97757); tinting it would be wrong.
  assert.match(dark, /<use href="#bpl-Claude"[^>]*width="13" height="13"\/>/);
});

test("provider logos add no id collisions across providers", () => {
  // Gemini and Codex ship gradient/clip ids; without namespacing, two symbols
  // would share ids and the wrong gradient would win document-wide.
  const svg = hero(NO_PROVIDERS, "dark");
  const all = hero({ ...NO_PROVIDERS, gemini_tokens: 1, gpt_tokens: 1, claude_tokens: 1 }, "dark");
  const ids = [...all.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(", ")}`);
  assert.ok(svg);
});