import { describe, expect, it } from "vitest";
import { cloudBadgesSettled, resolveCloudBadgeIdentity } from "./AchievementsPage.jsx";

describe("resolveCloudBadgeIdentity", () => {
  it("treats mock mode as a settled signed-in cloud identity", () => {
    expect(
      resolveCloudBadgeIdentity({
        authLoading: true,
        authEnabled: false,
        authUserId: null,
        mockEnabled: true,
      }),
    ).toEqual({ authLoading: false, signedIn: true, userId: "mock-user" });
  });

  it("keeps real auth semantics outside mock mode", () => {
    expect(
      resolveCloudBadgeIdentity({
        authLoading: false,
        authEnabled: true,
        authUserId: "real-user",
        mockEnabled: false,
      }),
    ).toEqual({ authLoading: false, signedIn: true, userId: "real-user" });
  });
});

describe("cloudBadgesSettled", () => {
  it("keeps the wall hidden while auth is hydrating", () => {
    expect(
      cloudBadgesSettled({
        authLoading: true,
        signedIn: false,
        userId: null,
        state: { status: "signed-out", userId: null },
      }),
    ).toBe(false);
  });

  it("keeps the wall hidden when a signed-in user has not settled", () => {
    expect(
      cloudBadgesSettled({
        authLoading: false,
        signedIn: true,
        userId: "new-user",
        state: { status: "signed-out", userId: null },
      }),
    ).toBe(false);
    expect(
      cloudBadgesSettled({
        authLoading: false,
        signedIn: true,
        userId: "new-user",
        state: { status: "ready", userId: "previous-user" },
      }),
    ).toBe(false);
  });

  it("reveals once the current user's request succeeds or fails", () => {
    for (const status of ["ready", "error"]) {
      expect(
        cloudBadgesSettled({
          authLoading: false,
          signedIn: true,
          userId: "current-user",
          state: { status, userId: "current-user" },
        }),
      ).toBe(true);
    }
  });
});
