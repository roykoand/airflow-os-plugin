import { useCallback, useEffect, useRef, useState } from "react";

export interface PollResult<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** True only on the first load, so lists don't flash "Loading" on every refresh. */
  initial: boolean;
  refresh: () => void;
}

/**
 * Fetch on mount, then on an interval. Deliberately tiny: the desktop's polling
 * needs are uniform, and pulling in a query library would bloat a bundle the host
 * loads dynamically.
 *
 * `deps` re-runs the fetch when inputs change. Pass `interval: 0` for one-shot loads.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  { deps = [] as unknown[], enabled = true, interval = 0 } = {},
): PollResult<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(enabled);
  const [initial, setInitial] = useState(true);
  const [tick, setTick] = useState(0);
  const [failures, setFailures] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);

    fetcherRef
      .current()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(undefined);
        setFailures(0);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setFailures((count) => count + 1);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setInitial(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, enabled, ...deps]);

  useEffect(() => {
    if (!enabled || interval <= 0) return undefined;
    // Doubling per consecutive failure, capped at 8x: an api-server that is down (or
    // a session that has expired) is not worth asking every two seconds, but recovery
    // still has to be noticed without a reload.
    const delay = interval * Math.min(2 ** failures, 8);
    const timer = globalThis.setInterval(() => {
      // A background tab polls nothing. Several desktops left open otherwise keep the
      // api-server answering queries for views nobody is looking at.
      if (!document.hidden) refresh();
    }, delay);
    return () => globalThis.clearInterval(timer);
  }, [enabled, interval, refresh, failures]);

  // Coming back to the tab should show current data, not whatever was on screen when
  // it was hidden, so the skipped polls are made up immediately rather than waited out.
  useEffect(() => {
    if (!enabled || interval <= 0) return undefined;
    const onVisibility = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled, interval, refresh]);

  return { data, error, initial, loading, refresh };
}
