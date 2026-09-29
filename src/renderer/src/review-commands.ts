import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import type { ReviewNavDirection } from "./review-diff-keyboard-nav";

/** One row of the ⌘K Review group; `run` calls the handler of the control the row names. */
export type ReviewCommand = {
  readonly id: string;
  readonly label: string;
  /** The key that runs the same command outside the palette, shown on the row. */
  readonly shortcut?: string;
  /** Set while the command cannot run; the row is disabled and shows it. */
  readonly unavailableReason?: string;
  readonly run: () => void;
};

/** Read when the palette renders, so its rows reflect the Review as it is then. */
export type ReviewCommandSource = () => ReadonlyArray<ReviewCommand>;

/**
 * Lets the open Review workbench publish its commands to the ⌘K palette the
 * app shell owns. Absent outside the shell, where there is no palette.
 */
export const ReviewCommandRegistryContext = createContext<
  ((source: ReviewCommandSource | undefined) => void) | undefined
>(undefined);

/** The app shell's side: the registered source, if a Review is open, and the stable register function. */
export function useReviewCommandRegistry() {
  const [source, setSource] = useState<ReviewCommandSource>();
  // A function state value must be wrapped, or React calls it as an updater.
  const register = useCallback(
    (next: ReviewCommandSource | undefined): void => setSource(() => next),
    [],
  );
  return { source, register };
}

/** Publishes `source` to the palette while the caller is mounted. `source` must be stable. */
export function useRegisterReviewCommands(source: ReviewCommandSource): void {
  const register = useContext(ReviewCommandRegistryContext);
  useEffect(() => {
    if (register === undefined) return;
    register(source);
    return () => register(undefined);
  }, [register, source]);
}

/**
 * The Diff's Finding step, which the diff surface fills while `(` and `)` are
 * live there and the workbench's Next and Previous Finding commands call.
 */
export type FindingStepSlot = {
  current: ((direction: ReviewNavDirection) => void) | undefined;
};

export const FindingStepSlotContext = createContext<
  FindingStepSlot | undefined
>(undefined);
