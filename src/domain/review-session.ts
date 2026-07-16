import {
  allocateNextReviewAttemptId,
  createReviewSessionId,
  type AbsolutePath,
  type IsoTimestamp,
  type ReviewAttemptId,
  type ReviewSessionId,
  type WorkspaceProfileId,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type PullRequestNumber,
  type GitSha,
} from "./ids";
import { hasActiveDraft, type ReviewDraft } from "./review-draft";
import type { ReviewAttempt, ReviewAttemptState } from "./review-attempt";
import type { ReviewResult } from "./review-result";
import { err, ok, type Result } from "./result";

export type ReviewSessionKey = {
  readonly profileId: WorkspaceProfileId;
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly prNumber: PullRequestNumber;
  readonly headSha: GitSha;
};

export type ReviewSessionState =
  | { readonly _tag: "Created" }
  | { readonly _tag: "Running"; readonly attemptId: ReviewAttemptId }
  | { readonly _tag: "ReviewCompleted"; readonly attemptId: ReviewAttemptId }
  | { readonly _tag: "ReviewFailed"; readonly attemptId: ReviewAttemptId }
  | { readonly _tag: "Stale"; readonly reason: "head_changed" | "orphaned_run"; readonly currentHeadSha?: GitSha }
  | { readonly _tag: "Discarded"; readonly attemptId: ReviewAttemptId }
  | { readonly _tag: "Merged"; readonly mergedAt: IsoTimestamp };

export type ReviewSession = {
  readonly id: ReviewSessionId;
  readonly key: ReviewSessionKey;
  readonly state: ReviewSessionState;
  readonly currentAttemptId?: ReviewAttemptId;
  readonly draft?: Pick<ReviewDraft, "state">;
  readonly visibleResult?: ReviewResult;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

export type ActiveDraftBlocksRerun = { readonly _tag: "ActiveDraftBlocksRerun" };
export type SessionImmutable = { readonly _tag: "SessionImmutable" };
export type CannotAllocateAttempt = { readonly _tag: "CannotAllocateAttempt" };
export type AttemptNotCurrent = { readonly _tag: "AttemptNotCurrent" };

/** Construct a new deterministic session without filesystem or GitHub effects. */
export function createReviewSession(input: {
  readonly key: ReviewSessionKey;
  readonly createdAt: IsoTimestamp;
  readonly draft?: Pick<ReviewDraft, "state">;
}): ReviewSession {
  return {
    id: createReviewSessionId(input.key),
    key: input.key,
    state: { _tag: "Created" },
    ...(input.draft === undefined ? {} : { draft: input.draft }),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** Start a new current attempt unless a draft is active or the session is terminal. */
export function startNextAttempt(
  session: ReviewSession,
  existingFolderNames: ReadonlyArray<string>,
): Result<{ readonly session: ReviewSession; readonly attemptId: ReviewAttemptId }, ActiveDraftBlocksRerun | SessionImmutable | CannotAllocateAttempt> {
  if (session.state._tag === "Merged") {
    return err({ _tag: "SessionImmutable" });
  }
  if (session.draft !== undefined && hasActiveDraft(session.draft)) {
    return err({ _tag: "ActiveDraftBlocksRerun" });
  }

  const attemptId = allocateNextReviewAttemptId(existingFolderNames);
  if (attemptId._tag === "err") {
    return err({ _tag: "CannotAllocateAttempt" });
  }

  return ok({
    attemptId: attemptId.value,
    session: {
      ...session,
      currentAttemptId: attemptId.value,
      state: { _tag: "Running", attemptId: attemptId.value },
    },
  });
}

/** Complete the current attempt, or make a late completion harmless and visible on that attempt. */
export function completeAttempt(
  session: ReviewSession,
  attempt: Pick<ReviewAttempt, "id" | "sessionId" | "state">,
  result: ReviewResult,
  completedAt: IsoTimestamp,
  resultPath: AbsolutePath,
): Result<{ readonly session: ReviewSession; readonly attempt: Pick<ReviewAttempt, "id" | "sessionId" | "state"> }, SessionImmutable> {
  if (session.state._tag === "Merged") {
    return err({ _tag: "SessionImmutable" });
  }

  if (
    session.state._tag === "Discarded" ||
    session.currentAttemptId !== attempt.id ||
    attempt.state._tag === "Discarded"
  ) {
    const reason =
      session.state._tag === "Discarded" || attempt.state._tag === "Discarded"
        ? "session_discarded"
        : "not_current";
    return ok({
      session,
      attempt: {
        id: attempt.id,
        sessionId: attempt.sessionId,
        state: { _tag: "IgnoredLateResult", completedAt, reason },
      },
    });
  }

  const state: ReviewAttemptState = { _tag: "Completed", resultPath };
  return ok({
    session: {
      ...session,
      state: { _tag: "ReviewCompleted", attemptId: attempt.id },
      visibleResult: result,
      updatedAt: completedAt,
    },
    attempt: { id: attempt.id, sessionId: attempt.sessionId, state },
  });
}

/** Discard the current attempt without attempting to abort any external workflow. */
export function discardCurrentAttempt(
  session: ReviewSession,
  attemptId: ReviewAttemptId,
  discardedAt: IsoTimestamp,
): Result<ReviewSession, AttemptNotCurrent | SessionImmutable> {
  if (session.state._tag === "Merged") {
    return err({ _tag: "SessionImmutable" });
  }
  if (session.currentAttemptId !== attemptId) {
    return err({ _tag: "AttemptNotCurrent" });
  }

  return ok({
    ...session,
    state: { _tag: "Discarded", attemptId },
    updatedAt: discardedAt,
  });
}

/** Mark a session as terminal after a successful explicit merge action. */
export function markSessionMerged(session: ReviewSession, mergedAt: IsoTimestamp): ReviewSession {
  return { ...session, state: { _tag: "Merged", mergedAt }, updatedAt: mergedAt };
}
