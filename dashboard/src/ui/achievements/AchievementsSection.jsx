import { HardDrive } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import React from "react";
import { copy } from "../../lib/copy";
import { AchievementBadge } from "./AchievementBadge";
import { badgeProgress } from "./achievement-format";
import { BADGE_CATALOG, badgeCopyKey, sortBadges } from "./badge-catalog";
import { tierName, TIER_PALETTE } from "./tier-palette";

/**
 * Achievements badge wall (page-scale surfaces: /achievements, /u/:userId).
 * - isOwn: full catalog — earned first (tier desc), locked tail after.
 * - !isOwn: earned badges only; renders null when there is nothing to show.
 *
 * Layout: content-width columns + justify-between so the outer columns sit on
 * the container edges; the negative horizontal margin cancels the cells' own
 * inner padding so the COIN GRAPHICS (not the invisible boxes) optically
 * align with the page header. `columns="wide"` adds a 6-across tier for the
 * standalone page; the /u/ profile column keeps 3/4.
 *
 * animateIn: staggered rise-and-settle entrance for the standalone page (the
 * profile modal opens with its own transition — a second entrance there would
 * double-animate). Disabled under prefers-reduced-motion.
 */
export function AchievementsSection({
  achievements,
  isOwn = false,
  scope,
  onSelect,
  size = "xl",
  columns = "default",
  animateIn = false,
  className = "",
}) {
  const reducedMotion = useReducedMotion();
  const animated = animateIn && !reducedMotion;
  const byId = new Map();
  for (const a of Array.isArray(achievements) ? achievements : []) {
    if (a && a.id) byId.set(a.id, a);
  }

  const catalog = scope ? BADGE_CATALOG.filter((b) => b.scope === scope) : BADGE_CATALOG;

  let cells;
  if (isOwn) {
    // Earned first (tier desc, catalog order), locked tail after — the
    // colorful cluster leads, the grey "still to collect" set follows.
    const all = catalog.map((entry) => ({
      entry,
      record: byId.get(entry.id) || { id: entry.id, tier: 0 },
    }));
    const earnedCells = sortBadges(
      all.filter((c) => (c.record.tier || 0) >= 1).map((c) => ({ ...c, id: c.entry.id, tier: c.record.tier })),
    );
    const lockedCells = all.filter((c) => (c.record.tier || 0) < 1);
    cells = [...earnedCells, ...lockedCells];
  } else {
    cells = sortBadges(
      catalog
        .map((entry) => ({ entry, record: byId.get(entry.id) }))
        .filter((c) => c.record && (c.record.tier || 0) >= 1)
        .map((c) => ({ ...c, id: c.entry.id, tier: c.record.tier })),
    ).map(({ entry, record }) => ({ entry, record }));
  }

  if (cells.length === 0) return null;

  const gridCols =
    columns === "wide"
      ? "grid-cols-[repeat(3,max-content)] sm:grid-cols-[repeat(4,max-content)] lg:grid-cols-[repeat(5,max-content)]"
      : "grid-cols-[repeat(3,max-content)] sm:grid-cols-[repeat(4,max-content)]";
  // Optical alignment: cancel exactly the gap between the cell edge and the
  // coin graphic so the coins (not the boxes) sit on the container edges.
  const optical = size === "lg" ? "mx-0 sm:-mx-2" : "-mx-2 sm:-mx-4";
  const cellPadding = size === "lg" ? "px-0" : "px-1";

  return (
    <div className={`${optical} grid justify-between gap-y-7 ${gridCols} ${className}`}>
      {cells.map(({ entry, record }, index) => {
        const earned = (record.tier || 0) >= 1;
        const name = copy(badgeCopyKey(entry.id, "name"));
        const tName = earned ? tierName(record.tier) : null;
        const progress = badgeProgress(record);
        return (
          <motion.button
            key={entry.id}
            type="button"
            // Entrance leaves an inline transform behind, which beats the CSS
            // active:scale class — whileTap keeps the press feedback alive.
            initial={animated ? { opacity: 0, y: 16, scale: 0.9 } : false}
            animate={animated ? { opacity: 1, y: 0, scale: 1 } : undefined}
            whileTap={animated ? { scale: 0.97 } : undefined}
            transition={{ delay: 0.05 + index * 0.035, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            onClick={onSelect ? () => onSelect({ ...record, id: entry.id }) : undefined}
            className={`group flex w-[6.75rem] flex-col items-center rounded-xl ${cellPadding} pb-3 pt-4 text-center transition-[background-color,transform] duration-200 ease-out hover:bg-oai-gray-50 active:scale-[0.97] dark:hover:bg-oai-gray-900/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/60 sm:w-[7.75rem]`}
            aria-label={copy("achievements.badge.aria", {
              name,
              tier: tName ? copy(`achievements.tier.${tName}`) : copy("achievements.modal.locked"),
            })}
          >
            <AchievementBadge
              badgeId={entry.id}
              tier={record.tier}
              locked={!earned}
              size={size}
              className="transition-transform duration-200 ease-out group-hover:-translate-y-0.5 group-hover:scale-105"
            />
            <span className="mt-2.5 flex w-full items-center justify-center gap-1">
              <span
                title={name}
                className="min-w-0 truncate text-xs font-medium leading-tight text-oai-gray-800 dark:text-oai-gray-200"
              >
                {name}
              </span>
              {entry.scope === "local" && (
                <span
                  title={copy("achievements.page.local_note")}
                  aria-label={copy("achievements.scope.local")}
                  className="inline-flex shrink-0 text-oai-gray-400 dark:text-oai-gray-500"
                >
                  <HardDrive size={11} strokeWidth={2} aria-hidden />
                </span>
              )}
            </span>
            {/* Meta row has a fixed height so every cell aligns whether it
                shows a tier label, a progress bar, or nothing. */}
            <span className="mt-1 flex h-4 w-full items-center justify-center">
              {earned ? (
                <span
                  className="text-[10px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: TIER_PALETTE[tName]?.label }}
                >
                  {copy(`achievements.tier.${tName}`)}
                </span>
              ) : isOwn ? (
                <span className="h-[3px] w-14 overflow-hidden rounded-full bg-oai-gray-200 dark:bg-oai-gray-800">
                  <span
                    className="block h-full rounded-full bg-oai-brand/70"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </span>
              ) : null}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}

export default AchievementsSection;
