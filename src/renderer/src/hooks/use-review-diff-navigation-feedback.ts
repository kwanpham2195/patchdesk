import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type { ReviewDiffNavigationStatus } from "../review-diff-keyboard-nav";

/** A navigation attempt that can publish feedback only while it is current. */
export type ReviewDiffNavigationOperation = {
  readonly report: (status: ReviewDiffNavigationStatus) => void;
  readonly isStale: () => boolean;
};

/** State and operation factory shared by the review diff navigation hooks. */
export type ReviewDiffNavigationFeedbackState = {
  readonly navigationStatus: ReviewDiffNavigationStatus | undefined;
  readonly createNavigationOperation: () => ReviewDiffNavigationOperation;
};

/** Identifies every navigation anchor without retaining full controlled items. */
export function reviewDiffNavigationResetIdentity(
  fileMode: "all" | "selected",
  items: ReadonlyArray<{
    readonly id: string;
    readonly version?: number;
    readonly fileDiff: {
      readonly hunks: ReadonlyArray<{
        readonly additionCount: number;
        readonly additionStart: number;
        readonly deletionStart: number;
      }>;
    };
  }>,
): string {
  return [
    fileMode,
    ...items.map(({ id, version, fileDiff }) =>
      [
        id,
        version,
        fileDiff.hunks
          .map((hunk) =>
            hunk.additionCount > 0
              ? `a${hunk.additionStart}`
              : `d${hunk.deletionStart}`,
          )
          .join("\u0002"),
      ].join("\u0001"),
    ),
  ].join("\u0000");
}

/**
 * Owns the latest navigation operation and its visible feedback. Changing
 * `resetIdentity` invalidates pending work when navigation anchors reset.
 */
export function useReviewDiffNavigationFeedback(
  resetIdentity: string,
): ReviewDiffNavigationFeedbackState {
  const [navigationStatus, setNavigationStatus] =
    useState<ReviewDiffNavigationStatus>();
  const generation = useRef(0);

  useLayoutEffect(() => {
    generation.current += 1;
    setNavigationStatus(undefined);
    return () => {
      generation.current += 1;
    };
  }, [resetIdentity]);

  const createNavigationOperation = useCallback(() => {
    const operationGeneration = generation.current + 1;
    generation.current = operationGeneration;
    const isStale = (): boolean => generation.current !== operationGeneration;
    return {
      isStale,
      report: (status: ReviewDiffNavigationStatus): void => {
        if (!isStale()) setNavigationStatus(status);
      },
    };
  }, []);

  return { navigationStatus, createNavigationOperation };
}
