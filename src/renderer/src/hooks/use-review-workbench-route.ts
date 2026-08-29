import {
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ReviewWorkbenchInitialState } from "../components/review-workbench";
import type { ReviewWorkbenchFlowProps } from "../flows/review-workbench-flow";
import { loadWorkbenchUiState } from "../lib/screen-restore";
import type { WorkbenchPayload } from "../renderer-models";
import type { AppDestination } from "../routes";

type ReviewWorkbenchFlowComponent =
  React.ComponentType<ReviewWorkbenchFlowProps>;

export type ReviewWorkbenchLoader = () => Promise<{
  readonly default: ReviewWorkbenchFlowComponent;
}>;

/** The workbench position a reload restores, and the Review it belongs to. */
type RestoredWorkbenchUi = {
  readonly reviewId: string;
  readonly state: ReviewWorkbenchInitialState;
};

export type ReviewWorkbenchRoute = {
  /** The Review route, code-split so it loads only once a Review is open. */
  readonly LazyReviewWorkbench: React.LazyExoticComponent<ReviewWorkbenchFlowComponent>;
  readonly reviewLoaderGeneration: number;
  readonly setReviewLoaderGeneration: Dispatch<SetStateAction<number>>;
  /** Applied once, to the Review it was saved under; cleared by the next load. */
  readonly restoredWorkbenchUi: RefObject<RestoredWorkbenchUi | undefined>;
};

export function useReviewWorkbenchRoute({
  destination,
  fixtureMode,
  reviewWorkbenchLoader,
  workbench,
}: {
  readonly destination: AppDestination;
  readonly fixtureMode: boolean;
  readonly reviewWorkbenchLoader: ReviewWorkbenchLoader;
  readonly workbench: WorkbenchPayload | undefined;
}): ReviewWorkbenchRoute {
  const [reviewLoaderGeneration, setReviewLoaderGeneration] = useState(0);
  const LazyReviewWorkbench = useMemo(
    () => lazy(reviewWorkbenchLoader),
    [reviewWorkbenchLoader, reviewLoaderGeneration],
  );
  // Workbench position restored after reload; applied once to the matching review.
  const restoredWorkbenchUi = useRef<
    | { readonly reviewId: string; readonly state: ReviewWorkbenchInitialState }
    | undefined
  >(undefined);
  useEffect(() => {
    if (
      fixtureMode ||
      destination.kind !== "workbench" ||
      restoredWorkbenchUi.current !== undefined
    )
      return;
    const state = loadWorkbenchUiState(destination.reviewId);
    if (state !== undefined) {
      restoredWorkbenchUi.current = { reviewId: destination.reviewId, state };
    }
  }, [destination, fixtureMode]);
  useEffect(() => {
    if (fixtureMode || workbench === undefined) return;
    restoredWorkbenchUi.current = undefined;
  }, [fixtureMode, workbench]);
  return {
    LazyReviewWorkbench,
    restoredWorkbenchUi,
    reviewLoaderGeneration,
    setReviewLoaderGeneration,
  };
}
