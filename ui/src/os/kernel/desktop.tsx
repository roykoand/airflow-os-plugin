import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";

import { sound } from "./sound";

/*
 * The window manager. One reducer owns every window, dialog and the shutdown /
 * crash state; components read it through `useDesktop()`.
 */

export interface WindowState {
  id: string;
  appId: string;
  title: string;
  icon: string;
  props: Record<string, unknown>;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  /** Geometry to restore to when un-maximizing. */
  restore?: { x: number; y: number; width: number; height: number };
}

export interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
}

export interface DialogState {
  id: string;
  title: string;
  icon: "error" | "warning" | "info" | "question";
  text: string;
  detail?: string;
  buttons: DialogButton[];
  z: number;
}

export interface CrashState {
  code: string;
  title: string;
  lines: string[];
  /** Present for a dag failure, so Ctrl+Alt+Del can clear that run. */
  target?: { dagId: string; runId: string; taskId: string };
}

interface DesktopState {
  windows: WindowState[];
  dialogs: DialogState[];
  activeId: string | null;
  startOpen: boolean;
  nextZ: number;
  seq: number;
  crash: CrashState | null;
  booted: boolean;
}

type Action =
  | { type: "open"; window: Omit<WindowState, "z" | "minimized" | "maximized"> }
  | { type: "close"; id: string }
  | { type: "focus"; id: string }
  | { type: "move"; id: string; x: number; y: number }
  | { type: "resize"; id: string; width: number; height: number }
  | { type: "minimize"; id: string }
  | { type: "toggleMaximize"; id: string; bounds: { width: number; height: number } }
  | { type: "setTitle"; id: string; title: string }
  | { type: "startMenu"; open: boolean }
  | { type: "openDialog"; dialog: Omit<DialogState, "z"> }
  | { type: "closeDialog"; id: string }
  | { type: "crash"; crash: CrashState | null }
  | { type: "booted" };

const INITIAL: DesktopState = {
  activeId: null,
  booted: false,
  crash: null,
  dialogs: [],
  nextZ: 10,
  seq: 0,
  startOpen: false,
  windows: [],
};

function reducer(state: DesktopState, action: Action): DesktopState {
  switch (action.type) {
    case "open": {
      const z = state.nextZ + 1;
      return {
        ...state,
        activeId: action.window.id,
        nextZ: z,
        seq: state.seq + 1,
        startOpen: false,
        windows: [...state.windows, { ...action.window, maximized: false, minimized: false, z }],
      };
    }

    case "close": {
      const windows = state.windows.filter((w) => w.id !== action.id);
      const activeId =
        state.activeId === action.id
          ? // Focus falls to whatever is now topmost, as it does in Windows.
            (windows.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0]?.id ?? null)
          : state.activeId;
      return { ...state, activeId, windows };
    }

    case "focus": {
      const target = state.windows.find((w) => w.id === action.id);
      if (!target) return state;
      if (state.activeId === action.id && !target.minimized) return { ...state, startOpen: false };
      const z = state.nextZ + 1;
      return {
        ...state,
        activeId: action.id,
        nextZ: z,
        startOpen: false,
        windows: state.windows.map((w) => (w.id === action.id ? { ...w, minimized: false, z } : w)),
      };
    }

    case "move":
      return {
        ...state,
        windows: state.windows.map((w) => (w.id === action.id ? { ...w, x: action.x, y: action.y } : w)),
      };

    case "resize":
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id ? { ...w, height: action.height, width: action.width } : w,
        ),
      };

    case "minimize": {
      const windows = state.windows.map((w) => (w.id === action.id ? { ...w, minimized: true } : w));
      return {
        ...state,
        activeId: windows.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0]?.id ?? null,
        windows,
      };
    }

    case "toggleMaximize":
      return {
        ...state,
        windows: state.windows.map((w) => {
          if (w.id !== action.id) return w;
          if (w.maximized) {
            const restore = w.restore ?? { height: 420, width: 640, x: 40, y: 40 };
            return { ...w, ...restore, maximized: false, restore: undefined };
          }
          return {
            ...w,
            height: action.bounds.height,
            maximized: true,
            restore: { height: w.height, width: w.width, x: w.x, y: w.y },
            width: action.bounds.width,
            x: 0,
            y: 0,
          };
        }),
      };

    case "setTitle":
      return {
        ...state,
        windows: state.windows.map((w) => (w.id === action.id ? { ...w, title: action.title } : w)),
      };

    case "startMenu":
      return { ...state, startOpen: action.open };

    case "openDialog": {
      const z = state.nextZ + 1;
      return { ...state, dialogs: [...state.dialogs, { ...action.dialog, z }], nextZ: z, startOpen: false };
    }

    case "closeDialog":
      return { ...state, dialogs: state.dialogs.filter((d) => d.id !== action.id) };

    case "crash":
      return { ...state, crash: action.crash };

    case "booted":
      return { ...state, booted: true };

    default:
      return state;
  }
}

export interface OpenOptions {
  title?: string;
  icon?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  /** Reuse an existing window of this app instead of opening a second one. */
  singleton?: boolean;
}

export interface MessageBoxOptions {
  title: string;
  text: string;
  detail?: string;
  icon?: DialogState["icon"];
  buttons?: DialogButton[];
}

export interface DesktopApi {
  state: DesktopState;
  openApp: (appId: string, props?: Record<string, unknown>, options?: OpenOptions) => string | null;
  close: (id: string) => void;
  focus: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
  resize: (id: string, width: number, height: number) => void;
  minimize: (id: string) => void;
  toggleMaximize: (id: string, bounds: { width: number; height: number }) => void;
  setTitle: (id: string, title: string) => void;
  setStartOpen: (open: boolean) => void;
  /** Opens a modal message box and resolves with the button the user picked. */
  messageBox: (options: MessageBoxOptions) => Promise<string>;
  answerDialog: (id: string, value: string) => void;
  crash: (crash: CrashState | null) => void;
  markBooted: () => void;
}

/** Windows played a different sound per message-box severity. */
const DIALOG_SOUNDS = {
  error: "chord",
  info: "asterisk",
  question: "question",
  warning: "exclamation",
} as const;

const DesktopContext = createContext<DesktopApi | null>(null);

/** Registered lazily by the registry so this module stays free of app imports. */
let appLookup: (appId: string) => { name: string; icon: string; width: number; height: number } | undefined =
  () => undefined;

export function registerAppLookup(lookup: typeof appLookup) {
  appLookup = lookup;
}

export function DesktopProvider({ children }: { readonly children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const resolvers = useRef(new Map<string, (value: string) => void>());
  const counter = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const nextId = useCallback((prefix: string) => {
    counter.current += 1;
    return `${prefix}-${counter.current}`;
  }, []);

  const openApp = useCallback<DesktopApi["openApp"]>(
    (appId, props = {}, options = {}) => {
      const def = appLookup(appId);
      if (!def) return null;

      if (options.singleton) {
        const existing = stateRef.current.windows.find((w) => w.appId === appId);
        if (existing) {
          dispatch({ id: existing.id, type: "focus" });
          return existing.id;
        }
      }

      const id = nextId(appId);
      const width = options.width ?? def.width;
      const height = options.height ?? def.height;
      // Cascade successive windows down-right, wrapping so they stay on screen.
      const step = (stateRef.current.seq % 8) * 22;
      dispatch({
        type: "open",
        window: {
          appId,
          height,
          icon: options.icon ?? def.icon,
          id,
          props,
          title: options.title ?? def.name,
          width,
          x: options.x ?? 24 + step,
          y: options.y ?? 18 + step,
        },
      });
      return id;
    },
    [nextId],
  );

  const messageBox = useCallback<DesktopApi["messageBox"]>(
    (options) =>
      new Promise<string>((resolve) => {
        const id = nextId("dlg");
        resolvers.current.set(id, resolve);
        // Windows had a sound per message-box severity; so does this.
        sound.play(DIALOG_SOUNDS[options.icon ?? "info"]);
        dispatch({
          dialog: {
            buttons: options.buttons ?? [{ label: "OK", primary: true, value: "ok" }],
            detail: options.detail,
            icon: options.icon ?? "info",
            id,
            text: options.text,
            title: options.title,
          },
          type: "openDialog",
        });
      }),
    [nextId],
  );

  const answerDialog = useCallback<DesktopApi["answerDialog"]>((id, value) => {
    resolvers.current.get(id)?.(value);
    resolvers.current.delete(id);
    dispatch({ id, type: "closeDialog" });
  }, []);

  const api = useMemo<DesktopApi>(
    () => ({
      answerDialog,
      close: (id) => dispatch({ id, type: "close" }),
      crash: (crash) => dispatch({ crash, type: "crash" }),
      focus: (id) => dispatch({ id, type: "focus" }),
      markBooted: () => dispatch({ type: "booted" }),
      messageBox,
      minimize: (id) => dispatch({ id, type: "minimize" }),
      move: (id, x, y) => dispatch({ id, type: "move", x, y }),
      openApp,
      resize: (id, width, height) => dispatch({ height, id, type: "resize", width }),
      setStartOpen: (open) => dispatch({ open, type: "startMenu" }),
      setTitle: (id, title) => dispatch({ id, title, type: "setTitle" }),
      state,
      toggleMaximize: (id, bounds) => dispatch({ bounds, id, type: "toggleMaximize" }),
    }),
    [state, openApp, messageBox, answerDialog],
  );

  return <DesktopContext.Provider value={api}>{children}</DesktopContext.Provider>;
}

export function useDesktop(): DesktopApi {
  const context = useContext(DesktopContext);
  if (!context) throw new Error("useDesktop must be used inside <DesktopProvider>");
  return context;
}
