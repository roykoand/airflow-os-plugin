import { useEffect, useRef, useState } from "react";

import { kernel } from "../api/client";
import type { DesktopApi } from "../kernel/desktop";
import { sound } from "../kernel/sound";

const POLL_MS = 10_000;

/**
 * Windows interrupting you because something needs an answer.
 *
 * Polls for pending human-in-the-loop requests and, when a genuinely new one appears,
 * plays the Question sound and opens the inbox. Like the sound watcher, it works on
 * transitions and primes silently on the first pass, so a backlog of requests that
 * were already waiting when you logged in does not ambush you.
 *
 * Returns the pending count, which the desktop badges onto the inbox icon and the
 * system tray - one poll feeds all three, rather than every indicator asking
 * separately.
 */
export function useHitlWatch(desktop: DesktopApi, enabled = true): number {
  const [pending, setPending] = useState(0);
  const seen = useRef(new Set<string>());
  const primed = useRef(false);
  const desktopRef = useRef(desktop);
  desktopRef.current = desktop;

  useEffect(() => {
    if (!enabled) return undefined;

    let stopped = false;
    const poll = async () => {
      let requests;
      try {
        requests = await kernel.hitl();
      } catch {
        return; // No permission, or a transient error. Either way, stay quiet.
      }
      if (stopped) return;

      setPending(requests.length);

      const fresh = requests.filter((request) => !seen.current.has(request.ti_id));
      seen.current = new Set(requests.map((request) => request.ti_id));

      if (!primed.current) {
        primed.current = true;
        return;
      }
      if (fresh.length === 0) return;

      sound.play("question");
      desktopRef.current.openApp("hitl", {}, { singleton: true });
    };

    void poll();
    const timer = globalThis.setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      globalThis.clearInterval(timer);
    };
  }, [enabled]);

  return pending;
}
