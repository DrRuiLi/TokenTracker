import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { copy } from "../../../lib/copy";
import { UsageOverview } from "./UsageOverview.jsx";

vi.mock("./ContextBreakdownPanel.jsx", () => ({ ContextBreakdownPanel: () => null }));
vi.mock("../../../hooks/useTheme.js", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

it("explains Kiro CLI estimates in its provider and combined views without relabeling other providers", async () => {
  const user = userEvent.setup();
  render(
    <UsageOverview
      period="day"
      periods={["day"]}
      summaryLabel="Total"
      summaryValue="150"
      fleetData={[
        {
          source: "kiro", label: "KIRO", totalPercent: "66.7", usage: 100, usd: 0.2,
          models: [{ id: "kiro-cli-agent", name: "kiro-cli-agent", share: 100, usage: 100, cost: 0.2 }],
        },
        {
          source: "codex", label: "CODEX", totalPercent: "33.3", usage: 50, usd: 0.1,
          models: [{ id: "gpt-5.6", name: "gpt-5.6", share: 100, usage: 50, cost: 0.1 }],
        },
      ]}
    />,
  );

  const notice = copy("usage.overview.kiro_notice_body");
  expect(screen.queryByText(notice)).toBeNull();
  await act(async () => { await user.click(screen.getByRole("button", { name: /KIRO:/i })); });
  expect(screen.getByText(notice)).toBeVisible();
  await act(async () => { await user.click(screen.getByRole("button", { name: /CODEX:/i })); });
  expect(screen.queryByText(notice)).toBeNull();
  await act(async () => { await user.click(screen.getByRole("button", { name: /All tools:/i })); });
  expect(screen.getByText(notice)).toBeVisible();
  expect(notice).not.toMatch(/^usage\.overview\./);
});
