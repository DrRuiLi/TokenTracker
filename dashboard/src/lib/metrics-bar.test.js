import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLUMN_ORDER,
  moveMetric,
  normalizeColumnOrder,
  reorderMetrics,
  toggleMetric,
} from "./metrics-bar.js";

const base = {
  columns: [...DEFAULT_COLUMN_ORDER],
  columnOrder: [...DEFAULT_COLUMN_ORDER],
};

describe("metrics bar order", () => {
  it("fills a missing order with the taskbar default", () => {
    expect(normalizeColumnOrder(undefined)).toEqual(DEFAULT_COLUMN_ORDER);
    expect(normalizeColumnOrder(["dl", "up", "nope", "dl"])).toEqual([
      "dl", "up",
      ...DEFAULT_COLUMN_ORDER.filter((id) => id !== "dl" && id !== "up"),
    ]);
  });

  it("moves one metric and keeps the visible list in that order", () => {
    const next = moveMetric(base, 0, 1);
    expect(next.columnOrder.slice(0, 3)).toEqual(["temp", "cpu", "power"]);
    expect(next.columns.slice(0, 3)).toEqual(["temp", "cpu", "power"]);
  });

  it("drops a hidden metric without forgetting its place", () => {
    const hidden = toggleMetric(base, "power");
    expect(hidden.columnOrder[2]).toBe("power");
    expect(hidden.columns).not.toContain("power");
    const shown = toggleMetric(hidden, "power");
    expect(shown.columns[2]).toBe("power");
  });

  it("keeps the last visible metric on", () => {
    const only = { ...base, columns: ["cpu"] };
    expect(toggleMetric(only, "cpu")).toBe(only);
  });

  it("reorders by dragging one row onto another", () => {
    const next = reorderMetrics(base, "dl", "cpu");
    expect(next.columnOrder[0]).toBe("dl");
    expect(next.columnOrder.at(-1)).toBe("up");
  });
});
