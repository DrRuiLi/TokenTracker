import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copy } from "../lib/copy";
import { TrccPage } from "./TrccPage.jsx";

function stateBody(overrides = {}) {
  return {
    api_version: 1,
    preview_seq: 3,
    status: {
      connected: true, pm: 17, sub: 5, size: [960, 320], push_fps: 1.0, render_ms: 42,
      pushing: true, cursor_busy: false, cursor_ok: 1767225600, cursor_error: null,
      sensor_source: "lhm", sensor_label: "内置传感器", sensor_embedded: "运行中", admin: false,
      ...overrides.status,
    },
    settings: {
      rotation: 0, mirror: false, render_interval: 1, sensor_interval: 2, cursor_refresh: 90,
      close_action: "ask", autostart: true, colors: { cpu: "#1e90ff", text: "#ffffff" },
      ...overrides.settings,
    },
    app: { title: "t", tray: true, window_visible: false, api_port: 17691, can_elevate: true },
    meta: {
      rotations: [0, 90, 180, 270],
      ranges: { render_interval: [0.2, 10, 0.2], sensor_interval: [0.5, 60, 0.5], cursor_refresh: [30, 3600, 30] },
      close_actions: [{ id: "ask", label: "每次询问" }, { id: "tray", label: "最小化到托盘" }, { id: "exit", label: "退出程序" }],
      color_groups: [{ label: "系统指标", items: [{ key: "cpu", label: "CPU" }] }],
    },
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("TrccPage", () => {
  it("shows the offline card with a port field when the app is not running", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    render(<TrccPage />);
    expect(await screen.findByText(copy("trcc.offline.title"))).toBeInTheDocument();
    const port = screen.getByLabelText(copy("trcc.offline.port"));
    fireEvent.change(port, { target: { value: "18000" } });
    fireEvent.click(screen.getByRole("button", { name: copy("trcc.offline.retry") }));
    await waitFor(() => {
      expect(fetch.mock.calls.some(([url]) => String(url).startsWith("http://127.0.0.1:18000/api/state"))).toBe(true);
    });
    expect(window.localStorage.getItem("tt.trcc.port")).toBe("18000");
  });

  it("renders status and preview, and posts setting changes", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (init?.method === "POST" && String(url).endsWith("/api/settings")) {
        const patch = JSON.parse(init.body);
        return jsonResponse({ settings: { ...stateBody().settings, ...patch } });
      }
      return jsonResponse(stateBody());
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TrccPage />);

    expect(await screen.findByText("PM=17 SUB=5 · 960×320 · 1.0 fps")).toBeInTheDocument();
    expect(screen.getByText("内置传感器")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: copy("trcc.preview.title") }).getAttribute("src"))
      .toBe("http://127.0.0.1:17691/api/preview.png?seq=3");
    expect(screen.getByRole("button", { name: copy("trcc.admin.relaunch") })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "90°" }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post).toBeTruthy();
      expect(post[0]).toBe("http://127.0.0.1:17691/api/settings");
      expect(JSON.parse(post[1].body)).toEqual({ rotation: 90 });
    });
  });

  it("toggles pushing through /api/push", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (String(url).endsWith("/api/push")) return jsonResponse({ pushing: JSON.parse(init.body).on });
      return jsonResponse(stateBody());
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TrccPage />);
    const toggle = await screen.findByRole("switch", { name: copy("trcc.push.label") });
    fireEvent.click(toggle);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/push"));
      expect(call && JSON.parse(call[1].body)).toEqual({ on: false });
    });
  });
});
