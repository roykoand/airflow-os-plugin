import { useEffect, useRef, useState, type ReactNode } from "react";

import { useDesktop } from "../kernel/desktop";
import { sound } from "../kernel/sound";
import { APPS, type StartMenuGroup } from "../registry";
import { Icon } from "./Icon";

const GROUPS: { id: StartMenuGroup; label: string; icon: string }[] = [
  { icon: "folder", id: "programs", label: "Programs" },
  { icon: "folder", id: "accessories", label: "Accessories" },
  { icon: "controlpanel", id: "settings", label: "Settings" },
];

export function StartMenu() {
  const desktop = useDesktop();
  const [openGroup, setOpenGroup] = useState<StartMenuGroup | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // Clicking anywhere else dismisses the menu, as it does in Windows.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (root.current?.contains(target)) return;
      if ((target as HTMLElement | null)?.closest?.(".aos-start-btn")) return;
      desktop.setStartOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [desktop]);

  return (
    <div className="aos-startmenu" ref={root}>
      <div className="aos-startmenu-banner">Airflow OS</div>

      <div className="aos-startmenu-items">
        {GROUPS.map((group) => (
          <SubmenuItem
            group={group.id}
            icon={group.icon}
            key={group.id}
            label={group.label}
            onOpen={setOpenGroup}
            open={openGroup === group.id}
          />
        ))}

        <hr className="aos-menu-sep" />

        <Item
          icon="find"
          label="Find…"
          onClick={() => desktop.openApp("explorer", { path: "C:" })}
        />
        <Item icon="help" label="Help" onClick={() => desktop.openApp("winhelp", {}, { singleton: true })} />
        <Item icon="run" label="Run…" onClick={() => desktop.openApp("run", {}, { singleton: true })} />

        <hr className="aos-menu-sep" />

        <Item
          icon="shutdown"
          label="Shut Down…"
          onClick={async () => {
            const answer = await desktop.messageBox({
              buttons: [
                { label: "Yes", primary: true, value: "yes" },
                { label: "No", value: "no" },
              ],
              detail:
                "This closes every window. Your Airflow deployment keeps running - the desktop is only a view of it.",
              icon: "question",
              text: "Are you sure you want to shut down Airflow OS?",
              title: "Shut Down Windows",
            });
            if (answer !== "yes") return;
            sound.play("shutdown");
            for (const win of desktop.state.windows) desktop.close(win.id);
            desktop.crash({
              code: "SHUTDOWN",
              lines: [
                "It's now safe to turn off your computer.",
                "",
                "Your dags are still running. Airflow OS is a shell over live",
                "metadata; closing it changes nothing about your deployment.",
                "",
                "Press any key to return to the desktop.",
              ],
              title: "Airflow OS",
            });
          }}
        />
      </div>
    </div>
  );
}

function Item({
  children,
  icon,
  label,
  onClick,
}: {
  readonly icon: string;
  readonly label: string;
  readonly onClick?: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <button className="aos-startmenu-item" onClick={onClick} type="button">
      <Icon name={icon} size={20} />
      <span>{label}</span>
      {children}
    </button>
  );
}

function SubmenuItem({
  group,
  icon,
  label,
  onOpen,
  open,
}: {
  readonly group: StartMenuGroup;
  readonly label: string;
  readonly icon: string;
  readonly open: boolean;
  readonly onOpen: (group: StartMenuGroup | null) => void;
}) {
  const desktop = useDesktop();
  const apps = APPS.filter((app) => app.group === group);

  return (
    <div onPointerEnter={() => onOpen(group)} style={{ position: "relative" }}>
      <Item icon={icon} label={label}>
        <span className="aos-submenu-arrow">▶</span>
      </Item>

      {open ? (
        <div className="aos-menu" style={{ bottom: 0, left: "100%", minWidth: 180 }}>
          {apps.map((app) => (
            <button
              className="aos-menu-item"
              key={app.id}
              onClick={() => desktop.openApp(app.id, {}, { singleton: app.singleton })}
              type="button"
            >
              <Icon name={app.icon} size={16} />
              {app.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
