import { useCallback, useRef, type ReactNode } from "react";

import { useDrag } from "../hooks/useDrag";
import { useDesktop, type WindowState } from "../kernel/desktop";
import { Icon } from "./Icon";

const MIN_WIDTH = 220;
const MIN_HEIGHT = 120;

/** The three title-bar glyphs, drawn rather than typed so they stay 1px crisp. */
function Glyph({ kind }: { readonly kind: "min" | "max" | "restore" | "close" }) {
  const common = { fill: "#000", shapeRendering: "crispEdges" as const };
  return (
    <svg height={9} viewBox="0 0 9 9" width={9} xmlns="http://www.w3.org/2000/svg">
      {kind === "min" ? <rect {...common} height={2} width={6} x={1} y={6} /> : null}
      {kind === "max" ? (
        <>
          <rect {...common} height={8} width={8} x={0} y={0} />
          <rect fill="#c0c0c0" height={5} width={6} x={1} y={2} />
        </>
      ) : null}
      {kind === "restore" ? (
        <>
          <rect {...common} height={6} width={6} x={3} y={0} />
          <rect fill="#c0c0c0" height={3} width={4} x={4} y={2} />
          <rect {...common} height={6} width={6} x={0} y={3} />
          <rect fill="#c0c0c0" height={3} width={4} x={1} y={5} />
        </>
      ) : null}
      {kind === "close" ? (
        <>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <rect {...common} height={1} key={`a${index}`} width={1} x={1 + index} y={1 + index} />
          ))}
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <rect {...common} height={1} key={`b${index}`} width={1} x={6 - index} y={1 + index} />
          ))}
        </>
      ) : null}
    </svg>
  );
}

export function Window({
  bounds,
  children,
  window: win,
}: {
  readonly window: WindowState;
  readonly bounds: { width: number; height: number };
  readonly children: ReactNode;
}) {
  const desktop = useDesktop();
  const active = desktop.state.activeId === win.id;
  const start = useRef({ height: 0, width: 0, x: 0, y: 0 });

  const captureGeometry = useCallback(() => {
    start.current = { height: win.height, width: win.width, x: win.x, y: win.y };
  }, [win.x, win.y, win.width, win.height]);

  const moveDrag = useDrag(
    ({ dx, dy }) => {
      // Keep at least a sliver of the title bar reachable, as Windows did.
      const x = Math.min(Math.max(start.current.x + dx, 8 - win.width), bounds.width - 32);
      const y = Math.min(Math.max(start.current.y + dy, 0), bounds.height - 20);
      desktop.move(win.id, x, y);
    },
    { onStart: captureGeometry },
  );

  const resizeDrag = useDrag(
    ({ dx, dy }) => {
      desktop.resize(
        win.id,
        Math.max(start.current.width + dx, MIN_WIDTH),
        Math.max(start.current.height + dy, MIN_HEIGHT),
      );
    },
    { onStart: captureGeometry },
  );

  if (win.minimized) return null;

  return (
    <div
      className="aos-window"
      data-active={active}
      data-dragging={moveDrag.dragging}
      data-resizing={resizeDrag.dragging}
      onPointerDownCapture={() => desktop.focus(win.id)}
      style={{ height: win.height, left: win.x, top: win.y, width: win.width, zIndex: win.z }}
    >
      <div
        className="aos-titlebar"
        onDoubleClick={() => desktop.toggleMaximize(win.id, bounds)}
        onPointerDown={win.maximized ? undefined : moveDrag.onPointerDown}
      >
        <Icon name={win.icon} size={13} />
        <div className="aos-titlebar-text">{win.title}</div>
        <div className="aos-titlebar-buttons">
          <button
            aria-label="Minimize"
            className="aos-titlebar-btn"
            onClick={() => desktop.minimize(win.id)}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            <Glyph kind="min" />
          </button>
          <button
            aria-label={win.maximized ? "Restore" : "Maximize"}
            className="aos-titlebar-btn"
            onClick={() => desktop.toggleMaximize(win.id, bounds)}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            <Glyph kind={win.maximized ? "restore" : "max"} />
          </button>
          <button
            aria-label="Close"
            className="aos-titlebar-btn"
            onClick={() => desktop.close(win.id)}
            onPointerDown={(event) => event.stopPropagation()}
            style={{ marginLeft: 2 }}
            type="button"
          >
            <Glyph kind="close" />
          </button>
        </div>
      </div>

      <div className="aos-window-body">{children}</div>

      {win.maximized ? null : (
        <div className="aos-resize-handle" onPointerDown={resizeDrag.onPointerDown}>
          <svg height={14} viewBox="0 0 14 14" width={14} xmlns="http://www.w3.org/2000/svg">
            {[
              [10, 3],
              [6, 7],
              [10, 7],
              [2, 11],
              [6, 11],
              [10, 11],
            ].map(([x = 0, y = 0]) => (
              <g key={`${x}-${y}`} shapeRendering="crispEdges">
                <rect fill="#808080" height={2} width={2} x={x} y={y} />
                <rect fill="#ffffff" height={1} width={1} x={x + 2} y={y + 2} />
              </g>
            ))}
          </svg>
        </div>
      )}
    </div>
  );
}
