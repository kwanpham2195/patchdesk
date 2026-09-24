import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { selectSinceReviewBaseline } from "../../../domain/since-review-baseline";
import type { SinceReviewControl } from "../components/review-diff-toolbar";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { SinceReviewDiffResponse } from "../review-diff-contracts";
import { useLatestCommitted } from "./use-latest-committed";

type SinceReviewDiffState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly patch: string }
  | { readonly _tag: "Failed" };

export type SinceReviewMode = {
  /** Absent when the viewer has no submitted review, or a commit slice owns the diff. */
  readonly control: SinceReviewControl | undefined;
  /** Set only while the mode is on; the patch from the reviewed commit to the head. */
  readonly state: SinceReviewDiffState;
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
  const loader = useLatestCommitted(loadSinceReviewDiff);
  const token = useRef(0);
  const [state, setState] = useState<SinceReviewDiffState>({ _tag: "Idle" });
  useEffect(() => {
    const requestToken = token.current + 1;
    token.current = requestToken;
    if (!active) {
      setState({ _tag: "Idle" });
      return;
    }
    setState({ _tag: "Loading" });
    void loader
      .current()
      .then((response) => {
        if (token.current !== requestToken) return;
        setState(
          response.baseSha === baseSha && response.headSha === headSha
            ? { _tag: "Ready", patch: response.patch }
            : { _tag: "Failed" },
        );
      })
      .catch(() => {
        if (token.current === requestToken) setState({ _tag: "Failed" });
      });
    return () => {
      if (token.current === requestToken) token.current += 1;
    };
  }, [active, baseSha, headSha, loader]);
  const onChange = useCallback((next: boolean) => setRequested(next), []);
  const control: SinceReviewControl | undefined =
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
  return { control, state: active ? state : { _tag: "Idle" }, baseSha };
}
