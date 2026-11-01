import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// Regression guard for issue #360 (dashboard infinite usage-refresh loop).
//
// Root cause: DashboardPage passes its `daily` array to useTrendData as
// `sharedRows`. `daily` is re-created on every fetch, so if `useTrendData`'s
// `refresh` identity tracked `sharedRows`, `refreshTrend` (and therefore the
// aggregate `refreshUsageStats`) would change on every render — which the
// local-reload effect re-fired into an unbounded refetch loop.
//
// This test pins `refresh` to a STABLE identity across new `sharedRows`
// references, so the loop cannot come back.

vi.mock("../lib/api", () => {
  const PAYLOAD = { data: [], totals: {}, rolling: {} };
  const reg = new Map();
  const make = (name: string) => {
    if (!reg.has(name)) reg.set(name, vi.fn(() => Promise.resolve(PAYLOAD)));
    return reg.get(name);
  };
  return new Proxy(
    {},
    {
      get: (_t, p) => {
        if (typeof p === "symbol") return undefined;
        // Never look like a thenable module or ESM import() hangs awaiting it.
        if (p === "then" || p === "catch" || p === "finally" || p === "__esModule") return undefined;
        return make(p as string);
      },
    },
  );
});

import { useTrendData } from "./use-trend-data";

describe("useTrendData — refresh identity stability (issue #360)", () => {
  beforeEach(() => localStorage.clear());

  it("keeps refresh() stable when a shared `daily` array is replaced by a new reference", () => {
    const identities: Array<() => unknown> = [];
    function Probe({ daily }: { daily: any[] }) {
      const { refresh } = useTrendData({
        baseUrl: "http://127.0.0.1:7680",
        accessToken: null,
        period: "month",
        from: "2026-07-01",
        to: "2026-07-31",
        months: 24,
        cacheKey: "default",
        sharedRows: daily,
        sharedRange: { from: "2026-07-01", to: "2026-07-31" },
      });
      identities.push(refresh);
      return null;
    }

    // Same content, brand-new array reference each render — exactly what
    // useUsageData.setDaily(fillDailyGaps(...)) produces on every refresh.
    const { rerender } = render(<Probe daily={[{ day: "2026-07-01", total_tokens: 1 }]} />);
    rerender(<Probe daily={[{ day: "2026-07-01", total_tokens: 1 }]} />);
    rerender(<Probe daily={[{ day: "2026-07-01", total_tokens: 1 }]} />);

    // One stable identity regardless of how many times `daily` is re-created.
    expect(new Set(identities).size).toBe(1);
  });
});
