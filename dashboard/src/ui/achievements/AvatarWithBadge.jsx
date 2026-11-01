import React from "react";
import { LeaderboardAvatar } from "../../components/LeaderboardAvatar";
import { AchievementBadge } from "./AchievementBadge";

/**
 * LeaderboardAvatar with the user's highest achievement coin overlaid on the
 * bottom-right corner. Wrapper component on purpose — LeaderboardAvatar
 * returns a bare <img> and has ~20 callsites that pass layout classes, so we
 * never touch it directly.
 */
export function AvatarWithBadge({ badge, badgeLabel, className = "", ...avatarProps }) {
  return (
    <div className={`relative inline-flex shrink-0 ${className}`}>
      <LeaderboardAvatar {...avatarProps} />
      {badge ? (
        <span className="absolute -bottom-1 -right-1 inline-flex rounded-full ring-2 ring-white dark:ring-oai-gray-950">
          <AchievementBadge badgeId={badge.id} tier={badge.tier} size="sm" label={badgeLabel} />
        </span>
      ) : null}
    </div>
  );
}

export default AvatarWithBadge;
