// The jest-dom matchers are registered in testsSetup.ts; this import brings their types
// into the type-check, which only includes src/.
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MenuBar } from "./MenuBar";

describe("MenuBar", () => {
  it("opens on click, runs the item and closes again", () => {
    const onSelect = vi.fn();
    render(
      <MenuBar
        menus={[
          { items: [{ label: "Open…", onSelect }, "separator", { disabled: true, label: "Undo" }], label: "File" },
          { items: [{ checked: true, label: "Status Bar" }], label: "View" },
        ]}
      />,
    );
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByText("File"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Undo" })).toBeDisabled();

    fireEvent.click(screen.getByText("Open…"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("switches menus on hover while one is open and shows check marks", () => {
    render(
      <MenuBar
        menus={[
          { items: [{ label: "Exit" }], label: "File" },
          { items: [{ checked: true, label: "Tool Box" }], label: "View" },
        ]}
      />,
    );
    fireEvent.click(screen.getByText("File"));
    fireEvent.pointerEnter(screen.getByText("View"));
    expect(screen.getByText("Tool Box")).toBeInTheDocument();
    expect(screen.getByText("✓")).toBeInTheDocument();
  });

  it("closes when clicking outside", () => {
    render(<MenuBar menus={[{ items: [{ label: "Exit" }], label: "File" }]} />);
    fireEvent.click(screen.getByText("File"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
