import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import React, { useEffect } from "react";
import { copy } from "../../lib/copy";
import { cn } from "../../lib/cn";
import { isNativeWindowsApp } from "../../lib/native-bridge.js";
import { Badge3DCoin } from "./Badge3DCoin";
import { badgeProgress, formatBadgeValue, latestAchievedAt } from "./achievement-format";
import { BADGE_BY_ID, badgeCopyKey } from "./badge-catalog";
import { TIER_ORDER, TIER_PALETTE, tierName } from "./tier-palette";

function formatDate(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toLocaleDateString();
}

export function formatIssueNumber(value) {
  const issueNumber = Number(value);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return null;
  return String(issueNumber).padStart(6, "0");
}

export function currentBadgeIssueNumber(badge, entry, currentTierName) {
  if (entry?.scope !== "cloud" || !currentTierName) return null;
  const issueNumber = Number(badge?.serials?.[currentTierName]);
  return Number.isSafeInteger(issueNumber) && issueNumber >= 1 ? issueNumber : null;
}

function TierTrack({ badge }) {
  return (
    <div className="flex items-center gap-1">
      {TIER_ORDER.map((name, index) => {
        const reached = (badge.tier || 0) >= index + 1;
        const at = formatDate(badge.achieved?.[name]);
        const palette = TIER_PALETTE[name];
        return (
          <span
            key={name}
            title={at ? `${copy(`achievements.tier.${name}`)} · ${at}` : copy(`achievements.tier.${name}`)}
            className="inline-flex h-2 w-8 rounded-full"
            style={
              reached
                ? {
                    background: `linear-gradient(120deg, ${palette.rim[0]} 0%, ${palette.ring} 55%, ${palette.rim[1]} 100%)`,
                    boxShadow: "inset 0 1px 1px rgba(255,255,255,0.4), 0 0 0 1px rgba(10,15,12,0.05)",
                  }
                : undefined
            }
          >
            {!reached && (
              <span className="h-full w-full rounded-full bg-oai-gray-200 dark:bg-oai-gray-800" />
            )}
          </span>
        );
      })}
    </div>
  );
}

function BadgeDetailBody({ badge, onClose }) {
  const entry = BADGE_BY_ID.get(badge.id);
  const name = copy(badgeCopyKey(badge.id, "name"));
  const earned = (badge.tier || 0) >= 1;
  const tName = earned ? tierName(badge.tier) : null;
  const achievedDate = formatDate(
    earned ? badge.achieved?.[tName] || (latestAchievedAt(badge) ? new Date(latestAchievedAt(badge)).toISOString() : null) : null,
  );
  const valueText = formatBadgeValue(entry?.format, badge.metric_value);
  const progress = badgeProgress(badge);
  const nextTierName = badge.tier < 4 ? tierName((badge.tier || 0) + 1) : null;
  const issueNumber = currentBadgeIssueNumber(badge, entry, tName);
  const formattedIssueNumber = formatIssueNumber(issueNumber);
  const backLines = formattedIssueNumber
    ? [
        copy("achievements.modal.achieved_label"),
        copy("achievements.modal.issue_number", { number: formattedIssueNumber }),
        achievedDate || name,
      ]
    : [
        earned ? copy("achievements.modal.achieved_label") : copy("achievements.modal.locked"),
        earned ? valueText : "···",
        earned && achievedDate ? achievedDate : name,
      ];

  return (
    <div className="flex flex-col items-center px-6 pb-6 pt-5 text-center">
      <div className="flex w-full items-start justify-between gap-3">
        <div className="min-w-0 flex-1 text-left">
          <h2 className="truncate text-lg font-semibold tracking-tight text-oai-black dark:text-white">{name}</h2>
          <p className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {copy(badgeCopyKey(badge.id, "desc"))}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={copy("achievements.modal.close")}
          className="shrink-0 rounded-md p-1.5 text-oai-gray-400 transition-colors hover:bg-oai-gray-100 hover:text-oai-gray-700 dark:hover:bg-oai-gray-900 dark:hover:text-oai-gray-200"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mt-5 mb-7">
        <Badge3DCoin
          badgeId={badge.id}
          tier={badge.tier}
          locked={!earned}
          backLines={backLines}
          label={copy("achievements.modal.coin_aria", { name })}
        />
      </div>

      <div className="flex items-center gap-2">
        {/* Same metallic ramp as the tier-history segments — one visual
            language for "tier" everywhere in this dialog. */}
        <span
          className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
          style={
            earned
              ? {
                  background: `linear-gradient(120deg, ${TIER_PALETTE[tName].rim[0]} 0%, ${TIER_PALETTE[tName].ring} 55%, ${TIER_PALETTE[tName].rim[1]} 100%)`,
                  color: TIER_PALETTE[tName].glyph,
                  textShadow: "0 1px 0 rgba(255,255,255,0.35)",
                  boxShadow: "inset 0 1px 1px rgba(255,255,255,0.4), 0 0 0 1px rgba(10,15,12,0.06)",
                }
              : { background: "rgba(128,134,130,0.75)", color: "rgba(250,250,250,0.95)" }
          }
        >
          {earned ? copy(`achievements.tier.${tName}`) : copy("achievements.modal.locked")}
        </span>
        {earned && achievedDate ? (
          <span className="text-xs tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
            {achievedDate}
          </span>
        ) : null}
      </div>

      <dl className="mt-5 w-full space-y-3 border-t border-oai-gray-200/70 pt-4 text-left dark:border-oai-gray-800/60">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <dt className="text-oai-gray-500 dark:text-oai-gray-400">{copy("achievements.modal.value_label")}</dt>
          <dd className="font-mono font-semibold tabular-nums text-oai-black dark:text-white">{valueText}</dd>
        </div>
        <div>
          <div className="flex items-baseline justify-between gap-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
            <span>
              {badge.tier >= 4
                ? copy("achievements.modal.max_tier")
                : copy("achievements.modal.progress_to_next", {
                    tier: copy(`achievements.tier.${nextTierName}`),
                  })}
            </span>
            {badge.tier < 4 && badge.next_threshold != null ? (
              <span className="font-mono tabular-nums">
                {/* rank counts DOWN toward the next tier — an arrow reads as
                    direction, "/" would read as a fraction */}
                {valueText} {badge.lower_is_better ? "→" : "/"}{" "}
                {formatBadgeValue(entry?.format, badge.next_threshold)}
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-oai-gray-200 dark:bg-oai-gray-800">
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{
                width: `${Math.round((badge.tier >= 4 ? 1 : progress) * 100)}%`,
                background: earned
                  ? `linear-gradient(90deg, ${TIER_PALETTE[tName].rim[0]} 0%, ${TIER_PALETTE[tName].ring} 55%, ${TIER_PALETTE[tName].rim[1]} 100%)`
                  : "rgba(128,134,130,0.75)",
                boxShadow: earned ? "inset 0 1px 1px rgba(255,255,255,0.35)" : undefined,
              }}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          <span>{copy("achievements.modal.tier_history")}</span>
          <TierTrack badge={badge} />
        </div>
      </dl>
    </div>
  );
}

const POPUP_CLASS = cn(
  "relative w-full max-w-[380px] flex flex-col",
  "rounded-2xl bg-white dark:bg-oai-gray-950",
  "shadow-[0_20px_60px_-20px_rgba(0,0,0,0.25)] dark:shadow-[0_20px_60px_-10px_rgba(0,0,0,0.65)]",
  "ring-1 ring-oai-gray-200 dark:ring-oai-gray-800 overflow-hidden",
  "dark:border-t dark:border-white/[0.08]",
);

/**
 * Badge detail dialog with the rotatable 3D coin.
 *
 * Web/macOS: base-ui Dialog portaled to <body> — REQUIRED because the opener
 * may live inside the profile modal's `cost-modal-popup`, whose transform
 * would otherwise turn a fixed overlay into a clipped, popup-relative box.
 * z-[110]/z-[120] stack above the profile modal (z-100/z-[101]).
 *
 * Windows WebView2: body portals with position:fixed break the transparent
 * composition (see TrendMonitorZoomModal), so render inline. Inside the
 * profile popup the transformed ancestor then bounds the overlay to the
 * popup box — acceptable there; on the achievements page it covers the
 * viewport.
 */
export function BadgeDetailModal({ badge, onClose }) {
  const inline = isNativeWindowsApp();
  const isOpen = Boolean(badge);

  useEffect(() => {
    if (!inline || !isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inline, isOpen, onClose]);

  if (!isOpen) return null;

  if (inline) {
    return (
      <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
        <div
          className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
          onClick={onClose}
          aria-hidden
        />
        <div className={POPUP_CLASS}>
          <BadgeDetailBody badge={badge} onClose={onClose} />
        </div>
      </div>
    );
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="cost-modal-backdrop z-[110]" />
        <Dialog.Viewport className="fixed inset-0 z-[120] flex items-center justify-center p-4">
          <Dialog.Popup className={cn("cost-modal-popup", POPUP_CLASS)}>
            <Dialog.Title render={<h2 className="sr-only" />}>
              {copy(badgeCopyKey(badge.id, "name"))}
            </Dialog.Title>
            <BadgeDetailBody badge={badge} onClose={onClose} />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default BadgeDetailModal;
