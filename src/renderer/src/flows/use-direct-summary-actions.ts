import { useCallback, useRef, useState } from "react";

import {
  contextualMessage,
  isOutcomeUnknownRetry,
  requestJson,
} from "../api-client";
import { DIRECT_SUMMARY_MESSAGES } from "../review-copy";
import {
  parseDirectSummaryReviewResponse,
  type DirectSummaryReviewProjection,
  type WorkbenchResponse,
} from "../renderer-contracts";
import type { GitHubReviewEvent } from "../../../domain/pending-review";
import type {
  RunDirectCommand,
  AppendRecentWrites,
} from "./use-review-observation";

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
    event: GitHubReviewEvent,
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
  const commandInFlightRef = useRef<
    Promise<DirectSummaryReviewProjection> | undefined
  >(undefined);
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
    (
      event: GitHubReviewEvent,
      body: string,
    ): Promise<DirectSummaryReviewProjection> => {
      if (commandInFlightRef.current !== undefined)
        return commandInFlightRef.current;
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        return Promise.reject(
          new Error("The current Diff cannot accept a review summary."),
        );
      const operation = (async (): Promise<DirectSummaryReviewProjection> => {
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
          if (
            result === undefined ||
            result.state === "idle" ||
            (result.state === "confirmed" && result.receipt.event !== event)
          ) {
            setDirectSummaryOverride({
              state: "recovery_required",
              resolution: "check_required",
            });
            throw new Error("Invalid direct summary review response");
          }
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
          if (isOutcomeUnknownRetry(cause))
            setDirectSummaryOverride({
              state: "recovery_required",
              resolution: "check_required",
            });
          setDirectSummaryError(
            contextualMessage(cause, DIRECT_SUMMARY_MESSAGES),
          );
          throw cause;
        } finally {
          commandInFlightRef.current = undefined;
          setDirectSummaryBusy(false);
        }
      })();
      commandInFlightRef.current = operation;
      return operation;
    },
    [
      appendRecentWrites,
      observeDirectSummaryReceipt,
      runDirectCommand,
      workbench,
    ],
  );

  const recoverDirectSummary =
    useCallback((): Promise<DirectSummaryReviewProjection> => {
      if (commandInFlightRef.current !== undefined)
        return commandInFlightRef.current;
      const operation = (async (): Promise<DirectSummaryReviewProjection> => {
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
          setDirectSummaryError(
            contextualMessage(cause, DIRECT_SUMMARY_MESSAGES),
          );
          throw cause;
        } finally {
          commandInFlightRef.current = undefined;
          setDirectSummaryBusy(false);
        }
      })();
      commandInFlightRef.current = operation;
      return operation;
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
