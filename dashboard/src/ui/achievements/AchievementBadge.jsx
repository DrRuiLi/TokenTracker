import React from "react";
import { BADGE_BY_ID } from "./badge-catalog";
import { paletteForTier } from "./tier-palette";

// The artwork now carries its own engraved medallion edge. Keep the tier ring
// deliberately thin so the face remains the visual subject instead of reading
// as a double metal border. Page-scale coins also get a little more room for
// the denser original illustrations.
const SIZE_PX = { xs: 18, sm: 24, md: 44, xl: 88, lg: 108 };
const RING_PX = { xs: 0.75, sm: 1, md: 1.5, xl: 2, lg: 2 };

/**
 * Badge medallion: the achievement artwork (dashboard/public/achievements/*)
 * framed by a metallic tier ring — bronze/silver/gold/diamond is carried by
 * the ring, since the artwork itself is tier-less. Locked badges render the
 * gray ring + desaturated art. If the artwork fails to load, the lucide glyph
 * from the catalog renders on a tier-gradient face as fallback.
 */
export function AchievementBadge({
  badgeId,
  tier = 0,
  size = "md",
  locked = false,
  label,
  className = "",
}) {
  const entry = BADGE_BY_ID.get(badgeId);
  const isLocked = locked || !tier || tier < 1;
  const palette = paletteForTier(tier, isLocked);
  // size="fill" stretches to the parent box (Badge3DCoin's coin face);
  // numeric sizes pin exact pixels for grids/rows.
  const fill = size === "fill";
  const px = fill ? "100%" : SIZE_PX[size] || SIZE_PX.md;
  const ring = fill ? 4 : RING_PX[size] || RING_PX.md;
  const [artFailed, setArtFailed] = React.useState(false);
  const Glyph = entry?.icon || null;
  const showArt = Boolean(entry?.art) && !artFailed;

  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      className={`inline-flex shrink-0 rounded-full ${className}`}
      style={{
        width: px,
        height: px,
        padding: ring,
        background: `linear-gradient(135deg, ${palette.rim[0]} 0%, ${palette.ring} 42%, ${palette.rim[1]} 100%)`,
        // Hairline edge instead of a grey drop shadow — coins read crisp on
        // both surfaces without the muddy halo.
        boxShadow:
          fill || size === "md" || size === "xl" || size === "lg"
            ? "0 0 0 1px rgba(10, 15, 12, 0.06), 0 1px 2px rgba(10, 15, 12, 0.08)"
            : undefined,
      }}
    >
      {showArt ? (
        <img
          src={entry.art}
          alt=""
          draggable={false}
          loading="lazy"
          onError={() => setArtFailed(true)}
          className="h-full w-full rounded-full object-cover"
          style={isLocked ? { filter: "grayscale(1)", opacity: 0.55 } : undefined}
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center rounded-full"
          style={{ background: `linear-gradient(145deg, ${palette.face[0]}, ${palette.face[1]})` }}
        >
          {Glyph ? (
            <Glyph size={fill ? 64 : Math.round(px * 0.5)} color={palette.glyph} strokeWidth={2} />
          ) : null}
        </span>
      )}
    </span>
  );
}

export default AchievementBadge;
