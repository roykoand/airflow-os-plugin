import { useEffect, useRef } from "react";

import { kernel } from "../api/client";
import type { ProcessRow } from "../api/types";

const POLL_MS = 6000;
const SUCCESS = "success";
const FAILURES = new Set(["failed", "upstream_failed"]);

/**
 * Watches the process table and reports task instances that *changed* state.
 *
 * Transitions, not absolute state: a database holding a hundred old failures should
 * be silent, and the first poll only establishes the baseline - announcing everything
 * it finds there would be a fanfare for history.
 *
 * One poll feeds every consumer (the sound scheme, the stop screen), so adding another
 * reaction costs nothing.
 */
export function useTaskTransitions({
  enabled = true,
  onFailed,
  onSucceeded,
}: {
  onFailed?: (rows: ProcessRow[]) => void;
  onSucceeded?: (rows: ProcessRow[]) => void;
  enabled?: boolean;
}) {
  const seen = useRef(new Map<string, string>());
  const primed = useRef(false);
  const handlers = useRef({ onFailed, onSucceeded });
  handlers.current = { onFailed, onSucceeded };

  useEffect(() => {
    if (!enabled) return undefined;

    let stopped = false;
    const poll = async () => {
      let rows;
      try {
        rows = await kernel.processes(true);
      } catch {
        return; // Transient API errors are not worth reacting to.
      }
      if (stopped) return;

      const succeeded: ProcessRow[] = [];
      const failed: ProcessRow[] = [];
      const next = new Map<string, string>();

      for (const row of rows) {
        const key = `${row.dag_id}/${row.run_id}/${row.task_id}/${row.map_index}/${row.try_number}`;
        next.set(key, row.state);
        if (seen.current.get(key) === row.state) continue;
        if (row.state === SUCCESS) succeeded.push(row);
        else if (FAILURES.has(row.state)) failed.push(row);
      }

      seen.current = next;
      if (!primed.current) {
        primed.current = true;
        return;
      }

      if (failed.length > 0) handlers.current.onFailed?.(failed);
      if (succeeded.length > 0) handlers.current.onSucceeded?.(succeeded);
    };

    void poll();
    const timer = globalThis.setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      globalThis.clearInterval(timer);
    };
  }, [enabled]);
}
