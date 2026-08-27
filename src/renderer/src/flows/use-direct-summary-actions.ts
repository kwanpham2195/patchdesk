import { useCallback, useRef, useState } from "react";

import { PatchdeskApiError, requestJson } from "../api-client";
import {
  parseDirectSummaryReviewResponse,
  type DirectSummaryReviewProjection,
  type WorkbenchResponse,
} from "../renderer-contracts";
import type { RecentReviewWrite } from "../../../domain/recent-review-write";

type RunDirectCommand = <T>(operation: () => Promise<T>) => Promise<T>;
type AppendRecentWrites = (
  entries: RecentReviewWrite | ReadonlyArray<RecentReviewWrite>,
) => void;
type ObserveConfirmedDirectSummary = (reviewId: string) => Promise<void>;

type DirectSummaryPanel = {
  readonly busy: boolean;
  readonly state: DirectSummaryReviewProjection["state"];
  readonly receipt?: Extract<
    DirectSummaryReviewProjection,
    { readonly state: "confirmed" }
  >["receipt"];
  readonly recoveryResolution?: Extract<
    DirectSummaryReviewProjection,
    { readonly state: "recovery_required" }
  >["resolution"];
  readonly approvalCapability: "allowed" | "blocked_author" | "unknown";
  readonly error?: string;
  readonly onSubmit: (
    event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
    body: string,
  ) => Promise<DirectSummaryReviewProjection>;
  readonly onRecover: () => Promise<DirectSummaryReviewProjection>;
};

export type DirectSummaryActionsInput = {
  readonly workbench: WorkbenchResponse;
  readonly runDirectCommand: RunDirectCommand;
  readonly appendRecentWrites: AppendRecentWrites;
  readonly observeConfirmedDirectSummary: ObserveConfirmedDirectSummary;
};

export type DirectSummaryActionsResult = {
  readonly directSummary: DirectSummaryPanel | undefined;
};

function boundedDirectSummaryError(cause: unknown): string {
  if (cause instanceof PatchdeskApiError) {
    if (
      cause.kind === "outcome_unknown" ||
      cause.kind === "ambiguous_write" ||
      cause.kind === "timeout"
    )
      return "GitHub could not confirm the submission. Check GitHub again before trying again.";
    if (cause.kind === "review_write_in_progress")
      return "Another action is still finishing. Your review was not submitted. Wait a moment, then submit again.";
    if (cause.kind === "pending_review")
      return "A pending review already exists. Refresh, then finish or discard that review before submitting a summary.";
    if (cause.kind === "self_approval_not_allowed")
      return "You can’t approve your own pull request. Choose Comment or ask another reviewer to approve it.";
    if (cause.kind === "stale_head")
      return "The pull request changed. Refresh before submitting a review summary.";
    if (cause.kind === "rejected" || cause.kind === "github_rejected")
      return "GitHub rejected the review summary.";
    if (cause.kind === "forbidden")
      return "GitHub blocked this review summary: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.";
  }
  return "Patchdesk could not submit this review summary. Check GitHub again or refresh.";
}

function directSummarySignature(
  projection: DirectSummaryReviewProjection,
): string {
  if (projection.state === "confirmed")
    return `confirmed:${projection.receipt.reviewId}:${projection.receipt.event}`;
  if (projection.state === "recovery_required")
    return `recovery_required:${projection.resolution}`;
  return "idle";
}

/** Owns direct-summary submit/recovery state and confirmed-receipt observation. */
export function useDirectSummaryActions({
  workbench,
  runDirectCommand,
  appendRecentWrites,
  observeConfirmedDirectSummary,
}: DirectSummaryActionsInput): DirectSummaryActionsResult {
  const [directSummaryBusy, setDirectSummaryBusy] = useState(false);
  const [directSummaryError, setDirectSummaryError] = useState<
    string | undefined
  >(undefined);
  const [directSummaryOverride, setDirectSummaryOverride] = useState<
    DirectSummaryReviewProjection | undefined
  >(undefined);
  const [observedDirectSummarySignature, setObservedDirectSummarySignature] =
    useState<string | undefined>(undefined);
  const projectedDirectSummary: DirectSummaryReviewProjection =
    workbench.directSummary ?? { state: "idle" };
  const projectedDirectSummarySignature = directSummarySignature(
    projectedDirectSummary,
  );
  if (projectedDirectSummarySignature !== observedDirectSummarySignature) {
    setObservedDirectSummarySignature(projectedDirectSummarySignature);
    setDirectSummaryOverride(undefined);
  }
  const observedDirectSummaryRef = useRef<string | undefined>(undefined);
  const visibleDirectSummaryState =
    directSummaryOverride ?? projectedDirectSummary;
  const observeDirectSummaryReceipt = useCallback(
    (reviewId: string): void => {
      if (observedDirectSummaryRef.current === reviewId) return;
      observedDirectSummaryRef.current = reviewId;
      void observeConfirmedDirectSummary(reviewId).catch(() => {
        // This read-only observer never retries the GitHub write.
      });
    },
    [observeConfirmedDirectSummary],
  );

  const submitDirectSummary = useCallback(
    async (
      event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
      body: string,
    ): Promise<DirectSummaryReviewProjection> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot accept a review summary.");
      setDirectSummaryBusy(true);
      try {
        const value = await runDirectCommand(() =>
          requestJson("/v1/reviews/direct-summary/submit", {
            method: "POST",
            body: {
              profileId: workbench.session.key.profileId,
              reviewId: workbench.review.id,
              expected: {
                sessionId: workbench.session.id,
                headSha: workbench.revision.reviewedHeadSha,
                patchHash,
              },
              event,
              body,
            },
          }),
        );
        const result = parseDirectSummaryReviewResponse(value);
        if (result === undefined)
          throw new Error("Invalid direct summary review response");
        setDirectSummaryOverride(result);
        if (result.state === "confirmed") {
          const write = {
            _tag: "DirectSummaryReview" as const,
            reviewId: result.receipt.reviewId,
          };
          appendRecentWrites(write);
          observeDirectSummaryReceipt(result.receipt.reviewId);
        }
        setDirectSummaryError(undefined);
        return result;
      } catch (cause) {
        if (
          cause instanceof PatchdeskApiError &&
          (cause.kind === "outcome_unknown" ||
            cause.kind === "ambiguous_write" ||
            cause.kind === "timeout")
        )
          setDirectSummaryOverride({
            state: "recovery_required",
            resolution: "check_required",
          });
        setDirectSummaryError(boundedDirectSummaryError(cause));
        throw cause;
      } finally {
        setDirectSummaryBusy(false);
      }
    },
    [
      appendRecentWrites,
      observeDirectSummaryReceipt,
      runDirectCommand,
      workbench,
    ],
  );

  const recoverDirectSummary =
    useCallback(async (): Promise<DirectSummaryReviewProjection> => {
      setDirectSummaryBusy(true);
      try {
        const value = await runDirectCommand(() =>
          requestJson("/v1/reviews/direct-summary/recover", {
            method: "POST",
            body: {
              profileId: workbench.session.key.profileId,
              reviewId: workbench.review.id,
            },
          }),
        );
        const result = parseDirectSummaryReviewResponse(value);
        if (result === undefined)
          throw new Error("Invalid direct summary recovery response");
        setDirectSummaryOverride(result);
        if (result.state === "confirmed") {
          appendRecentWrites({
            _tag: "DirectSummaryReview",
            reviewId: result.receipt.reviewId,
          });
          observeDirectSummaryReceipt(result.receipt.reviewId);
        }
        setDirectSummaryError(undefined);
        return result;
      } catch (cause) {
        setDirectSummaryError(boundedDirectSummaryError(cause));
        throw cause;
      } finally {
        setDirectSummaryBusy(false);
      }
    }, [
      appendRecentWrites,
      observeDirectSummaryReceipt,
      runDirectCommand,
      workbench,
    ]);

  const directSummaryPanelBase: DirectSummaryPanel = {
    busy: directSummaryBusy,
    state: visibleDirectSummaryState.state,
    approvalCapability: workbench.directSummaryDecision ?? "unknown",
    onSubmit: submitDirectSummary,
    onRecover: recoverDirectSummary,
  };
  const directSummaryPanelWithReceipt =
    visibleDirectSummaryState.state === "confirmed"
      ? {
          ...directSummaryPanelBase,
          receipt: visibleDirectSummaryState.receipt,
        }
      : directSummaryPanelBase;
  const directSummaryPanelWithRecovery =
    visibleDirectSummaryState.state === "recovery_required"
      ? {
          ...directSummaryPanelWithReceipt,
          recoveryResolution: visibleDirectSummaryState.resolution,
        }
      : directSummaryPanelWithReceipt;
  const directSummaryPanelWithError =
    directSummaryError === undefined
      ? directSummaryPanelWithRecovery
      : { ...directSummaryPanelWithRecovery, error: directSummaryError };
  const directSummary =
    workbench.pendingReview?.state === "none"
      ? directSummaryPanelWithError
      : undefined;

  return { directSummary };
}
