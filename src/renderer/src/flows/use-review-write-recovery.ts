import { useCallback, useRef, useState } from "react";

import { requestJson } from "../api-client";
import {
  parseWorkbenchResponse,
  type RemoteWriteRecovery,
  type WorkbenchResponse,
} from "../renderer-contracts";
import { useLatestCommitted } from "../hooks/use-latest-committed";

type ReviewWriteRecoveryError = "check_failed" | "invalid_response";

type ScopedRecovery = {
  readonly reviewKey: string;
  readonly recovery: RemoteWriteRecovery;
};

type ScopedRecoveryError = {
  readonly reviewKey: string;
  readonly error: ReviewWriteRecoveryError;
};

export type ReviewWriteRecoveryController = {
  readonly githubWritesLocked: boolean;
  readonly recovery: RemoteWriteRecovery | undefined;
  readonly recoveryError: ReviewWriteRecoveryError | undefined;
  readonly checking: boolean;
  readonly checkGitHubAgain: () => Promise<void>;
  readonly requireRecovery: (
    operation: RemoteWriteRecovery["operation"],
  ) => void;
};

function workbenchReviewKey(workbench: WorkbenchResponse): string {
  return `${workbench.session.key.profileId}:${workbench.review.id}`;
}

/** Owns the durable and renderer-raised recovery lock for one Review. */
export function useReviewWriteRecovery({
  workbench,
  onWorkbenchReplace,
}: {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
}): ReviewWriteRecoveryController {
  const [ephemeralRecoveryState, setEphemeralRecoveryState] = useState<
    ScopedRecovery | undefined
  >(undefined);
  const [recoveryErrorState, setRecoveryErrorState] = useState<
    ScopedRecoveryError | undefined
  >(undefined);
  const [checkingReviewKey, setCheckingReviewKey] = useState<
    string | undefined
  >(undefined);
  const checkInFlightRef = useRef<
    | { readonly reviewKey: string; readonly operation: Promise<void> }
    | undefined
  >(undefined);
  const workbenchRef = useLatestCommitted(workbench);
  const replaceRef = useLatestCommitted(onWorkbenchReplace);
  const reviewKey = workbenchReviewKey(workbench);
  const ephemeralRecovery =
    ephemeralRecoveryState?.reviewKey === reviewKey
      ? ephemeralRecoveryState.recovery
      : undefined;
  const recoveryError =
    recoveryErrorState?.reviewKey === reviewKey
      ? recoveryErrorState.error
      : undefined;
  const recovery = workbench.remoteWriteRecovery ?? ephemeralRecovery;
  const recoveryRef = useLatestCommitted(recovery);

  const requireRecovery = useCallback(
    (operation: RemoteWriteRecovery["operation"]): void => {
      setEphemeralRecoveryState({
        reviewKey,
        recovery: { operation, resolution: "check_required" },
      });
      setRecoveryErrorState(undefined);
    },
    [reviewKey],
  );

  const checkGitHubAgain = useCallback((): Promise<void> => {
    const active = recoveryRef.current;
    if (
      active === undefined ||
      active.resolution === "manual_resolution_required"
    )
      return Promise.resolve();

    const inFlight = checkInFlightRef.current;
    if (inFlight?.reviewKey === reviewKey) return inFlight.operation;

    const operation = (async (): Promise<void> => {
      setCheckingReviewKey(reviewKey);
      setRecoveryErrorState(undefined);
      try {
        const current = workbenchRef.current;
        const value = await requestJson("/v1/reviews/write/recover", {
          method: "POST",
          body: {
            profileId: current.session.key.profileId,
            reviewId: current.review.id,
          },
        });
        const next = parseWorkbenchResponse(value);
        if (workbenchReviewKey(workbenchRef.current) !== reviewKey) return;
        if (next === undefined) {
          setRecoveryErrorState({ reviewKey, error: "invalid_response" });
          return;
        }
        setEphemeralRecoveryState(undefined);
        replaceRef.current(next);
      } catch {
        if (workbenchReviewKey(workbenchRef.current) === reviewKey)
          setRecoveryErrorState({ reviewKey, error: "check_failed" });
      } finally {
        setCheckingReviewKey((activeReviewKey) =>
          activeReviewKey === reviewKey ? undefined : activeReviewKey,
        );
      }
    })();
    checkInFlightRef.current = { reviewKey, operation };
    void operation.finally(() => {
      if (checkInFlightRef.current?.operation === operation)
        checkInFlightRef.current = undefined;
    });
    return operation;
  }, [recoveryRef, replaceRef, reviewKey, workbenchRef]);

  return {
    githubWritesLocked: recovery !== undefined,
    recovery,
    recoveryError,
    checking: checkingReviewKey === reviewKey,
    checkGitHubAgain,
    requireRecovery,
  };
}
