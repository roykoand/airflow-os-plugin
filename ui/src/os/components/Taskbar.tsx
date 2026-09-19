import { useEffect, useState } from "react";

import { useDesktop } from "../kernel/desktop";
import { sound } from "../kernel/sound";
import { Icon } from "./Icon";
import { StartMenu } from "./StartMenu";

function Clock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(new Date()), 1000);
    return () => globalThis.clearInterval(timer);
  }, []);

  return (
    <span
      className="aos-tray-clock"
      title={now.toLocaleDateString(undefined, { dateStyle: "full" })}
    >
      {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
    </span>
  );
}

/** The Windows flag, four dithered quadrants sheared into the classic wave. */
export function StartFlag({ size = 16 }: { readonly size?: number }) {
  return (
    <svg height={size} viewBox="0 0 16 16" width={size} xmlns="http://www.w3.org/2000/svg">
      <g shapeRendering="crispEdges" transform="skewY(-8) translate(0 3)">
        <rect fill="#ff0000" height={6} width={7} x={1} y={1} />
        <rect fill="#00a000" height={6} width={7} x={8} y={0} />
        <rect fill="#0000ff" height={6} width={7} x={1} y={8} />
        <rect fill="#ffd800" height={6} width={7} x={8} y={7} />
      </g>
    </svg>
  );
}

export function Taskbar({
  deadlinesMissed,
  hitlPending,
  onDeadlinesClick,
  onHitlClick,
  onTrayClick,
  schedulerAlive,
}: {
  readonly deadlinesMissed: number;
  readonly hitlPending: number;
  readonly onDeadlinesClick: () => void;
  readonly onHitlClick: () => void;
  readonly onTrayClick: () => void;
  readonly schedulerAlive: boolean | undefined;
}) {
  const desktop = useDesktop();
  const { activeId, startOpen, windows } = desktop.state;
  const [muted, setMuted] = useState(!sound.enabled);

  return (
    <>
      {startOpen ? <StartMenu /> : null}

      <div className="aos-taskbar">
        <button
          className="aos-start-btn"
          data-open={startOpen}
          onClick={() => desktop.setStartOpen(!startOpen)}
          type="button"
        >
          <StartFlag />
          <span>Start</span>
        </button>

        <div className="aos-taskbar-div" />

        <div className="aos-taskbar-items">
          {windows.map((win) => (
            <button
              className="aos-taskbar-item"
              data-active={!win.minimized && win.id === activeId}
              key={win.id}
              onClick={() =>
                !win.minimized && win.id === activeId ? desktop.minimize(win.id) : desktop.focus(win.id)
              }
              title={win.title}
              type="button"
            >
              <Icon name={win.icon} size={13} />
              <span>{win.title}</span>
            </button>
          ))}
        </div>

        <div className="aos-tray">
          {hitlPending > 0 ? (
            <button
              className="aos-tray-badge"
              data-pending="true"
              onClick={onHitlClick}
              title={`${hitlPending} request${hitlPending === 1 ? "" : "s"} awaiting your input`}
              type="button"
            >
              <Icon name="question" size={14} />
              <span>{hitlPending}</span>
            </button>
          ) : null}
          {deadlinesMissed > 0 ? (
            <button
              className="aos-tray-badge"
              data-pending="true"
              onClick={onDeadlinesClick}
              title={`${deadlinesMissed} missed deadline${deadlinesMissed === 1 ? "" : "s"}`}
              type="button"
            >
              <Icon name="mailbox-full" size={14} />
              <span>{deadlinesMissed}</span>
            </button>
          ) : null}
          <button
            onClick={() => {
              sound.setEnabled(!sound.enabled);
              setMuted(!sound.enabled);
            }}
            style={{ background: "none", border: "none", cursor: "default", padding: 0 }}
            title={muted ? "Sounds are off" : "Sounds are on"}
            type="button"
          >
            <Icon name={muted ? "speaker-muted" : "speaker"} size={14} />
          </button>
          <button
            onClick={onTrayClick}
            style={{ background: "none", border: "none", cursor: "default", padding: 0 }}
            title={
              schedulerAlive === undefined
                ? "Scheduler status unknown"
                : schedulerAlive
                  ? "Scheduler is running"
                  : "Scheduler is not heartbeating"
            }
            type="button"
          >
            <Icon name={schedulerAlive === false ? "error" : "scheduler"} size={14} />
          </button>
          <Clock />
        </div>
      </div>
    </>
  );
}
