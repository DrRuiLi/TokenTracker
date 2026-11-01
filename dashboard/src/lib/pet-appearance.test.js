import { describe, expect, it } from "vitest";
import { CLAWD_VISUAL_SCALE, petVisualScale } from "./pet-appearance.js";

describe("petVisualScale", () => {
  it("normalizes tightly cropped Clawd without shrinking atlas pets", () => {
    expect(CLAWD_VISUAL_SCALE).toBe(0.84);
    expect(petVisualScale("clawd")).toBe(0.84);
    expect(petVisualScale("sprout")).toBe(1);
    expect(petVisualScale("byte")).toBe(1);
    expect(petVisualScale("ember")).toBe(1);
  });
});
