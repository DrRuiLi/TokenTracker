import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl.jsx";

it("supports arrow-key selection and roving tab focus", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <SegmentedControl
      ariaLabel="Session source"
      options={[
        { id: "all", label: "All" },
        { id: "claude", label: "Claude Code" },
        { id: "codex", label: "Codex" },
      ]}
      value="all"
      onChange={onChange}
    />,
  );

  const all = screen.getByRole("tab", { name: "All" });
  const claude = screen.getByRole("tab", { name: "Claude Code" });
  expect(all).toHaveAttribute("tabindex", "0");
  expect(claude).toHaveAttribute("tabindex", "-1");

  fireEvent.keyDown(all, { key: "ArrowRight" });
  expect(onChange).toHaveBeenCalledWith("claude");

  rerender(
    <SegmentedControl
      ariaLabel="Session source"
      options={[
        { id: "all", label: "All" },
        { id: "claude", label: "Claude Code" },
        { id: "codex", label: "Codex" },
      ]}
      value="claude"
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("tab", { name: "Claude Code" })).toHaveAttribute("tabindex", "0");
});
