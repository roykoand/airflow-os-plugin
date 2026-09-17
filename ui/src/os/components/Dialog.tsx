import { useEffect, useRef } from "react";

import { useDesktop, type DialogState } from "../kernel/desktop";
import { Icon } from "./Icon";
import { Button } from "./widgets";

/** A Win95 message box. Modal in feel, but never blocks the rest of the desktop. */
export function Dialog({ dialog }: { readonly dialog: DialogState }) {
  const desktop = useDesktop();
  const primary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    primary.current?.querySelector<HTMLButtonElement>("[data-primary='true'] button")?.focus();
  }, []);

  const answer = (value: string) => desktop.answerDialog(dialog.id, value);

  return (
    <div
      className="aos-window"
      data-active="true"
      onKeyDown={(event) => {
        if (event.key === "Escape") answer(dialog.buttons.at(-1)?.value ?? "cancel");
      }}
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
        <div className="aos-dialog-buttons" ref={primary}>
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
