import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SearchableSelect } from "./SearchableSelect.jsx";

it("filters options and selects the matching project", () => {
  const onChange = vi.fn();
  render(
    <SearchableSelect
      options={[
        { value: "tokentracker", label: "tokentracker" },
        { value: "lumaradio", label: "lumaradio" },
      ]}
      value="all"
      onChange={onChange}
      allLabel="All projects"
      searchPlaceholder="Search projects"
      emptyLabel="No matching projects"
      ariaLabel="Filter by project"
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
  fireEvent.change(screen.getByPlaceholderText("Search projects"), {
    target: { value: "luma" },
  });

  expect(screen.queryByRole("option", { name: "tokentracker" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: "lumaradio" }));
  expect(onChange).toHaveBeenCalledWith("lumaradio");
});

function renderSelect(onChange) {
  render(
    <SearchableSelect
      options={[
        { value: "tokentracker", label: "tokentracker" },
        { value: "lumaradio", label: "lumaradio" },
      ]}
      value="all"
      onChange={onChange}
      allLabel="All projects"
      searchPlaceholder="Search projects"
      emptyLabel="No matching projects"
      ariaLabel="Filter by project"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
  return screen.getByPlaceholderText("Search projects");
}

it("does not select anything when Enter is pressed on a freshly opened list", () => {
  const onChange = vi.fn();
  const input = renderSelect(onChange);
  // Base UI focuses the search input on open, so a bare Enter used to commit
  // whichever project happened to sort first.
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).not.toHaveBeenCalled();
});

it("commits the highlighted option with the arrow keys", () => {
  const onChange = vi.fn();
  const input = renderSelect(onChange);
  fireEvent.keyDown(input, { key: "ArrowDown" }); // "All projects"
  fireEvent.keyDown(input, { key: "ArrowDown" }); // "tokentracker"
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("tokentracker");
});

it("still commits the top match when Enter follows a search", () => {
  const onChange = vi.fn();
  const input = renderSelect(onChange);
  fireEvent.change(input, { target: { value: "luma" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("lumaradio");
});
