import type * as React from "react";

import type { WorkbenchResponse } from "../renderer-contracts";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

/**
 * The Diff tab's pane: pull-request-level notices above the diff itself.
 *
 * The conflict notice reads `mergeReadiness.blockers`, not the merge status,
 * because a draft, a stale head, a failing check and a review blocker all
 * report the same Blocked status. Only `conflicting` means the pull request
 * no longer merges into its base branch.
 */
export function ReviewDiffPane({
  model,
  children,
}: {
  readonly model: WorkbenchResponse;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const conflicting =
    model.review.status === "open" &&
    model.mergeReadiness.blockers.includes("conflicting");
  const baseBranch = model.pullRequest?.baseBranch;
  const headBranch = model.pullRequest?.headBranch;
  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      {conflicting ? (
        <Alert variant="warning" className="m-2 w-auto shrink-0">
          <AlertTitle>Merge conflicts</AlertTitle>
          <AlertDescription>
            {/* Named branches are dropped rather than called "unknown", which would read as a branch name. */}
            {baseBranch === undefined || headBranch === undefined
              ? "Resolve the conflicts locally and push."
              : `${headBranch} no longer merges cleanly into ${baseBranch}. Resolve locally and push.`}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
