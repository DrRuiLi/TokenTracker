import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudRebuildControl, CloudSyncRow } from "./CloudSection.jsx";
const state = vi.hoisted(() => ({ rebuild: vi.fn(), official: true, prompt: {} }));
vi.mock("../../lib/cloud-sync", () => ({ rebuildCloudDeviceUsage: (...args) => state.rebuild(...args) }));
vi.mock("../../lib/copy", () => ({ copy: key => key }));
vi.mock("../../lib/insforge-config", () => ({ isOfficialInsforgeInstance: () => state.official }));
vi.mock("../../lib/cloud-prompt-policy.js", () => ({ readCloudPromptState: () => state.prompt, clearCloudPromptIntent: vi.fn(), recordCloudPromptIntent: vi.fn() }));
vi.mock("../cloud/CloudContextualPrompt.jsx", () => ({ CloudContextualPrompt: () => null }));
vi.mock("../cloud/CloudMembershipCard.jsx", () => ({ CloudMembershipCard: () => null }));
vi.mock("./useAccountProfileSettings.js", () => ({ useAccountProfileSettings: () => ({}) }));
const settings = { userId: "owner-a", cloudSyncOn: true, cloudSyncPending: false, getAccessToken: async () => "jwt" };
beforeEach(() => { state.rebuild.mockReset(); state.official = true; state.prompt = {}; });
afterEach(cleanup);
async function confirm() { fireEvent.click(screen.getByRole("button", { name: "cloud.rebuild.action" })); const dialog = await screen.findByRole("dialog"); await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "cloud.rebuild.action" }))); }
it("requires confirmation and never reports complete while the queue remains pending", async () => {
  state.rebuild.mockResolvedValue({ pending: true });
  render(<CloudRebuildControl settings={settings} />);
  expect(state.rebuild).not.toHaveBeenCalled();
  await confirm();
  expect(state.rebuild).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("cloud.rebuild.pending");
  expect(screen.queryByText("cloud.rebuild.complete")).not.toBeInTheDocument();
});
it("blocks duplicate confirmation and ignores delayed completion after switching accounts", async () => {
  let release;
  state.rebuild.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const view = render(<CloudRebuildControl settings={settings} />);
  await confirm();
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "cloud.rebuild.action" })).toBeDisabled();
  expect(state.rebuild).toHaveBeenCalledTimes(1);
  view.rerender(<CloudRebuildControl settings={{ ...settings, userId: "owner-b" }} />);
  await act(async () => release({ pending: false }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("keeps a failed reset open for retry and reports complete only after the bridge confirms it", async () => {
  state.rebuild.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "cloud_usage_reset_sync_busy" })).mockResolvedValueOnce({ pending: false });
  render(<CloudRebuildControl settings={settings} />);
  await confirm();
  expect(screen.getByRole("alert")).toHaveTextContent("cloud.rebuild.busy");
  await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "cloud.rebuild.action" })));
  expect(screen.getByRole("status")).toHaveTextContent("cloud.rebuild.complete");
});
it("offers hosted rebuild only on the official instance", () => {
  state.official = false;
  const view = render(<CloudSyncRow settings={settings} />);
  expect(screen.queryByRole("button", { name: "cloud.rebuild.action" })).not.toBeInTheDocument();
  state.official = true; state.prompt = { membership: { hosting_mode: "self_hosted" } };
  view.rerender(<CloudSyncRow settings={settings} />);
  expect(screen.queryByRole("button", { name: "cloud.rebuild.action" })).not.toBeInTheDocument();
  state.prompt = { membership: { hosting_mode: "hosted" } };
  view.rerender(<CloudSyncRow settings={settings} />);
  expect(screen.getByRole("button", { name: "cloud.rebuild.action" })).toBeEnabled();
});
