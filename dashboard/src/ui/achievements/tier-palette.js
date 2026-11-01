// Tier color system for achievement badge coins.
//
// Colors are fixed hex values (not Tailwind classes) because they live inside
// SVG gradient stops, which cannot react to the `.dark` class. Every ramp is
// tuned to read as metal on both bg-white and bg-oai-gray-950 surfaces.

export const TIER_NAMES = { 1: "bronze", 2: "silver", 3: "gold", 4: "diamond" };

export const TIER_ORDER = ["bronze", "silver", "gold", "diamond"];

export const TIER_PALETTE = {
  bronze: {
    rim: ["#a06a44", "#5c3a22"],
    face: ["#d29a6c", "#96602f"],
    glyph: "#3f2817",
    ring: "#e8c3a0",
    sheen: "rgba(255, 236, 220, 0.45)",
    label: "#a06a44",
  },
  silver: {
    rim: ["#aab3bb", "#67707b"],
    face: ["#dde2e7", "#9ba5ae"],
    glyph: "#39424b",
    ring: "#f2f5f7",
    sheen: "rgba(255, 255, 255, 0.55)",
    label: "#8b959f",
  },
  gold: {
    rim: ["#c9971c", "#8a6508"],
    face: ["#f2ca52", "#cf9c26"],
    glyph: "#5c430e",
    ring: "#ffe9a8",
    sheen: "rgba(255, 248, 214, 0.55)",
    label: "#b8860b",
  },
  diamond: {
    rim: ["#62b1e0", "#7c6fd9"],
    face: ["#c8ecf6", "#84b4ea"],
    glyph: "#27496d",
    ring: "#eafcff",
    sheen: "rgba(255, 255, 255, 0.65)",
    label: "#5a9bd8",
  },
};

// Unearned badges: muted neutral coin (palette swap, not CSS grayscale —
// cheaper to composite and theme-correct on both surfaces).
export const LOCKED_PALETTE = {
  rim: ["#a8ada9", "#7c817d"],
  face: ["#cdd2ce", "#a3a8a4"],
  glyph: "#6a706c",
  ring: "#dde1de",
  sheen: "rgba(255, 255, 255, 0.25)",
  label: "#8b908c",
};

export function paletteForTier(tier, locked = false) {
  if (locked || !tier || tier < 1) return LOCKED_PALETTE;
  return TIER_PALETTE[TIER_NAMES[Math.min(tier, 4)]] || LOCKED_PALETTE;
}

export function tierName(tier) {
  return TIER_NAMES[tier] || null;
}
