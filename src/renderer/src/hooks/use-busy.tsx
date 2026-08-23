import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type BusyContextValue = {
  readonly isBusy: boolean;
  readonly label: string | undefined;
  readonly runBusy: <T>(fn: () => Promise<T>, label?: string) => Promise<T>;
};

const BusyContext = createContext<BusyContextValue | null>(null);

/**
 * Reference-counted busy signal shared across the app. `runBusy` tracks how
 * many async actions are in flight (not just whether any are), so two
 * overlapping actions (e.g. inbox refresh + PR-open) don't clobber each
 * other's busy state — the bar stays visible until every in-flight call
 * resolves.
 */
export function BusyProvider({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  const countRef = useRef(0);
  const [state, setState] = useState<{
    isBusy: boolean;
    label: string | undefined;
  }>({ isBusy: false, label: undefined });
  const runBusy = useCallback(
    async <T,>(fn: () => Promise<T>, label?: string): Promise<T> => {
      if (++countRef.current === 1) setState({ isBusy: true, label });
      try {
        return await fn();
      } finally {
        if (--countRef.current === 0)
          setState({ isBusy: false, label: undefined });
      }
    },
    [],
  );
  const value = useMemo(() => ({ ...state, runBusy }), [state, runBusy]);
  return <BusyContext.Provider value={value}>{children}</BusyContext.Provider>;
}

// oxlint-disable-next-line react/only-export-components -- The context hook lives with its provider so consumers import both from one module.
export function useBusy(): BusyContextValue {
  const ctx = useContext(BusyContext);
  if (ctx === null) throw new Error("useBusy must be used within BusyProvider");
  return ctx;
}
