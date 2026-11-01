import { describe, expect, it, vi } from "vitest";

vi.mock("./gsap.js", () => ({
  gsap: { context: vi.fn() },
  ScrollTrigger: {},
}));

import { galaxyStageClassName } from "./HeroSection";

describe("HeroSection galaxy stage", () => {
  it("keeps the animated galaxy at viewport height until the desktop breakpoint", () => {
    const className = galaxyStageClassName(true);

    expect(className).toContain("bottom-0");
    expect(className).toContain("lg:bottom-[-40vh]");
    expect(className).not.toMatch(/(?:^|\s)bottom-\[-40vh\](?:\s|$)/);
  });
});
