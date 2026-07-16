import type { ReviewAttempt } from "../domain/review-attempt";
import type { DraftComment, ReviewDraft } from "../domain/review-draft";
import type { ReviewFinding, ReviewResult } from "../domain/review-result";
import {
  discardCurrentAttempt,
  type ReviewSession,
} from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { IsoTimestamp } from "../domain/ids";

export type LocalDraftProjection = {
  readonly draft: ReviewDraft;
  /** These remain visible in the workbench but deliberately have no GitHub coordinate. */
  readonly unmappedFindings: ReadonlyArray<ReviewFinding>;
};

export type CannotCreateLocalDraft =
  | { readonly _tag: "AttemptNotCurrent" }
  | { readonly _tag: "AttemptSessionMismatch" };
export type StaleHeadBlocksWrite = { readonly _tag: "StaleHeadBlocksWrite" };

/** Build a user-owned draft from locations Patchdesk has already verified. No remote write occurs here. */
export function createLocalDraft(input: {
  readonly session: ReviewSession;
  readonly attempt: Pick<ReviewAttempt, "id" | "sessionId">;
  readonly result: ReviewResult;
  readonly createdAt: IsoTimestamp;
}): Result<LocalDraftProjection, CannotCreateLocalDraft> {
  if (input.attempt.sessionId !== input.session.id)
    return err({ _tag: "AttemptSessionMismatch" });
  if (input.session.currentAttemptId !== input.attempt.id)
    return err({ _tag: "AttemptNotCurrent" });

  const comments: DraftComment[] = [];
  const unmappedFindings: ReviewFinding[] = [];
  for (const finding of input.result.findings) {
    if (!hasPostableLocation(finding)) {
      unmappedFindings.push(finding);
      continue;
    }
    comments.push({
      findingId: finding.id,
      include: true,
      originalSuggestedBody: finding.suggestedComment ?? finding.explanation,
      body: finding.suggestedComment ?? finding.explanation,
      path: finding.file,
      line: finding.lineStart,
      ...(finding.lineEnd === undefined ? {} : { lineEnd: finding.lineEnd }),
      diffSide: finding.diffSide,
      postability: "postable",
    });
  }

  return ok({
    draft: {
      sessionId: input.session.id,
      attemptId: input.attempt.id,
      state: { _tag: "LocalDraft" },
      summaryBody: input.result.summary,
      suggestedEvent: verdictEvent(input.result.verdict),
      comments,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
    unmappedFindings,
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

/** Recover conservatively after restart: no ownership-safe run handle remains, so it is stale rather than resumed. */
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
  if (input.session.state._tag !== "Running" || input.attempt.state._tag !== "Running")
    return err({ _tag: "AttemptNotRunning" });
  return ok({
    session: {
      ...input.session,
      state: { _tag: "Stale", reason: "orphaned_run" },
      updatedAt: input.recoveredAt,
    },
    attempt: {
      ...input.attempt,
      state: {
        _tag: "Failed",
        error: {
          category: "flue",
          message: "Patchdesk restarted before this review run completed.",
        },
      },
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

function verdictEvent(result: ReviewResult["verdict"]): ReviewDraft["suggestedEvent"] {
  if (result === "approve") return "APPROVE";
  if (result === "request_changes") return "REQUEST_CHANGES";
  return "COMMENT";
}
