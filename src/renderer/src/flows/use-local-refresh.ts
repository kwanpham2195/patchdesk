import { useCallback, useRef, useState } from "react";

import { isApiErrorCode, requestJson } from "../api-client";
import {
  branchMismatchMessage,
  localReviewSourceInput,
} from "../local-review-reopen";
import {
  parseWorkbenchResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";

/** Refresh on a local Review (#452): read the checkout again and show the session it resolves to. */
export type LocalRefreshControls = {
  readonly refresh: () => Promise<void>;
  readonly refreshing: boolean;
  /** Why the last Refresh was refused, shown under the workbench. */
  readonly error?: string;
};

function refreshFailure(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected request is `unknown` by construction; this maps it to one sentence.
  cause: unknown,
): string {
  if (isApiErrorCode(cause, "in_progress"))
    return "Another action on this review is running. Refresh when it finishes.";
  if (isApiErrorCode(cause, "unmerged_index"))
    return "The working tree has unresolved merge conflicts.";
  if (isApiErrorCode(cause, "revision_not_found"))
    return "This checkout no longer has the branch, base branch, or commit this review reads.";
  return "Patchdesk could not read the local checkout.";
}

/**
 * Owns Refresh on a local Review. The main process recomputes the source
 * under the Review lock: unchanged content answers with the same session, and
 * changed content with a new one that carries the Local drafts. There is no
 * timer; Refresh runs only when the maintainer asks (ADR 0032). Undefined on
 * a pull request Review, whose refresh reads GitHub.
 */
export function useLocalRefresh({
  workbench,
  onWorkbenchReplace,
}: {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
}): LocalRefreshControls | undefined {
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const source = workbench.session.key.source;
  const profileId = workbench.session.key.profileId;
  const reviewId = workbench.review.id;

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current || source.kind === "pull_request") return;
    refreshingRef.current = true;
    setRefreshing(true);
    setError(undefined);
    try {
      const next = parseWorkbenchResponse(
        await requestJson("/v1/reviews/local-refresh", {
          method: "POST",
          body: { profileId, reviewId },
        }),
      );
      if (next === undefined)
        setError("The refreshed review could not be read.");
      else onWorkbenchReplace(next);
    } catch (cause: unknown) {
      setError(
        branchMismatchMessage(cause, localReviewSourceInput(source)) ??
          refreshFailure(cause),
      );
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [onWorkbenchReplace, profileId, reviewId, source]);

  if (source.kind === "pull_request") return undefined;
  return error === undefined
    ? { refresh, refreshing }
    : { refresh, refreshing, error };
}
