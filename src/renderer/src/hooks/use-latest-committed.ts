import { useLayoutEffect, useRef } from "react";

/**
 * Keeps the latest committed value available to asynchronous consumers without
 * mutating a ref during render. A layout effect is required here: timers and
 * browser events can run before a passive effect, so `useEffect` could expose a
 * stale callback or input after the commit that scheduled that work.
 */
export function useLatestCommitted<T>(value: T): { current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
