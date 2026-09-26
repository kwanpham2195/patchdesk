import { useCallback, useMemo, useState } from "react";

/** An inline Start or Add on its way to the pending review, or one GitHub safely refused. */
export type PendingReviewWrite =
  | {
      readonly _tag: "sending";
      readonly localId: string;
      readonly action: "start" | "add";
      readonly path: string;
      readonly start: number;
      readonly end: number;
      readonly side: "new" | "old";
      readonly body: string;
    }
  | {
      readonly _tag: "failed";
      readonly localId: string;
      readonly action: "start" | "add";
      readonly path: string;
      readonly start: number;
      readonly end: number;
      readonly side: "new" | "old";
      readonly body: string;
      readonly message: string;
    };

/** Pending-review drafts of one Review, held above the Diff tab so a tab switch or a Refresh to a new head keeps them (#526). */
export type PendingReviewDrafts = {
  readonly writes: ReadonlyArray<PendingReviewWrite>;
  readonly updateWrites: (
    update: (
      current: ReadonlyArray<PendingReviewWrite>,
    ) => ReadonlyArray<PendingReviewWrite>,
  ) => void;
  /** A failed draft's body whose lines are gone, kept until the maintainer selects a new line or dismisses it. */
  readonly orphanedBody: string | undefined;
  readonly setOrphanedBody: (body: string | undefined) => void;
  /** The Review's full diff at the current head: a draft's lines are gone only when this lacks them, whatever a narrowed view shows. */
  readonly fullPatch: string | undefined;
};

type ReviewDrafts = {
  readonly reviewId: string;
  readonly writes: ReadonlyArray<PendingReviewWrite>;
  readonly orphanedBody: string | undefined;
};

function emptyDrafts(reviewId: string): ReviewDrafts {
  return { reviewId, writes: [], orphanedBody: undefined };
}

/** Owns the pending-review drafts of the open Review and drops them when another Review opens. */
export function usePendingReviewDrafts(
  reviewId: string,
  fullPatch: string | undefined,
): PendingReviewDrafts {
  const [drafts, setDrafts] = useState(() => emptyDrafts(reviewId));
  if (drafts.reviewId !== reviewId) setDrafts(emptyDrafts(reviewId));
  // A write that settles after its Review closed belongs to that Review, so it is not recorded on the next one.
  const updateWrites = useCallback<PendingReviewDrafts["updateWrites"]>(
    (update) =>
      setDrafts((current) =>
        current.reviewId === reviewId
          ? { ...current, writes: update(current.writes) }
          : current,
      ),
    [reviewId],
  );
  const setOrphanedBody = useCallback(
    (body: string | undefined): void =>
      setDrafts((current) =>
        current.reviewId === reviewId
          ? { ...current, orphanedBody: body }
          : current,
      ),
    [reviewId],
  );
  const { writes, orphanedBody } = drafts;
  return useMemo(
    () => ({ writes, updateWrites, orphanedBody, setOrphanedBody, fullPatch }),
    [fullPatch, orphanedBody, setOrphanedBody, updateWrites, writes],
  );
}
