import { useEffect, useRef } from "react";

import { useDesktop, type DialogState } from "../kernel/desktop";
import { Icon } from "./Icon";
import { Button } from "./widgets";

/** A Win95 message box. Modal in feel, but never blocks the rest of the desktop. */
export function Dialog({ dialog }: { readonly dialog: DialogState }) {
  const desktop = useDesktop();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const restoreTo = document.activeElement;
    root.current?.querySelector<HTMLButtonElement>("[data-primary='true'] button")?.focus();
    // Answering a message box hands focus back to whatever raised it, rather than
    // dropping it at the top of the document and stranding keyboard users.
    return () => {
      if (restoreTo instanceof HTMLElement && restoreTo.isConnected) restoreTo.focus();
    };
  }, []);

  const answer = (value: string) => desktop.answerDialog(dialog.id, value);

  return (
    <div
      className="aos-window"
      data-active="true"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          answer(dialog.buttons.at(-1)?.value ?? "cancel");
          return;
        }
        if (event.key !== "Tab") return;
        // Tab cycles within the box. Without this it walks straight out into the
        // desktop behind, which still looks modal but no longer behaves like it.
        const stops = [...(root.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
        const edge = event.shiftKey ? stops[0] : stops.at(-1);
        if (stops.length === 0 || document.activeElement !== edge) return;
        event.preventDefault();
        (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
      }}
      ref={root}
      role="dialog"
      style={{
        height: "auto",
        left: "50%",
        maxWidth: 460,
        minWidth: 320,
        top: "34%",
        transform: "translate(-50%, -50%)",
        zIndex: dialog.z,
      }}
    >
      <div className="aos-titlebar">
        <div className="aos-titlebar-text">{dialog.title}</div>
        <div className="aos-titlebar-buttons">
          <button
            aria-label="Close"
            className="aos-titlebar-btn"
            onClick={() => answer(dialog.buttons.at(-1)?.value ?? "cancel")}
            type="button"
          >
            <svg height={9} viewBox="0 0 9 9" width={9}>
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <g key={index} shapeRendering="crispEdges">
                  <rect height={1} width={1} x={1 + index} y={1 + index} />
                  <rect height={1} width={1} x={6 - index} y={1 + index} />
                </g>
              ))}
            </svg>
          </button>
        </div>
      </div>

      <div className="aos-window-body" style={{ overflow: "visible" }}>
        <div className="aos-dialog-body">
          <Icon name={dialog.icon} size={32} />
          <div className="aos-dialog-text">
            <div>{dialog.text}</div>
            {dialog.detail ? (
              <div className="aos-mono" style={{ color: "var(--text-disabled)", marginTop: 8 }}>
                {dialog.detail}
              </div>
            ) : null}
          </div>
        </div>
        <div className="aos-dialog-buttons">
          {dialog.buttons.map((button) => (
            <span data-primary={button.primary ? "true" : undefined} key={button.value}>
              <Button onClick={() => answer(button.value)}>{button.label}</Button>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
