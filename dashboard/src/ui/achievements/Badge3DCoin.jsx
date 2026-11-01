import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import React, { useEffect, useRef } from "react";
import { AchievementBadge } from "./AchievementBadge";
import { BADGE_BY_ID } from "./badge-catalog";
import { paletteForTier } from "./tier-palette";

const COIN_THICKNESS = 8; // px between front and back face planes

/**
 * Draggable 3D badge coin (pure CSS 3D transforms — no WebGL).
 *
 * - Horizontal pointer drag rotates around the Y axis 1:1; vertical swipes
 *   still scroll (touch-action: pan-y is the load-bearing line for mobile).
 * - Release launches a flick spring whose target snaps to the nearest face
 *   (multiples of 180°), so the coin always settles readable.
 * - Back face carries the engraved achievement facts (backLines).
 * - Reduced motion: no idle sway; release settles with a short tween. The
 *   drag itself stays — it is user-driven, not decorative.
 */
export function Badge3DCoin({ badgeId, tier, locked = false, size = 176, backLines = [], label }) {
  const rotY = useMotionValue(0);
  const reducedMotion = useReducedMotion();
  const dragRef = useRef(null);
  const animRef = useRef(null);
  const interactedRef = useRef(false);
  const palette = paletteForTier(tier, locked);
  const BackGlyph = BADGE_BY_ID.get(badgeId)?.icon || null;

  // Sheen tracks rotation so light appears to travel across the metal. The
  // back face is pre-rotated 180°, so its sheen sweeps the opposite way — the
  // light source stays fixed in the room while the coin turns through it.
  const sheenX = useTransform(rotY, (r) => {
    const norm = ((r % 360) + 360) % 360;
    return `${(norm / 360) * 160 - 80}%`;
  });
  const sheenXBack = useTransform(rotY, (r) => {
    const norm = ((r % 360) + 360) % 360;
    return `${80 - (norm / 360) * 160}%`;
  });
  // Faces fall into shadow as they turn away from the key light (edge-on =
  // darkest). The dead zone below ~20° keeps the resting/idle-sway coin at
  // full brightness — shading only kicks in on a real turn.
  const faceShade = useTransform(rotY, (r) => {
    const t = Math.abs(Math.sin((r * Math.PI) / 180));
    return Math.max(0, (t - 0.35) / 0.65) * 0.3;
  });

  const stopAnim = () => {
    animRef.current?.stop?.();
    animRef.current = null;
  };

  useEffect(() => {
    if (reducedMotion || interactedRef.current) return undefined;
    let cancelled = false;
    // Entrance: one full spin on open — the coin announces itself as a 3D
    // object you can grab. Then a visible idle sway keeps the affordance
    // alive. Both cancelled forever on the first touch.
    rotY.set(-360);
    const entrance = animate(rotY, 0, { duration: 0.9, ease: [0.16, 1, 0.3, 1] });
    animRef.current = entrance;
    entrance.then(() => {
      if (cancelled || interactedRef.current) return;
      animRef.current = animate(rotY, [0, -14, 14, 0], {
        duration: 4.5,
        repeat: Infinity,
        ease: "easeInOut",
      });
    });
    return () => {
      cancelled = true;
      stopAnim();
    };
  }, [reducedMotion, rotY]);

  const settle = (velocity) => {
    const current = rotY.get();
    if (reducedMotion) {
      const nearest = Math.round(current / 180) * 180;
      animRef.current = animate(rotY, nearest, { duration: 0.2, ease: "easeOut" });
      return;
    }
    // Flick: project an inertia-style target from the release velocity, then
    // snap it to the nearest face so the coin never rests edge-on.
    const projected = current + velocity * 0.35;
    const target = Math.round(projected / 180) * 180;
    animRef.current = animate(rotY, target, {
      type: "spring",
      velocity,
      stiffness: 58,
      damping: 13.5,
      mass: 1,
    });
  };

  const onPointerDown = (e) => {
    interactedRef.current = true;
    stopAnim();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startRot: rotY.get(),
      samples: [{ t: e.timeStamp, x: e.clientX }],
    };
  };

  const onPointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    rotY.set(drag.startRot + (e.clientX - drag.startX) * 0.55);
    drag.samples.push({ t: e.timeStamp, x: e.clientX });
    if (drag.samples.length > 5) drag.samples.shift();
  };

  const onPointerEnd = (e) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    const first = drag.samples[0];
    const last = drag.samples[drag.samples.length - 1];
    const dt = last.t - first.t;
    const velocity = dt > 0 ? ((last.x - first.x) * 0.55 * 1000) / dt : 0; // deg/s
    settle(velocity);
  };

  const onKeyDown = (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    interactedRef.current = true;
    stopAnim();
    const delta = e.key === "ArrowRight" ? 30 : -30;
    animRef.current = animate(rotY, rotY.get() + delta, { duration: 0.15, ease: "easeOut" });
  };

  const faceStyle = {
    backfaceVisibility: "hidden",
    WebkitBackfaceVisibility: "hidden",
  };

  return (
    <div
      role="img"
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
      className="inline-flex cursor-grab select-none items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/60 rounded-full active:cursor-grabbing"
      style={{ perspective: 900, touchAction: "pan-y" }}
    >
      <div className="relative" style={{ transform: "rotateX(-8deg)", transformStyle: "preserve-3d" }}>
        <motion.div
          className="relative"
          style={{ rotateY: rotY, transformStyle: "preserve-3d", width: size, height: size }}
        >
          {/* coin edge: stacked rings between the two face planes */}
          {[-3, -1.5, 0, 1.5, 3].map((z) => (
            <div
              key={z}
              aria-hidden
              className="absolute inset-0 rounded-full"
              style={{ transform: `translateZ(${z}px)`, background: palette.rim[1] }}
            />
          ))}
          {/* front face */}
          <div
            className="absolute inset-0 overflow-hidden rounded-full"
            style={{ ...faceStyle, transform: `translateZ(${COIN_THICKNESS / 2}px)` }}
          >
            <AchievementBadge
              badgeId={badgeId}
              tier={tier}
              locked={locked}
              size="fill"
              className="brightness-105 saturate-[1.08]"
            />
            {/* static studio lighting: strong top-left key light, faint top
                gloss, only a whisper of lower falloff (heavier darks made the
                whole coin read dim) */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                background:
                  "radial-gradient(circle at 30% 20%, rgba(255,255,255,0.45), rgba(255,255,255,0) 42%), linear-gradient(172deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 38%, rgba(0,0,0,0.08) 100%)",
                boxShadow:
                  "inset 0 3px 7px rgba(255,255,255,0.5), inset 0 -3px 8px rgba(0,0,0,0.15)",
              }}
            />
            <motion.div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                x: sheenX,
                background:
                  "linear-gradient(105deg, transparent 34%, rgba(255,255,255,0.5) 50%, transparent 66%)",
              }}
            />
            <motion.div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{ opacity: faceShade, background: "rgba(8, 12, 10, 0.9)" }}
            />
          </div>
          {/* back face: minted reverse — machined texture, embossed emblem
              watermark, engraved facts, mirrored studio lighting */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 overflow-hidden rounded-full px-6 text-center"
            style={{
              ...faceStyle,
              transform: `rotateY(180deg) translateZ(${COIN_THICKNESS / 2}px)`,
              background: `linear-gradient(145deg, ${palette.face[0]}, ${palette.face[1]})`,
              boxShadow: `inset 0 0 0 6px ${palette.rim[1]}, inset 0 0 0 7.5px rgba(255,255,255,0.22), inset 0 3px 7px rgba(255,255,255,0.4), inset 0 -4px 12px rgba(0,0,0,0.22)`,
            }}
          >
            {/* radial machining lines, like a lathe-finished coin reverse */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                background:
                  "repeating-radial-gradient(circle at 50% 50%, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 1px, transparent 1px, transparent 4px)",
              }}
            />
            {/* embossed emblem watermark behind the engraving */}
            {BackGlyph ? (
              <BackGlyph
                aria-hidden
                size={Math.round(size * 0.62)}
                strokeWidth={1.1}
                color={palette.glyph}
                className="pointer-events-none absolute opacity-[0.13]"
                style={{
                  filter:
                    "drop-shadow(0 1px 0 rgba(255,255,255,0.3)) drop-shadow(0 -1px 0 rgba(0,0,0,0.35))",
                }}
              />
            ) : null}
            {/* mirrored key light (the room light stays top-left, the face is
                flipped, so the hot spot lands top-right) */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                background:
                  "radial-gradient(circle at 70% 20%, rgba(255,255,255,0.4), rgba(255,255,255,0) 44%), linear-gradient(188deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0) 38%, rgba(0,0,0,0.10) 100%)",
              }}
            />
            {backLines.map((line, index) => (
              <div
                key={`${index}-${line}`}
                className={`font-mono tabular-nums ${index === 0 ? "text-[10px] uppercase tracking-[0.18em]" : index === 1 ? "text-lg font-bold" : "text-[11px]"}`}
                style={{
                  color: palette.glyph,
                  textShadow: "0 1px 0 rgba(255,255,255,0.28), 0 -1px 0 rgba(0,0,0,0.3)",
                }}
              >
                {line}
              </div>
            ))}
            {/* travelling sheen (opposite direction: fixed room light) */}
            <motion.div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                x: sheenXBack,
                background:
                  "linear-gradient(105deg, transparent 34%, rgba(255,255,255,0.45) 50%, transparent 66%)",
              }}
            />
            <motion.div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{ opacity: faceShade, background: "rgba(8, 12, 10, 0.9)" }}
            />
          </div>
        </motion.div>
        {/* ground shadow anchors the coin in space */}
        <div
          aria-hidden
          className="absolute left-1/2 h-3 w-3/5 rounded-[100%] bg-black/20 blur-md dark:bg-black/45"
          style={{ bottom: -20, transform: "translateX(-50%)" }}
        />
      </div>
    </div>
  );
}

export default Badge3DCoin;
