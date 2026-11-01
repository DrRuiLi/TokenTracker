import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ElectricLogo from "../../../vendor/react-bits/ElectricLogo.jsx";

const gpu = vi.hoisted(() => ({ mode: "ready", lose: vi.fn(), deleteTexture: vi.fn(), geometryRemove: vi.fn(), programRemove: vi.fn() }));
vi.mock("ogl", () => ({
  Renderer: class {
    constructor() {
      if (gpu.mode === "throw") throw new Error("WebGL unavailable");
      this.isWebgl2 = gpu.mode !== "legacy";
      this.gl = {
        canvas: document.createElement("canvas"), clearColor() {},
        getProgramParameter: () => gpu.mode !== "shader-failed",
        getExtension: () => ({ loseContext: gpu.lose }), deleteTexture: gpu.deleteTexture,
      };
    }
    setSize() {}
  },
  Texture: class { constructor() { this.texture = {}; } },
  Triangle: class { remove() { gpu.geometryRemove(); } },
  Program: class { constructor() { this.program = {}; } remove() { gpu.programRemove(); } },
  Mesh: class { constructor(gl, { geometry, program }) { this.geometry = geometry; this.program = program; } },
}));

let intersection;
let disconnects;
beforeEach(() => {
  vi.clearAllMocks();
  gpu.mode = "ready";
  disconnects = [];
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("ResizeObserver", class {
    constructor() { this.disconnect = vi.fn(); disconnects.push(this.disconnect); }
    observe() {}
  });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback) { intersection = callback; this.disconnect = vi.fn(); disconnects.push(this.disconnect); }
    observe() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["throw", "legacy", "shader-failed"])("leaves decoration empty when initialization fails (%s)", (mode) => {
  gpu.mode = mode;
  const { container } = render(<ElectricLogo src="/token-tracker-bolt.svg" />);
  expect(container.querySelector('[data-electric-state="loading"]')).toBeTruthy();
  expect(container.querySelector(".electric-logo-fallback")).toBeNull();
  expect(container.querySelector("canvas")).toBeNull();
  if (mode !== "throw") expect(gpu.lose).toHaveBeenCalledOnce();
});

it("stops after context loss and releases textures, geometry, program and observers on unmount", () => {
  const view = render(<ElectricLogo src="/token-tracker-bolt.svg" />);
  const canvas = view.container.querySelector("canvas");
  expect(view.container.querySelector('[data-electric-state="loading"]')).toBeTruthy();
  expect(view.container.querySelector(".electric-logo-fallback")).toBeNull();
  expect(requestAnimationFrame).toHaveBeenCalledOnce();
  fireEvent(canvas, new Event("webglcontextlost"));
  intersection([{ isIntersecting: true }]);
  expect(requestAnimationFrame).toHaveBeenCalledOnce();
  expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
  view.unmount();
  expect(canvas.isConnected).toBe(false);
  expect(gpu.deleteTexture).toHaveBeenCalledTimes(4);
  expect(gpu.geometryRemove).toHaveBeenCalledOnce();
  expect(gpu.programRemove).toHaveBeenCalledOnce();
  expect(gpu.lose).toHaveBeenCalledOnce();
  expect(disconnects).toHaveLength(2);
  disconnects.forEach((disconnect) => expect(disconnect).toHaveBeenCalledOnce());
});
