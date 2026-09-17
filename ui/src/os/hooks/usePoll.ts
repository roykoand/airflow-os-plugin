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
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
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
    const timer = globalThis.setInterval(refresh, interval);
    return () => globalThis.clearInterval(timer);
  }, [enabled, interval, refresh]);

  return { data, error, initial, loading, refresh };
}
