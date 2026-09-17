import { useRef, useState } from "react";

import { useDrag } from "../hooks/useDrag";
import type { DesktopIcons } from "../hooks/useDesktopIcons";
import { Icon } from "./Icon";

/**
 * One desktop shortcut: draggable, snapping to the icon grid when you let go.
 *
 * The drag is tracked locally as an offset and only committed to the layout on drop,
 * so dragging never re-renders the whole desktop, and a drag that ends up under the
 * grid threshold is not mistaken for a double-click.
 */
export function DesktopIcon({
  badge,
  icons,
  id,
  label,
  name,
  onOpen,
  onSelect,
  selected,
}: {
  readonly badge?: number;
  readonly icons: DesktopIcons;
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly onOpen: () => void;
  readonly onSelect: () => void;
  readonly selected: boolean;
}) {
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  const moved = useRef(false);
  const base = icons.positionOf(id);

  const drag = useDrag(
    ({ dx, dy }) => {
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true;
      setOffset({ dx, dy });
    },
    {
      onEnd: () => {
        icons.setDragging(null);
        setOffset((current) => {
          if (moved.current) icons.moveTo(id, base.left + current.dx, base.top + current.dy);
          return { dx: 0, dy: 0 };
        });
      },
      onStart: () => {
        moved.current = false;
        icons.setDragging(id);
      },
    },
  );

  return (
    <button
      className="aos-desktop-icon"
      data-selected={selected}
      onDoubleClick={() => {
        // A drag that ended on top of itself should not also launch the app.
        if (!moved.current) onOpen();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
        drag.onPointerDown(event);
      }}
      style={{
        left: base.left + offset.dx,
        opacity: drag.dragging ? 0.7 : 1,
        top: base.top + offset.dy,
        zIndex: drag.dragging ? 10 : 1,
      }}
      title={label}
      type="button"
    >
      <span style={{ position: "relative" }}>
        <Icon name={name} size={32} />
        {badge !== undefined && badge > 0 ? (
          <span className="aos-badge">{badge > 99 ? "99+" : badge}</span>
        ) : null}
      </span>
      <span>{label}</span>
    </button>
  );
}
