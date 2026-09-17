import type { FC } from "react";

import { About } from "./apps/About";
import { ControlPanel } from "./apps/ControlPanel";
import { EventViewer } from "./apps/EventViewer";
import { Explorer } from "./apps/Explorer";
import { HitlInbox } from "./apps/HitlInbox";
import { Deadlines } from "./apps/Deadlines";
import { Notepad } from "./apps/Notepad";
import { Paint } from "./apps/Paint";
import { RecycleBin } from "./apps/RecycleBin";
import { RunDialog } from "./apps/RunDialog";
import { SystemProperties } from "./apps/SystemProperties";
import { TaskManager } from "./apps/TaskManager";
import { WinHelp } from "./apps/WinHelp";
import { Terminal } from "./apps/Terminal";
import { registerAppLookup } from "./kernel/desktop";

export interface AppProps {
  /** Id of the window this instance is rendered in, for self-close and retitling. */
  windowId: string;
  /** Whatever `openApp` was called with. */
  props: Record<string, unknown>;
}

export type StartMenuGroup = "programs" | "accessories" | "settings" | "none";

export interface AppDefinition {
  id: string;
  name: string;
  icon: string;
  component: FC<AppProps>;
  width: number;
  height: number;
  /** Show a shortcut on the desktop. */
  desktop?: boolean;
  /** Which Start menu group it appears in. */
  group: StartMenuGroup;
  /** Only ever one window of this app. */
  singleton?: boolean;
}

export const APPS: AppDefinition[] = [
  {
    component: TaskManager,
    desktop: true,
    group: "programs",
    height: 460,
    icon: "taskmgr",
    id: "taskmgr",
    name: "Task Manager",
    width: 720,
  },
  {
    component: Explorer,
    desktop: true,
    group: "programs",
    height: 440,
    icon: "folder-open",
    id: "explorer",
    name: "Explorer",
    width: 760,
  },
  {
    component: HitlInbox,
    desktop: true,
    group: "programs",
    height: 520,
    icon: "question",
    id: "hitl",
    name: "Human Input Required",
    singleton: true,
    width: 780,
  },
  {
    component: WinHelp,
    group: "programs",
    height: 470,
    icon: "help",
    id: "winhelp",
    name: "Airflow Help",
    singleton: true,
    width: 760,
  },
  {
    component: Deadlines,
    desktop: true,
    group: "programs",
    height: 520,
    icon: "mailbox",
    id: "deadlines",
    name: "Deadlines",
    singleton: true,
    width: 800,
  },
  {
    component: RecycleBin,
    desktop: true,
    group: "programs",
    height: 420,
    icon: "recycle-empty",
    id: "recyclebin",
    name: "Recycle Bin",
    singleton: true,
    width: 720,
  },
  {
    component: Notepad,
    group: "accessories",
    height: 430,
    icon: "notepad",
    id: "notepad",
    name: "Notepad",
    width: 640,
  },
  {
    component: Paint,
    desktop: true,
    group: "accessories",
    height: 480,
    icon: "paint",
    id: "paint",
    name: "Paint",
    width: 760,
  },
  {
    component: Terminal,
    desktop: true,
    group: "accessories",
    height: 380,
    icon: "terminal",
    id: "terminal",
    name: "MS-DOS Prompt",
    width: 620,
  },
  {
    component: EventViewer,
    group: "programs",
    height: 420,
    icon: "eventlog",
    id: "events",
    name: "Event Viewer",
    width: 740,
  },
  {
    component: ControlPanel,
    desktop: true,
    group: "settings",
    height: 420,
    icon: "controlpanel",
    id: "control",
    name: "Control Panel",
    width: 700,
  },
  {
    component: SystemProperties,
    group: "settings",
    height: 460,
    icon: "computer",
    id: "sysprops",
    name: "System Properties",
    singleton: true,
    width: 520,
  },
  {
    component: RunDialog,
    group: "none",
    height: 320,
    icon: "run",
    id: "run",
    name: "Run",
    singleton: true,
    width: 420,
  },
  {
    component: About,
    group: "none",
    height: 470,
    icon: "help",
    id: "about",
    name: "About Airflow OS",
    singleton: true,
    width: 500,
  },
];

const BY_ID = new Map(APPS.map((app) => [app.id, app]));

export function getApp(id: string): AppDefinition | undefined {
  return BY_ID.get(id);
}

// The window manager needs default geometry and titles without importing components.
registerAppLookup((id) => {
  const app = BY_ID.get(id);
  return app ? { height: app.height, icon: app.icon, name: app.name, width: app.width } : undefined;
});
