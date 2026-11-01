import { describe, expect, it } from "vitest";
import { currentBadgeIssueNumber, formatIssueNumber } from "./BadgeDetailModal.jsx";

describe("achievement issue numbers", () => {
  it("formats issue numbers as six-digit mint numbers", () => {
    expect(formatIssueNumber(27)).toBe("000027");
    expect(formatIssueNumber(1_234_567)).toBe("1234567");
    expect(formatIssueNumber(0)).toBeNull();
    expect(formatIssueNumber("not-a-number")).toBeNull();
  });

  it("selects the current cloud tier and rejects local badge serials", () => {
    const badge = { serials: { bronze: 91, silver: 27 } };
    expect(currentBadgeIssueNumber(badge, { scope: "cloud" }, "silver")).toBe(27);
    expect(currentBadgeIssueNumber(badge, { scope: "local" }, "silver")).toBeNull();
    expect(currentBadgeIssueNumber({}, { scope: "cloud" }, "silver")).toBeNull();
  });
});
