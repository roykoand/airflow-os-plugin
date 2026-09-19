import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { kernel } from "./api/client";
import { AltTab } from "./components/AltTab";
import { Clippy } from "./components/Clippy";
import { BootSplash } from "./components/BootSplash";
import { Bsod, crashFor, extractException } from "./components/Bsod";
import { DesktopIcon } from "./components/DesktopIcon";
import { Dialog } from "./components/Dialog";
import { Taskbar } from "./components/Taskbar";
import { Window } from "./components/Window";
import { usePoll } from "./hooks/usePoll";
import { CELL_HEIGHT, useDesktopIcons } from "./hooks/useDesktopIcons";
import { useHitlWatch } from "./hooks/useHitlWatch";
import { useTaskTransitions } from "./hooks/useTaskTransitions";
import { DesktopProvider, useDesktop } from "./kernel/desktop";
import { readFlag } from "./kernel/prefs";
import { sound } from "./kernel/sound";
import { APPS, getApp } from "./registry";
import "./theme/win95.css";

export function AirflowOS() {
  return (
    <DesktopProvider>
      <Desktop />
    </DesktopProvider>
  );
}

function Desktop() {
  const desktop = useDesktop();
  const surface = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ height: 640, width: 1024 });
  const [selectedIcon, setSelectedIcon] = useState<string | null>(null);

  // Windows are positioned in pixels, so the manager needs the surface size for
  // maximize and for keeping title bars on screen.
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => {
      setBounds({ height: element.clientHeight - 28, width: element.clientWidth });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { data: system } = usePoll(kernel.system, { interval: 15_000 });

  // My Computer is not an app in the registry; it opens System Properties.
  const shortcuts = useMemo(
    () => [
      ...APPS.filter((app) => app.desktop).map((app) => ({
        icon: app.icon,
        id: app.id,
        name: app.name,
        singleton: app.singleton ?? false,
      })),
      { icon: "computer", id: "sysprops", name: "My Computer", singleton: true },
    ],
    [],
  );

  const icons = useDesktopIcons(
    shortcuts.map((shortcut) => shortcut.id),
    Math.max(Math.floor((bounds.height - 12) / CELL_HEIGHT), 1),
  );

  const hitlPending = useHitlWatch(desktop);

  // A missed deadline is unread mail, not an interrupt: it badges but never plays a
  // sound or opens the mailbox, so a plain poll rather than a watcher like HITL's.
  const { data: missed } = usePoll(() => kernel.deadlines(true), { interval: 30_000 });
  const deadlinesMissed = missed?.length ?? 0;

  const badges: Record<string, number> = { deadlines: deadlinesMissed, hitl: hitlPending };

  useTaskTransitions({
    onFailed: async (rows) => {
      sound.play("chord");
      const row = rows[0];
      if (row === undefined || !readFlag("bsod", true)) return;
      // The log is the only place the exception exists, so fetch the evidence the
      // Clippy endpoint already assembles rather than duplicating that query.
      let exception: string | undefined;
      try {
        const evidence = await kernel.evidence({
          dag_id: row.dag_id,
          map_index: row.map_index,
          run_id: row.run_id,
          task_id: row.task_id,
          try_number: row.try_number,
        });
        exception = extractException(String(evidence.log_tail ?? ""));
      } catch {
        // No log, no exception line. The screen says so rather than inventing one.
      }
      desktop.crash(
        crashFor(
          {
            dagId: row.dag_id,
            maxTries: row.max_tries,
            runId: row.run_id,
            state: row.state,
            taskId: row.task_id,
            tryNumber: row.try_number,
          },
          exception,
        ),
      );
    },
    onSucceeded: () => sound.play("tada"),
  });

  // Audio is unlocked by the boot splash. This is the safety net for a boot that ran
  // before the browser would allow it: the first gesture afterwards starts the
  // context, with the logon click rather than the boot air, which has been and gone.
  useEffect(() => {
    const unlock = () => sound.unlock("logon");
    globalThis.addEventListener("pointerdown", unlock, { once: true });
    globalThis.addEventListener("keydown", unlock, { once: true });
    return () => {
      globalThis.removeEventListener("pointerdown", unlock);
      globalThis.removeEventListener("keydown", unlock);
    };
  }, []);

  const crash = desktop.state.crash;

  if (!desktop.state.booted) {
    return (
      <div className="aos">
        <BootSplash onDone={desktop.markBooted} />
      </div>
    );
  }

  return (
    <div className="aos">
      <div
        className="aos-desktop"
        onContextMenu={async (event) => {
          event.preventDefault();
          const answer = await desktop.messageBox({
            buttons: [
              { label: "Line up Icons", primary: true, value: "arrange" },
              { label: "Cancel", value: "cancel" },
            ],
            detail: "This forgets where you have dragged them.",
            icon: "question",
            text: "Line up the desktop icons?",
            title: "Desktop",
          });
          if (answer === "arrange") icons.autoArrange();
        }}
        onPointerDown={() => setSelectedIcon(null)}
        ref={surface}
      >
        <div className="aos-desktop-icons">
          {shortcuts.map((shortcut) => (
            <DesktopIcon
              badge={badges[shortcut.id]}
              icons={icons}
              id={shortcut.id}
              key={shortcut.id}
              label={shortcut.name}
              name={shortcut.icon}
              onOpen={() => desktop.openApp(shortcut.id, {}, { singleton: shortcut.singleton })}
              onSelect={() => setSelectedIcon(shortcut.id)}
              selected={selectedIcon === shortcut.id}
            />
          ))}
        </div>

        {desktop.state.windows.map((win) => {
          const app = getApp(win.appId);
          if (!app) return null;
          const Component = app.component;
          return (
            <Window bounds={bounds} key={win.id} window={win}>
              <Component props={win.props} windowId={win.id} />
            </Window>
          );
        })}

        <div className="aos-modal-layer">
          {desktop.state.dialogs.map((dialog) => (
            <Dialog dialog={dialog} key={dialog.id} />
          ))}
        </div>

        <Clippy />

        <AltTab />

        <Taskbar
          deadlinesMissed={deadlinesMissed}
          hitlPending={hitlPending}
          onDeadlinesClick={() => desktop.openApp("deadlines", {}, { singleton: true })}
          onHitlClick={() => desktop.openApp("hitl", {}, { singleton: true })}
          onTrayClick={() => desktop.openApp("sysprops", {}, { singleton: true })}
          schedulerAlive={system?.scheduler_alive}
        />

        {crash === null ? null : <Bsod crash={crash} />}
      </div>
    </div>
  );
}
