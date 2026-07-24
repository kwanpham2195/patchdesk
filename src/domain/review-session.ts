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
import type { PullRequestSnapshot } from "./github-context";
import {
  hasActiveReviewBatch,
  type GitHubReviewEvent,
  type ReviewBatch,
} from "./review-batch";
import type { ReviewDraft } from "./review-draft";
import type {
  ReviewAttempt,
  ReviewAttemptState,
  ReviewFailureSummary,
} from "./review-attempt";
import type { ReviewResult } from "./review-result";
import type { ReviewScope } from "./review-comparison";
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
  | {
      readonly _tag: "ReviewFailed";
      readonly attemptId: ReviewAttemptId;
      readonly error: ReviewFailureSummary;
    }
  | { readonly _tag: "Stale"; readonly reason: "head_changed" | "orphaned_run"; readonly currentHeadSha?: GitSha }
  | { readonly _tag: "Discarded"; readonly attemptId: ReviewAttemptId }
  | { readonly _tag: "Merged"; readonly mergedAt: IsoTimestamp };

export type ReviewWorktreeRef = {
  readonly path: AbsolutePath;
  readonly headSha: GitSha;
};

export type SubmittedReviewRef = {
  readonly reviewId: string;
  readonly event: GitHubReviewEvent;
  readonly submittedAt: IsoTimestamp;
};

export type MergeDecisionRef = {
  readonly mergedAt: IsoTimestamp;
  readonly mergeCommitSha?: GitSha;
};

export type ReviewSession = {
  /** The in-memory representation is always normalized to the current schema. */
  readonly schemaVersion: 3;
  readonly id: ReviewSessionId;
  readonly key: ReviewSessionKey;
  readonly pr: PullRequestSnapshot;
  readonly prContext?: {
    readonly title: string;
    readonly description?: string;
    readonly author: string;
    readonly headBranch: string;
    readonly baseBranch: string;
  };
  readonly patchPath: AbsolutePath;
  readonly scope: ReviewScope;
  readonly worktree: ReviewWorktreeRef;
  readonly state: ReviewSessionState;
  readonly currentAttemptId?: ReviewAttemptId;
  readonly batch?: Pick<ReviewBatch, "state">;
  /** Full validated batch retained so interrupted GitHub writes are never guessed or replayed. */
  readonly batchContent?: ReviewBatch;
  /**
   * @deprecated Temporary internal type bridge for legacy consumers being
   * migrated in later workbench tasks. New v3 sessions never persist this field.
   */
  readonly draft?: Pick<ReviewDraft, "state">;
  /**
   * @deprecated Temporary internal type bridge for legacy consumers being
   * migrated in later workbench tasks. New v3 sessions never persist this field.
   */
  readonly draftContent?: ReviewDraft;
  readonly submittedReview?: SubmittedReviewRef;
  readonly mergeDecision?: MergeDecisionRef;
  readonly visibleResult?: ReviewResult;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};

export type ActiveBatchBlocksRerun = { readonly _tag: "ActiveBatchBlocksRerun" };
/** An incomplete remote write must be inspected instead of discarded for rerun. */
export type ReviewBatchRemediationRequired = {
  readonly _tag: "ReviewBatchRemediationRequired";
  readonly batchState: "Applying" | "PartialFailure" | "Conflicting";
};
export type SessionImmutable = { readonly _tag: "SessionImmutable" };
export type CannotAllocateAttempt = { readonly _tag: "CannotAllocateAttempt" };
export type AttemptNotCurrent = { readonly _tag: "AttemptNotCurrent" };
export type AttemptSessionMismatch = { readonly _tag: "AttemptSessionMismatch" };

/** Construct a new deterministic session without filesystem or GitHub effects. */
export function createReviewSession(input: {
  readonly key: ReviewSessionKey;
  readonly pr: PullRequestSnapshot;
  readonly prContext?: ReviewSession["prContext"];
  readonly patchPath: AbsolutePath;
  readonly scope?: ReviewScope;
  readonly worktree: ReviewWorktreeRef;
  readonly createdAt: IsoTimestamp;
  readonly batch?: Pick<ReviewBatch, "state">;
}): ReviewSession {
  return {
    schemaVersion: 3,
    id: createReviewSessionId(input.key),
    key: input.key,
    pr: input.pr,
    ...(input.prContext === undefined ? {} : { prContext: input.prContext }),
    patchPath: input.patchPath,
    scope: input.scope ?? { kind: "full" },
    worktree: input.worktree,
    state: { _tag: "Created" },
    ...(input.batch === undefined ? {} : { batch: input.batch }),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** Start a new current attempt unless a batch is active or the session is terminal. */
export function startNextAttempt(
  session: ReviewSession,
  existingFolderNames: ReadonlyArray<string>,
): Result<{ readonly session: ReviewSession; readonly attemptId: ReviewAttemptId }, ActiveBatchBlocksRerun | SessionImmutable | CannotAllocateAttempt> {
  if (session.state._tag === "Merged") {
    return err({ _tag: "SessionImmutable" });
  }
  const batchEvidence = currentBatchStates(session);
  if (
    !batchEvidence.consistent ||
    batchEvidence.states.some((state) => hasActiveReviewBatch({ state }))
  ) {
    return err({ _tag: "ActiveBatchBlocksRerun" });
  }

  const attemptId = allocateNextReviewAttemptId(existingFolderNames);
  if (attemptId._tag === "err") {
    return err({ _tag: "CannotAllocateAttempt" });
  }
  const sessionForNextAttempt =
    batchEvidence.states[0]?._tag === "Submitted" ||
    batchEvidence.states[0]?._tag === "Completed"
      ? withoutReviewBatch(session)
      : session;

  return ok({
    attemptId: attemptId.value,
    session: {
      ...sessionForNextAttempt,
      currentAttemptId: attemptId.value,
      state: { _tag: "Running", attemptId: attemptId.value },
    },
  });
}

/**
 * Remove discardable batch work after explicit rerun confirmation.
 * Applying and outcome-unknown failures require remediation so remote evidence survives.
 */
export function discardBatchForRerun(
  session: ReviewSession,
  confirmedAt: IsoTimestamp,
): Result<ReviewSession, ReviewBatchRemediationRequired> {
  const batchEvidence = currentBatchStates(session);
  const remediationState = batchEvidence.states.find(
    requiresBatchRemediation,
  );
  if (remediationState !== undefined) {
    return err({
      _tag: "ReviewBatchRemediationRequired",
      batchState: remediationState._tag,
    });
  }
  if (!batchEvidence.consistent) {
    return err({
      _tag: "ReviewBatchRemediationRequired",
      batchState: "Conflicting",
    });
  }

  return ok({
    ...withoutReviewBatch(session),
    updatedAt: confirmedAt,
  });
}

function currentBatchStates(
  session: Pick<ReviewSession, "batch" | "batchContent">,
): {
  readonly states: ReadonlyArray<ReviewBatch["state"]>;
  readonly consistent: boolean;
} {
  const summary = session.batch?.state;
  const content = session.batchContent?.state;
  if (summary !== undefined && content !== undefined) {
    return {
      states: [summary, content],
      consistent: sameBatchState(summary, content),
    };
  }
  if (summary !== undefined) {
    return { states: [summary], consistent: true };
  }
  if (content !== undefined) return { states: [content], consistent: true };
  return { states: [], consistent: true };
}

function sameBatchState(
  left: ReviewBatch["state"],
  right: ReviewBatch["state"],
): boolean {
  switch (left._tag) {
    case "Local":
    case "Completed":
      return right._tag === left._tag;
    case "PendingReview":
      return right._tag === "PendingReview" && left.reviewId === right.reviewId;
    case "Submitted":
      return (
        right._tag === "Submitted" &&
        left.reviewId === right.reviewId &&
        left.event === right.event
      );
    case "Applying":
      return (
        right._tag === "Applying" &&
        sameBatchOperation(left.operation, right.operation)
      );
    case "PartialFailure":
      return (
        right._tag === "PartialFailure" &&
        sameBatchOperation(left.operation, right.operation) &&
        left.failure.category === right.failure.category &&
        left.failure.message === right.failure.message
      );
  }
}

function sameBatchOperation(
  left: Extract<ReviewBatch["state"], { readonly operation: unknown }>["operation"],
  right: Extract<ReviewBatch["state"], { readonly operation: unknown }>["operation"],
): boolean {
  switch (left._tag) {
    case "CreatePendingReview":
      return (
        right._tag === "CreatePendingReview" &&
        left.itemIds.length === right.itemIds.length &&
        left.itemIds.every((itemId, index) => itemId === right.itemIds[index])
      );
    case "Reply":
      return right._tag === "Reply" && left.itemId === right.itemId;
    case "ThreadState":
      return right._tag === "ThreadState" && left.itemId === right.itemId;
  }
}

function requiresBatchRemediation(
  state: ReviewBatch["state"],
): state is Extract<ReviewBatch["state"], { readonly _tag: "Applying" | "PartialFailure" }> {
  return (
    state._tag === "Applying" ||
    (state._tag === "PartialFailure" &&
      state.failure.category === "outcome_unknown")
  );
}

function withoutReviewBatch(session: ReviewSession): ReviewSession {
  const {
    batch: discardedBatch,
    batchContent: discardedBatchContent,
    ...sessionWithoutBatch
  } = session;
  void discardedBatch;
  void discardedBatchContent;
  return sessionWithoutBatch;
}

/** Complete the current attempt, or make a late completion harmless and visible on that attempt. */
export function completeAttempt(
  session: ReviewSession,
  attempt: Pick<ReviewAttempt, "id" | "sessionId" | "state">,
  result: ReviewResult,
  completedAt: IsoTimestamp,
  resultPath: AbsolutePath,
): Result<{ readonly session: ReviewSession; readonly attempt: Pick<ReviewAttempt, "id" | "sessionId" | "state"> }, SessionImmutable | AttemptSessionMismatch> {
  if (session.state._tag === "Merged") {
    return err({ _tag: "SessionImmutable" });
  }
  if (attempt.sessionId !== session.id) {
    return err({ _tag: "AttemptSessionMismatch" });
  }

  if (
    session.state._tag !== "Running" ||
    session.state.attemptId !== attempt.id ||
    session.currentAttemptId !== attempt.id ||
    (attempt.state._tag !== "Starting" && attempt.state._tag !== "Running")
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
export function markSessionMerged(
  session: ReviewSession,
  mergedAt: IsoTimestamp,
): Result<ReviewSession, SessionImmutable> {
  if (session.state._tag === "Merged") {
    return err({ _tag: "SessionImmutable" });
  }

  return ok({
    ...session,
    state: { _tag: "Merged", mergedAt },
    mergeDecision: { mergedAt },
    updatedAt: mergedAt,
  });
}
