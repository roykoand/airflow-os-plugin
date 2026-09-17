import { useCallback, useRef, useState } from "react";

export interface DragState {
  dragging: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
}

/**
 * Pointer-capture drag helper shared by window moving and resizing.
 *
 * `onMove` receives the delta from the pointer-down position, so callers can add it
 * to the geometry they captured at drag start rather than tracking it themselves.
 */
export function useDrag(
  onMove: (delta: { dx: number; dy: number }) => void,
  { onEnd, onStart }: { onStart?: () => void; onEnd?: () => void } = {},
): DragState {
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ x: 0, y: 0 });
  const moveRef = useRef(onMove);
  moveRef.current = onMove;

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Left button only, and never from a control inside the drag surface.
      if (event.button !== 0) return;
      event.preventDefault();

      origin.current = { x: event.clientX, y: event.clientY };
      const target = event.currentTarget as HTMLElement;
      target.setPointerCapture(event.pointerId);
      setDragging(true);
      onStart?.();

      const handleMove = (moveEvent: PointerEvent) => {
        moveRef.current({
          dx: moveEvent.clientX - origin.current.x,
          dy: moveEvent.clientY - origin.current.y,
        });
      };

      const handleUp = () => {
        target.releasePointerCapture?.(event.pointerId);
        target.removeEventListener("pointermove", handleMove);
        target.removeEventListener("pointerup", handleUp);
        target.removeEventListener("pointercancel", handleUp);
        setDragging(false);
        onEnd?.();
      };

      target.addEventListener("pointermove", handleMove);
      target.addEventListener("pointerup", handleUp);
      target.addEventListener("pointercancel", handleUp);
    },
    [onStart, onEnd],
  );

  return { dragging, onPointerDown };
}
