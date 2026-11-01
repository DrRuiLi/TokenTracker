import React from "react";
import { copy } from "../../lib/copy";
import { AchievementBadge } from "./AchievementBadge";
import { badgeCopyKey, sortBadges, BADGE_BY_ID } from "./badge-catalog";
import { tierName } from "./tier-palette";

/**
 * Overlapping stack of up to `max` mini badge coins for leaderboard rows —
 * avatar-pile style so three badges cost barely more width than one.
 * pointer-events-none on the wrapper: the row itself is the click target
 * (opens the profile modal); hover tooltips still work via the inner spans.
 */
export const BadgeMini = React.memo(function BadgeMini({ badges, max = 3, className = "" }) {
  const list = sortBadges(
    (badges || []).filter((b) => b && BADGE_BY_ID.has(b.id) && (b.tier || 0) >= 1),
  ).slice(0, max);
  if (list.length === 0) return null;
  return (
    <span className={`pointer-events-none inline-flex shrink-0 items-center ${className}`}>
      {list.map((b, index) => (
        <span
          key={b.id}
          title={copy("achievements.mini.tooltip", {
            name: copy(badgeCopyKey(b.id, "name")),
            tier: copy(`achievements.tier.${tierName(b.tier)}`),
          })}
          style={{ zIndex: list.length - index }}
          className={`pointer-events-auto relative inline-flex ${index > 0 ? "-ml-1.5" : ""}`}
        >
          <AchievementBadge
            badgeId={b.id}
            tier={b.tier}
            size="xs"
            className="rounded-full ring-[1.5px] ring-white dark:ring-oai-gray-950"
          />
        </span>
      ))}
    </span>
  );
});

export default BadgeMini;
