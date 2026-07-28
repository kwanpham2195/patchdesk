import type { ReviewAttempt } from "../domain/review-attempt";
import type {
  ReviewBatch,
  ReviewBatchItem,
} from "../domain/review-batch";
import type { ReviewFinding, ReviewResult } from "../domain/review-result";
import {
  discardCurrentAttempt,
  type ReviewSession,
} from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import {
  parseLocalReviewItemId,
  type IsoTimestamp,
  type LocalReviewItemId,
} from "../domain/ids";

/** Local review work derived from one completed model attempt. */
export type LocalBatchProjection = {
  readonly batch: ReviewBatch;
  /** These remain visible in the workbench but deliberately have no GitHub coordinate. */
  readonly repositoryFindings: ReadonlyArray<ReviewFinding>;
};

/** A completed attempt cannot be projected onto the supplied session. */
export type CannotCreateReviewBatch =
  | { readonly _tag: "AttemptNotCurrent" }
  | { readonly _tag: "AttemptSessionMismatch" }
  | { readonly _tag: "InvalidFindingItemId" };
export type StaleHeadBlocksWrite = { readonly _tag: "StaleHeadBlocksWrite" };

/** Build a user-owned local batch from locations Patchdesk has already verified. No remote write occurs here. */
export function createReviewBatch(input: {
  readonly session: ReviewSession;
  readonly attempt: Pick<ReviewAttempt, "id" | "sessionId">;
  readonly result: ReviewResult;
  /** Previously submitted findings remain visible but never start as duplicate comments. */
  readonly alreadyReportedFindingIds?: ReadonlySet<ReviewFinding["id"]>;
  readonly createdAt: IsoTimestamp;
}): Result<LocalBatchProjection, CannotCreateReviewBatch> {
  if (input.attempt.sessionId !== input.session.id)
    return err({ _tag: "AttemptSessionMismatch" });
  if (input.session.currentAttemptId !== input.attempt.id)
    return err({ _tag: "AttemptNotCurrent" });

  const items: ReviewBatchItem[] = [];
  const itemIds = new Set<LocalReviewItemId>();
  const repositoryFindings: ReviewFinding[] = [];
  for (const finding of input.result.findings) {
    if (!hasPostableLocation(finding)) {
      repositoryFindings.push(finding);
      continue;
    }
    const itemId = nextFindingItemId(finding.id, itemIds);
    if (itemId === undefined) {
      return err({ _tag: "InvalidFindingItemId" });
    }
    itemIds.add(itemId);
    const alreadyReported = input.alreadyReportedFindingIds?.has(finding.id) ?? false;
    items.push({
      _tag: "InlineComment",
      id: itemId,
      source: "finding",
      findingId: finding.id,
      anchor: {
        path: finding.file,
        startLine: finding.lineStart,
        line: finding.lineEnd ?? finding.lineStart,
        side: finding.diffSide,
      },
      body: finding.suggestedComment ?? finding.explanation,
      include: !alreadyReported,
      postability: alreadyReported ? "already_reported" : "postable",
    });
  }

  return ok({
    batch: {
      sessionId: input.session.id,
      attemptId: input.attempt.id,
      state: { _tag: "Local" },
      summaryBody: input.result.summary,
      suggestedEvent: verdictEvent(input.result.verdict),
      items,
      receipts: [],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
    repositoryFindings,
  });
}

/** The future GitHub adapter must call this immediately before any write. */
export function draftWriteBlocker(
  session: ReviewSession,
  currentHeadSha: ReviewSession["key"]["headSha"],
): StaleHeadBlocksWrite | undefined {
  return session.state._tag === "Stale" || session.key.headSha !== currentHeadSha
    ? { _tag: "StaleHeadBlocksWrite" }
    : undefined;
}

/** Discard only updates local lifecycle records; Patchdesk never claims it aborted Flue. */
export function discardWorkbenchAttempt(input: {
  readonly session: ReviewSession;
  readonly attempt: ReviewAttempt;
  readonly discardedAt: IsoTimestamp;
}): Result<
  { readonly session: ReviewSession; readonly attempt: ReviewAttempt },
  { readonly _tag: "AttemptNotCurrent" } | { readonly _tag: "SessionImmutable" }
> {
  const session = discardCurrentAttempt(
    input.session,
    input.attempt.id,
    input.discardedAt,
  );
  if (session._tag === "err") return session;
  return ok({
    session: session.value,
    attempt: {
      ...input.attempt,
      state: { _tag: "Discarded", discardedAt: input.discardedAt },
      completedAt: input.discardedAt,
    },
  });
}

/** Recover after restart without relaunching work; preserve the interrupted attempt for truthful recovery copy. */
export function recoverOrphanedWorkbenchAttempt(input: {
  readonly session: ReviewSession;
  readonly attempt: ReviewAttempt;
  readonly recoveredAt: IsoTimestamp;
}): Result<
  { readonly session: ReviewSession; readonly attempt: ReviewAttempt },
  { readonly _tag: "AttemptNotCurrent" } | { readonly _tag: "AttemptNotRunning" }
> {
  if (input.session.currentAttemptId !== input.attempt.id)
    return err({ _tag: "AttemptNotCurrent" });
  if (
    input.session.state._tag !== "Running" ||
    (input.attempt.state._tag !== "Starting" && input.attempt.state._tag !== "Running")
  )
    return err({ _tag: "AttemptNotRunning" });
  return ok({
    session: {
      ...input.session,
      updatedAt: input.recoveredAt,
    },
    attempt: {
      ...input.attempt,
      state: { _tag: "Interrupted", interruptedAt: input.recoveredAt },
      completedAt: input.recoveredAt,
    },
  });
}

function hasPostableLocation(
  finding: ReviewFinding,
): finding is ReviewFinding & {
  readonly file: NonNullable<ReviewFinding["file"]>;
  readonly lineStart: number;
  readonly diffSide: "new" | "old";
} {
  return (
    finding.mappingStatus === "mapped" &&
    finding.file !== undefined &&
    finding.lineStart !== undefined &&
    finding.diffSide !== undefined
  );
}

function nextFindingItemId(
  findingId: ReviewFinding["id"],
  usedIds: ReadonlySet<LocalReviewItemId>,
): LocalReviewItemId | undefined {
  let suffix = 1;
  while (suffix <= Number.MAX_SAFE_INTEGER) {
    const candidate = parseLocalReviewItemId(
      suffix === 1 ? findingId : `${findingId}-${suffix}`,
    );
    if (candidate._tag === "err") {
      return undefined;
    }
    if (!usedIds.has(candidate.value)) {
      return candidate.value;
    }
    suffix += 1;
  }
  return undefined;
}

function verdictEvent(
  result: ReviewResult["verdict"],
): ReviewBatch["suggestedEvent"] {
  if (result === "approve") return "APPROVE";
  if (result === "request_changes") return "REQUEST_CHANGES";
  return "COMMENT";
}
