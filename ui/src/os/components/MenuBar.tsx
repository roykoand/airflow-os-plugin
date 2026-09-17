import { useEffect, useRef, useState } from "react";

/*
 * A Windows 95 menu bar: File  Edit  View … with drop-downs. Click opens a menu,
 * moving across the bar while one is open switches menus, clicking anywhere else
 * closes it. Only what Paint needs; the CSS was already in the theme.
 */

export interface MenuItem {
  label: string;
  /** Shown right-aligned, so only list keys the app actually handles. */
  accel?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

export type MenuEntry = MenuItem | "separator";

export interface Menu {
  label: string;
  items: MenuEntry[];
}

export function MenuBar({ menus }: { readonly menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (open === null) return undefined;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const current = open === null ? undefined : menus[open];
  const left = open === null ? 0 : (buttons.current[open]?.offsetLeft ?? 0);

  return (
    <div className="aos-menubar" ref={root} style={{ position: "relative" }}>
      {menus.map((menu, index) => (
        <button
          data-open={open === index ? "true" : undefined}
          key={menu.label}
          onClick={() => setOpen((value) => (value === index ? null : index))}
          onPointerEnter={() => setOpen((value) => (value === null ? null : index))}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
        >
          {menu.label}
        </button>
      ))}

      {current ? (
        <div className="aos-menu" role="menu" style={{ left, top: "100%" }}>
          {current.items.map((item, index) =>
            item === "separator" ? (
              <div className="aos-menu-sep" key={`sep-${index}`} />
            ) : (
              <button
                className="aos-menu-item"
                disabled={item.disabled}
                key={item.label}
                onClick={() => {
                  setOpen(null);
                  item.onSelect?.();
                }}
                role="menuitem"
                type="button"
              >
                <span style={{ display: "inline-block", textAlign: "center", width: 10 }}>
                  {item.checked ? "✓" : ""}
                </span>
                <span>{item.label}</span>
                {item.accel ? <span className="aos-menu-accel">{item.accel}</span> : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
