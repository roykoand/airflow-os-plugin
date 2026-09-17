import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Desktop icon placement.
 *
 * Windows 95 let you drop an icon anywhere and it snapped to an invisible grid, and
 * remembered where you left it. Same here: positions are grid cells rather than raw
 * pixels, which keeps the desktop tidy however sloppily you drag, and survives a
 * resize because a cell index means the same thing at any window size.
 */

const STORAGE_KEY = "airflow-os:icons";

/** Cell size, chosen to fit a 76px icon tile with a little air around it. */
export const CELL_WIDTH = 84;
export const CELL_HEIGHT = 88;
const MARGIN = 6;

export interface IconPosition {
  column: number;
  row: number;
}

type Layout = Record<string, IconPosition>;

function readLayout(): Layout {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const layout: Layout = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value !== null && typeof value === "object") {
        const { column, row } = value as Record<string, unknown>;
        if (typeof column === "number" && typeof row === "number") layout[id] = { column, row };
      }
    }
    return layout;
  } catch {
    // Blocked site data, or someone hand-edited it. Fall back to auto-arrange.
    return {};
  }
}

function writeLayout(layout: Layout): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // The layout just will not persist. Not worth interrupting anyone over.
  }
}

export interface DesktopIcons {
  /** Pixel position for an icon, auto-arranged if it has never been moved. */
  positionOf: (id: string) => { left: number; top: number };
  /** Called on drop, with the pointer offset from where the drag started. */
  moveTo: (id: string, left: number, top: number) => void;
  /** "Line up Icons": forget every custom position. */
  autoArrange: () => void;
  dragging: string | null;
  setDragging: (id: string | null) => void;
}

/**
 * @param ids       Icon ids in their default order.
 * @param rowsPerColumn How many icons fit vertically before the default layout wraps.
 */
export function useDesktopIcons(ids: string[], rowsPerColumn: number): DesktopIcons {
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [dragging, setDragging] = useState<string | null>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;

  useEffect(() => {
    writeLayout(layout);
  }, [layout]);

  const positionOf = useCallback(
    (id: string) => {
      const placed = layout[id];
      if (placed) {
        return {
          left: MARGIN + placed.column * CELL_WIDTH,
          top: MARGIN + placed.row * CELL_HEIGHT,
        };
      }
      // Never moved: fall back to the default column-major arrangement.
      const index = Math.max(idsRef.current.indexOf(id), 0);
      const rows = Math.max(rowsPerColumn, 1);
      return {
        left: MARGIN + Math.floor(index / rows) * CELL_WIDTH,
        top: MARGIN + (index % rows) * CELL_HEIGHT,
      };
    },
    [layout, rowsPerColumn],
  );

  const moveTo = useCallback((id: string, left: number, top: number) => {
    // Snap to the nearest cell, and never off the top or left edge.
    const column = Math.max(Math.round((left - MARGIN) / CELL_WIDTH), 0);
    const row = Math.max(Math.round((top - MARGIN) / CELL_HEIGHT), 0);
    setLayout((previous) => ({ ...previous, [id]: { column, row } }));
  }, []);

  const autoArrange = useCallback(() => setLayout({}), []);

  return { autoArrange, dragging, moveTo, positionOf, setDragging };
}
