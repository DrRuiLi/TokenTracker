import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../../lib/copy";
import { DEFAULT_COLUMN_ORDER } from "../../lib/metrics-bar.js";
import { MetricsBarSection } from "./MetricsBarSection.jsx";

vi.mock("../../lib/native-bridge", () => ({
  isNativeWindowsApp: () => true,
}));

function postedSettings() {
  const calls = window.chrome.webview.postMessage.mock.calls.map(([body]) => JSON.parse(body));
  return calls.filter((message) => message.type === "metrics_bar_settings").at(-1)?.settings;
}

describe("MetricsBarSection", () => {
  beforeEach(() => {
    window.chrome = { webview: { postMessage: vi.fn() } };
  });

  it("saves a hidden metric and a new order", () => {
    render(<MetricsBarSection trccPort={17691} />);
    act(() => {
      window.dispatchEvent(new CustomEvent("tokentracker:metrics-bar-settings", {
        detail: {
          Enabled: true,
          Columns: [...DEFAULT_COLUMN_ORDER],
          ColumnOrder: [...DEFAULT_COLUMN_ORDER],
        },
      }));
    });

    fireEvent.click(screen.getByRole("switch", { name: copy("metrics_bar.col.power") }));
    let saved = postedSettings();
    expect(saved.Columns).not.toContain("power");
    expect(saved.ColumnOrder[2]).toBe("power");

    fireEvent.click(screen.getByRole("button", {
      name: copy("metrics_bar.move_down", { name: copy("metrics_bar.col.cpu") }),
    }));
    saved = postedSettings();
    expect(saved.ColumnOrder.slice(0, 3)).toEqual(["temp", "cpu", "power"]);
    expect(saved.Columns.slice(0, 2)).toEqual(["temp", "cpu"]);
  });
});
