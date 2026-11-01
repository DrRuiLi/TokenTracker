import React from "react";
import { copy } from "../../lib/copy";
import { AchievementBadge } from "./AchievementBadge";
import { badgeCopyKey, BADGE_BY_ID, sortBadges } from "./badge-catalog";
import { tierName } from "./tier-palette";

/**
 * Compact overlapping badge row for space-constrained surfaces (the profile
 * modal). Coins stack like an avatar pile; hovering or focusing a coin lifts
 * it clear of the stack; clicking opens the detail dialog. 44px coins keep
 * the ≥40px touch-target rule while the -10px overlap keeps a full 12-badge
 * set inside ~420px.
 */
export function BadgeStrip({ badges, isOwn = false, onSelect, className = "" }) {
  const list = sortBadges(
    (Array.isArray(badges) ? badges : []).filter((b) => b && BADGE_BY_ID.has(b.id)),
  ).filter((b) => isOwn || (b.tier || 0) >= 1);

  if (list.length === 0) return null;

  return (
    <div className={`flex flex-wrap items-center pr-2.5 ${className}`}>
      {list.map((b, index) => {
        const earned = (b.tier || 0) >= 1;
        const name = copy(badgeCopyKey(b.id, "name"));
        const tierLabel = earned
          ? copy(`achievements.tier.${tierName(b.tier)}`)
          : copy("achievements.modal.locked");
        return (
          <button
            key={b.id}
            type="button"
            onClick={onSelect ? () => onSelect(b) : undefined}
            title={`${name} · ${tierLabel}`}
            aria-label={copy("achievements.badge.aria", { name, tier: tierLabel })}
            style={{ zIndex: list.length - index }}
            className="group relative shrink-0 -mr-2.5 rounded-full transition-transform duration-200 ease-out hover:z-30 hover:-translate-y-1 active:scale-95 focus-visible:z-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/60"
          >
            <AchievementBadge
              badgeId={b.id}
              tier={b.tier}
              locked={!earned}
              size="md"
              className="rounded-full ring-2 ring-white transition-shadow duration-200 group-hover:shadow-md dark:ring-oai-gray-950"
            />
          </button>
        );
      })}
    </div>
  );
}

export default BadgeStrip;
