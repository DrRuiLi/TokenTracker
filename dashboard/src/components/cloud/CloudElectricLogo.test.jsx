import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudElectricLogo } from "./CloudElectricLogo.jsx";

const state = vi.hoisted(() => ({ theme: "dark", mounts: 0, unmounts: 0 }));
vi.mock("../../hooks/useTheme.js", () => ({ useTheme: () => ({ resolvedTheme: state.theme }) }));
vi.mock("@lucasmarkes/hairline/react", () => ({ Hub: () => <svg data-testid="original-hub" /> }));
vi.mock("../../../vendor/react-bits/ElectricLogo.jsx", async () => {
  const { useEffect } = await import("react");
  return { default: function Logo() {
    useEffect(() => { state.mounts++; return () => { state.unmounts++; }; }, []);
    return <canvas data-testid="electric-canvas" />;
  } };
});

let observers;
let motion;
let hidden;
beforeEach(() => {
  state.theme = "dark";
  state.mounts = state.unmounts = 0;
  hidden = false;
  observers = [];
  motion = new EventTarget();
  motion.matches = false;
  vi.stubGlobal("matchMedia", () => motion);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback) { this.callback = callback; this.disconnect = vi.fn(); observers.push(this); }
    observe() {}
  });
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const intersect = (visible = true) => act(() => observers.at(-1).callback([{ isIntersecting: visible, intersectionRect: { width: visible ? 300 : 0, height: visible ? 150 : 0 } }]));

it("keeps the original figure in light mode without mounting the GPU renderer", async () => {
  state.theme = "light";
  const view = render(<CloudElectricLogo />);
  intersect();
  expect(view.getByTestId("original-hub")).toBeTruthy();
  expect(view.queryByTestId("electric-canvas")).toBeNull();
  expect(state.mounts).toBe(0);
});

it("does not mount WebGL for hidden artwork, and releases it offscreen and on theme changes", async () => {
  const view = render(<CloudElectricLogo />);
  expect(view.container.querySelector(".tt-cloud-electric").childElementCount).toBe(0);
  intersect(false);
  expect(state.mounts).toBe(0);
  expect(view.container.querySelector(".tt-cloud-electric").childElementCount).toBe(0);
  intersect();
  await waitFor(() => expect(state.mounts).toBe(1));
  intersect(false);
  expect(state.unmounts).toBe(1);
  expect(view.container.querySelector(".tt-cloud-electric").childElementCount).toBe(0);
  intersect();
  await waitFor(() => { expect(state.mounts).toBe(2); });
  state.theme = "light";
  view.rerender(<CloudElectricLogo />);
  expect(state.unmounts).toBe(2);
  expect(view.getByTestId("original-hub")).toBeTruthy();
});

it("reacts to reduced-motion and document visibility changes without retaining a renderer", async () => {
  motion.matches = true;
  const view = render(<CloudElectricLogo />);
  intersect();
  expect(state.mounts).toBe(0);
  expect(view.container.querySelector(".tt-cloud-electric-static")).toBeTruthy();
  act(() => { motion.matches = false; motion.dispatchEvent(new Event("change")); });
  await waitFor(() => expect(state.mounts).toBe(1));
  act(() => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
  expect(state.unmounts).toBe(1);
  act(() => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
  await waitFor(() => expect(state.mounts).toBe(2));
  view.unmount();
  expect(state.unmounts).toBe(2);
  expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
});
