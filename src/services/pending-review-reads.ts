import type {
  GitHubPendingReviewGateway,
  GitHubReader,
} from "../adapters/github/github-adapter";
import { parseGitHubLogin } from "../domain/ids";
import {
  matchPendingReviewThread,
  type PendingReviewAnchor,
  type PendingReviewOperation,
  type PendingReviewRead,
  type PendingReviewThreadWrite,
} from "../domain/pending-review";
import type { PullRequestRef } from "../domain/pull-request";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";

type PendingReviewReader = Pick<
  GitHubPendingReviewGateway,
  "getViewerPendingReview"
> &
  Pick<GitHubReader, "resolveAuthenticatedAccount">;

/** The one thread a Start or AddThread meant to create, as the write sent it. */
export type PendingReviewThreadIntent = {
  readonly profile: WorkspaceProfileConfig;
  readonly anchor: PendingReviewAnchor;
  readonly body: string;
};

/** What the reconciling read proved about a `pending_review` refusal. */
export type PendingReviewConflictOutcome =
  | { readonly _tag: "Landed"; readonly write: PendingReviewThreadWrite }
  | { readonly _tag: "Refused"; readonly observed: PendingReviewRead }
  | { readonly _tag: "Uncertain" };

/**
 * The landed check for a refused Submit or Discard (ADR 0046): a resent
 * write whose first delivery landed is refused the same way, so only a read
 * that finds the recorded review, by its id, still Pending proves the write
 * did not land. None, another pending review, or a read that fails proves
 * nothing, and the write stays outcome unknown.
 */
export async function recordedReviewStillPending(
  github: PendingReviewReader,
  profile: WorkspaceProfileConfig,
  pr: PullRequestRef,
  operation: PendingReviewOperation,
): Promise<boolean> {
  if (operation._tag !== "Submit" && operation._tag !== "Discard") return false;
  try {
    const account = await github.resolveAuthenticatedAccount(profile);
    if (account._tag === "err") return false;
    const login = parseGitHubLogin(account.value.account);
    if (login._tag === "err") return false;
    const read = await github.getViewerPendingReview({
      profile,
      pr,
      account: login.value,
    });
    return (
      read._tag === "ok" &&
      read.value._tag === "Pending" &&
      read.value.review.restId === operation.reviewId
    );
  } catch {
    return false;
  }
}

/**
 * What a `pending_review` refusal of a Start or AddThread really means.
 * GitHub answers the same 422 whether it already held the viewer's pending
 * review or the first request landed and the renderer's transport resent it
 * (ADR 0046), so the refusal alone is not evidence the write failed. One
 * read of the viewer's pending review decides: it holds the intended
 * thread, it holds someone else's work, or it proves nothing and the write
 * stays uncertain.
 */
export async function resolvePendingReviewConflict(
  github: PendingReviewReader,
  pr: PullRequestRef,
  intent: PendingReviewThreadIntent,
): Promise<PendingReviewConflictOutcome> {
  const account = await github.resolveAuthenticatedAccount(intent.profile);
  if (account._tag === "err") return { _tag: "Uncertain" };
  const login = parseGitHubLogin(account.value.account);
  if (login._tag === "err") return { _tag: "Uncertain" };
  const read = await github.getViewerPendingReview({
    profile: intent.profile,
    pr,
    account: login.value,
  });
  if (read._tag === "err" || read.value._tag === "Unavailable")
    return { _tag: "Uncertain" };
  // GitHub refused because a pending review exists, so a read finding none
  // contradicts the refusal: one of the two is stale and the outcome is not
  // established. Incomplete evidence stays check-required (ADR 0035).
  if (read.value._tag === "None") return { _tag: "Uncertain" };
  const matched = matchPendingReviewThread(
    read.value.review,
    intent.anchor,
    intent.body,
  );
  if (matched._tag === "Ambiguous") return { _tag: "Uncertain" };
  return matched._tag === "Match"
    ? {
        _tag: "Landed",
        write: {
          review: read.value.review,
          createdThreadId: matched.threadId,
        },
      }
    : { _tag: "Refused", observed: read.value };
}
