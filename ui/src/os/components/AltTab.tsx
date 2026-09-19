import { useEffect, useRef, useState } from "react";

import { useDesktop } from "../kernel/desktop";
import { Icon } from "./Icon";

/*
 * Alt+Tab, with the box Windows 95 shipped as "coolswitch": hold Alt to keep it up,
 * Tab to walk the list, release Alt to commit, Escape to back out.
 *
 * The host OS gets first refusal on the chord. macOS leaves Option+Tab to the page,
 * but Windows and most Linux window managers swallow it, so this can never be the
 * only route to a window - the taskbar stays that. Where it does arrive it is worth
 * having, because the alternative for a keyboard user is tabbing the whole desktop.
 */

interface Session {
  /** Snapshot taken when the chord starts: recomputing it would shift underfoot. */
  ids: string[];
  index: number;
}

export function AltTab() {
  const desktop = useDesktop();
  const [session, setSession] = useState<Session | null>(null);

  // The listeners bind once, so they read the moving parts through a ref rather than
  // being torn down and rebuilt on every window change.
  const latest = useRef({ focus: desktop.focus, session, windows: desktop.state.windows });
  latest.current = { focus: desktop.focus, session, windows: desktop.state.windows };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && latest.current.session) {
        setSession(null);
        return;
      }
      if (event.key !== "Tab" || !event.altKey) return;

      // Most-recently-used order, which z already is: focusing a window raises it.
      const ids = [...latest.current.windows].sort((a, b) => b.z - a.z).map((win) => win.id);
      if (ids.length < 2) return;
      event.preventDefault();

      const current = latest.current.session;
      if (!current) {
        // Starting on the neighbour makes a single press the "back to the last one"
        // gesture it is everywhere else, rather than a no-op onto the active window.
        setSession({ ids, index: event.shiftKey ? ids.length - 1 : 1 });
        return;
      }
      const step = event.shiftKey ? -1 : 1;
      setSession({
        ...current,
        index: (current.index + step + current.ids.length) % current.ids.length,
      });
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return;
      const current = latest.current.session;
      if (!current) return;
      setSession(null);
      const id = current.ids[current.index];
      // A window closed mid-chord is simply not there any more; focus ignores it.
      if (id !== undefined) latest.current.focus(id);
    };

    // Switching away while still holding Alt means the keyup never arrives, which
    // would otherwise leave the box on screen for good.
    const onBlur = () => setSession(null);

    globalThis.addEventListener("keydown", onKeyDown);
    globalThis.addEventListener("keyup", onKeyUp);
    globalThis.addEventListener("blur", onBlur);
    return () => {
      globalThis.removeEventListener("keydown", onKeyDown);
      globalThis.removeEventListener("keyup", onKeyUp);
      globalThis.removeEventListener("blur", onBlur);
    };
  }, []);

  if (!session) return null;

  const entries = session.ids
    .map((id) => desktop.state.windows.find((win) => win.id === id))
    .filter((win) => win !== undefined);
  if (entries.length === 0) return null;

  const index = Math.min(session.index, entries.length - 1);

  return (
    <div className="aos-altTab" role="presentation">
      <div className="aos-altTab-icons">
        {entries.map((win, position) => (
          <div className="aos-altTab-icon" data-selected={position === index || undefined} key={win.id}>
            <Icon name={win.icon} size={32} />
          </div>
        ))}
      </div>
      <div className="aos-altTab-title">{entries[index]?.title}</div>
    </div>
  );
}
