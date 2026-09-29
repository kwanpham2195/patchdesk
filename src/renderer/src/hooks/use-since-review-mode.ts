import { useCallback, useMemo, useState } from "react";

import { selectSinceReviewBaseline } from "../../../domain/since-review-baseline";
import type { NarrowedDiffControl } from "../components/review-diff-changes-menu";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { SinceReviewDiffResponse } from "../review-diff-contracts";
import {
  useNarrowedPatchRequest,
  type NarrowedPatchState,
} from "./use-narrowed-patch-request";

export type SinceReviewMode = {
  /** Absent when the viewer has no submitted review, or a commit slice owns the diff. */
  readonly control: NarrowedDiffControl | undefined;
  /** Set only while the mode is on; the patch from the reviewed commit to the head. */
  readonly state: NarrowedPatchState;
  readonly baseSha: string | undefined;
};

/** Owns the "Since your review" toggle and its diff request, discarding responses for a stale head or baseline. */
export function useSinceReviewMode({
  model,
  commitSliceActive,
  loadSinceReviewDiff,
}: {
  readonly model: Pick<
    WorkbenchResponse,
    "conversation" | "viewerLogin" | "commits" | "revision"
  >;
  readonly commitSliceActive: boolean;
  readonly loadSinceReviewDiff: () => Promise<SinceReviewDiffResponse>;
}): SinceReviewMode {
  const headSha = model.revision.reviewedHeadSha;
  const baseline = useMemo(
    () =>
      selectSinceReviewBaseline({
        reviews: model.conversation.entries.flatMap((entry) =>
          entry._tag === "ReviewSummary" ? [entry.review] : [],
        ),
        viewerLogin: model.viewerLogin,
        headSha,
        commits: model.commits,
      }),
    [headSha, model.commits, model.conversation.entries, model.viewerLogin],
  );
  const baseSha =
    baseline._tag === "Available" ? baseline.commitSha : undefined;
  const [requested, setRequested] = useState(false);
  const active = requested && baseSha !== undefined && !commitSliceActive;
  const state = useNarrowedPatchRequest({
    active,
    requestKey: `${baseSha ?? ""}:${headSha}`,
    load: () =>
      loadSinceReviewDiff().then((response) =>
        response.baseSha === baseSha && response.headSha === headSha
          ? response.patch
          : undefined,
      ),
  });
  const onChange = useCallback((next: boolean) => setRequested(next), []);
  const control: NarrowedDiffControl | undefined =
    baseline._tag === "NoReview" || commitSliceActive
      ? undefined
      : {
          active,
          loading: active && state._tag === "Loading",
          disabledReason:
            baseline._tag === "CurrentHead"
              ? "No commits since your review"
              : baseline._tag === "Unreachable"
                ? "Your reviewed commit is no longer in this pull request"
                : undefined,
          onChange,
        };
  return { control, state, baseSha };
}
