import { describe, expect, it } from "vitest";
import { buildDailyBreakdownRange, selectDailyBreakdownRows } from "./daily-breakdown";

describe("daily breakdown history", () => {
  it("uses the selected 24-month range for total view", () => {
    expect(buildDailyBreakdownRange({
      period: "total",
      selectedFrom: "2024-08-01",
      selectedTo: "2026-07-16",
      todayKey: "2026-07-16",
    })).toEqual({ from: "2024-08-01", to: "2026-07-16" });
  });

  it("keeps the rolling 30-day window for non-total views", () => {
    expect(buildDailyBreakdownRange({
      period: "month",
      selectedFrom: "2026-07-01",
      selectedTo: "2026-07-31",
      todayKey: "2026-07-16",
    })).toEqual({ from: "2026-06-17", to: "2026-07-16" });
  });

  it("shows the latest observed days instead of empty calendar rows in total view", () => {
    const rows = [
      { day: "2026-05-08", total_tokens: 10, missing: false },
      { day: "2026-05-09", total_tokens: 20, missing: false },
      { day: "2026-07-15", total_tokens: null, missing: true },
      { day: "2026-07-16", total_tokens: null, missing: true },
    ];

    expect(selectDailyBreakdownRows(rows, { period: "total" })).toEqual(rows.slice(0, 2));
  });
});
