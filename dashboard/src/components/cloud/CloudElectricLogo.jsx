import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTheme } from "../../hooks/useTheme.js";
import { Hub } from "@lucasmarkes/hairline/react";

// Decorative WebGL is loaded only while the desktop artwork can actually be seen.
export function CloudElectricLogo() {
  const rootRef = useRef(null);
  const { resolvedTheme } = useTheme();
  const [active, setActive] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [Component, setComponent] = useState(null);
  const [palette, setPalette] = useState(null);

  useLayoutEffect(() => {
    const style = getComputedStyle(rootRef.current);
    setPalette({
      color: style.getPropertyValue("--tt-electric-core").trim(),
      glowColor: style.getPropertyValue("--tt-electric-glow").trim(),
    });
  }, [resolvedTheme]);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let inView = false;
    const update = () => {
      setReducedMotion(motion.matches);
      setActive(inView && !document.hidden && !motion.matches && resolvedTheme === "dark");
    };
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
      update();
    });
    observer.observe(rootRef.current);
    motion.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [resolvedTheme]);

  useEffect(() => {
    if (!active || Component || resolvedTheme !== "dark") return;
    let alive = true;
    import("../../../vendor/react-bits/ElectricLogo.jsx")
      .then(({ default: Logo }) => { if (alive) setComponent(() => Logo); })
      .catch(() => { /* Optional decoration stays hidden if this chunk cannot load. */ });
    return () => { alive = false; };
  }, [active, Component, resolvedTheme]);

  let artwork = null;
  if (resolvedTheme === "light") {
    artwork = <Hub className="tt-cloud-figure pointer-events-auto w-full translate-x-8" intensity={0.4} play tabIndex={-1} />;
  } else if (reducedMotion) {
    artwork = <span className="tt-cloud-electric-static" />;
  } else if (active && Component && palette) {
    artwork = <Component src="/token-tracker-bolt.svg" {...palette} theme={resolvedTheme}
          scale={0.72} intensity={1.25} glow={1.4} thickness={1.6} strands={4}
          bend={0.6} crackle={1.3} arcs={1.2} flicker={0.28} fill={0}
          speed={2.1} interactive cursorIntensity={0.85} cursorRadius={90} />;
  }
  return (
    <div ref={rootRef} className={`tt-cloud-electric is-${resolvedTheme}`} aria-hidden="true">
      {artwork}
    </div>
  );
}
