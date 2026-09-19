// The jest-dom matchers are registered in testsSetup.ts; this import brings their types
// into the type-check, which only includes src/.
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeAll, describe, expect, it } from "vitest";

import { DesktopProvider, registerAppLookup, useDesktop } from "../kernel/desktop";
import { AltTab } from "./AltTab";

beforeAll(() => {
  registerAppLookup(() => ({ height: 300, icon: "computer", name: "App", width: 400 }));
});

/** Opens one window per title, oldest first, and reports which one is active. */
function Harness({ titles }: { readonly titles: string[] }) {
  const desktop = useDesktop();

  useEffect(() => {
    for (const title of titles) desktop.openApp("app", {}, { title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = desktop.state.windows.find((win) => win.id === desktop.state.activeId);
  return (
    <>
      <div data-testid="active">{active?.title ?? ""}</div>
      <AltTab />
    </>
  );
}

const desktopWith = (...titles: string[]) =>
  render(
    <DesktopProvider>
      <Harness titles={titles} />
    </DesktopProvider>,
  );

const altTab = (shiftKey = false) => fireEvent.keyDown(window, { altKey: true, key: "Tab", shiftKey });
const releaseAlt = () => fireEvent.keyUp(window, { key: "Alt" });
const active = () => screen.getByTestId("active").textContent;

/** The switcher's own title line. Queried by class, since the harness above renders
 *  the active window's title too and `getByText` cannot tell them apart. */
const switcher = () => document.querySelector(".aos-altTab");
const selected = () => switcher()?.querySelector(".aos-altTab-title")?.textContent ?? null;

describe("AltTab", () => {
  it("opens on the previous window, so one press is a back-and-forth", () => {
    desktopWith("Notepad", "Explorer", "Paint");
    expect(active()).toBe("Paint");

    altTab();
    expect(selected()).toBe("Explorer");

    releaseAlt();
    expect(active()).toBe("Explorer");
  });

  it("walks further back while Alt is held, and Shift reverses", () => {
    desktopWith("Notepad", "Explorer", "Paint");

    altTab();
    altTab();
    expect(selected()).toBe("Notepad");

    altTab(true);
    expect(selected()).toBe("Explorer");

    releaseAlt();
    expect(active()).toBe("Explorer");
  });

  it("holds the order it started with, rather than re-sorting as it goes", () => {
    desktopWith("Notepad", "Explorer", "Paint");

    // Committing to Explorer raises it above Paint; the next chord must see that new
    // order, and a chord in flight must not re-sort underneath the selection.
    altTab();
    releaseAlt();
    expect(active()).toBe("Explorer");

    altTab();
    expect(selected()).toBe("Paint");
    altTab();
    expect(selected()).toBe("Notepad");
    altTab();
    expect(selected()).toBe("Explorer");
  });

  it("Escape backs out without switching", () => {
    desktopWith("Notepad", "Explorer", "Paint");

    altTab();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(switcher()).toBeNull();

    releaseAlt();
    expect(active()).toBe("Paint");
  });

  it("stays out of the way when there is nothing to switch to", () => {
    desktopWith("Notepad");

    altTab();
    expect(switcher()).toBeNull();
  });

  it("closes if the window loses focus mid-chord, rather than hanging about", () => {
    desktopWith("Notepad", "Explorer");

    altTab();
    expect(selected()).toBe("Notepad");

    fireEvent.blur(window);
    expect(switcher()).toBeNull();
  });
});
