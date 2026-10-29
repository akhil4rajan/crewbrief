import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "@/api/client";

interface LoadState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (next: T | ((prev: T | null) => T)) => void;
}

/** Fetch on mount (and when `deps` change), exposing data, a readable error and reload. */
export function useLoad<T>(fetcher: () => Promise<T>, deps: readonly unknown[]): LoadState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  const mounted = useRef(true);

  const run = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      if (!mounted.current) return;
      setDataState(result);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    await run();
  }, [run]);

  useEffect(() => {
    mounted.current = true;
    void run();
    return () => {
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const setData = useCallback((next: T | ((prev: T | null) => T)) => {
    setDataState((prev) => (typeof next === "function" ? (next as (p: T | null) => T)(prev) : next));
  }, []);

  return { data, error, loading, reload, setData };
}
