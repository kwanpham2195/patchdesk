import { useCallback, useRef, useState } from "react";
import { PatchdeskApiError, requestJson } from "../api-client";
import { useBusy } from "../hooks/use-busy";
import {
  inboxIdentityKey,
  parseWorkbenchResponse,
} from "../renderer-contracts";
import type { InboxResponse } from "../renderer-contracts";
import type { Dashboard, WorkbenchPayload } from "../renderer-models";

type PrRef = {
  readonly host?: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

export type InboxReviewOpeningControls = {
  readonly openedPr: string | undefined;
  readonly openError: string | undefined;
  readonly openingOperations: ReadonlyMap<string, ReviewOpeningOperation>;
  readonly openInboxRow: (row: InboxResponse["inbox"]["rows"][number]) => void;
  readonly openStoredReviewById: (
    profileId: string,
    reviewId: string,
    isActive: () => boolean,
  ) => Promise<void>;
};

type ReviewOpeningOperation = {
  readonly status: "opening" | "error";
  readonly error?: string;
};

/**
 * Owns a Review-opening operation by stable pull-request identity. A ref
 * admits the operation before an await so the row, inspector, and keyboard
 * entry points cannot each start the same open request in one event turn.
 */
export function useInboxReviewOpening({
  dashboard,
  onOpenWorkbench,
}: {
  readonly dashboard: Dashboard | undefined;
  readonly onOpenWorkbench: (workbench: WorkbenchPayload) => void;
}): InboxReviewOpeningControls {
  const [openedPr, setOpenedPr] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const operationsRef = useRef<Map<string, ReviewOpeningOperation>>(new Map());
  const [openingOperations, setOpeningOperations] = useState<
    ReadonlyMap<string, ReviewOpeningOperation>
  >(operationsRef.current);
  const { runBusy } = useBusy();

  const loadPullRequest = useCallback(
    async (
      pr: PrRef,
      profileId = dashboard?.profile.id,
      endpoint:
        | "/v1/reviews/open"
        | "/v1/reviews/open-merged" = "/v1/reviews/open",
    ): Promise<void> => {
      const value = await requestJson(endpoint, {
        method: "POST",
        body: {
          profileId,
          host: pr.host ?? dashboard?.profile.githubHost ?? "github.com",
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
        },
      });
      const parsed = parseWorkbenchResponse(value);
      if (parsed === undefined) throw new Error("Invalid workbench projection");
      setOpenedPr(`${pr.owner}/${pr.repo}#${pr.number}`);
      onOpenWorkbench(parsed);
    },
    [dashboard?.profile.githubHost, dashboard?.profile.id, onOpenWorkbench],
  );

  const loadStoredReview = useCallback(
    async (
      profileId: string,
      reviewId: string,
      identity?: PrRef,
      isActive: () => boolean = () => true,
    ): Promise<void> => {
      try {
        const value = await requestJson("/v1/reviews/load", {
          method: "POST",
          body: { profileId, reviewId },
        });
        const parsed = parseWorkbenchResponse(value);
        if (parsed === undefined)
          throw new Error("The review projection could not be validated.");
        if (isActive()) onOpenWorkbench(parsed);
      } catch (cause: unknown) {
        // Opening by identity heals a missing or obsolete saved record.
        if (identity !== undefined) await loadPullRequest(identity);
        else throw cause;
      }
    },
    [loadPullRequest, onOpenWorkbench],
  );

  const openStoredReviewById = useCallback(
    async (
      profileId: string,
      reviewId: string,
      isActive: () => boolean,
    ): Promise<void> => {
      const openingKey = `review:${profileId}:${reviewId}`;
      if (operationsRef.current.get(openingKey)?.status === "opening") return;
      const operation: ReviewOpeningOperation = { status: "opening" };
      const admitted = new Map(operationsRef.current);
      admitted.set(openingKey, operation);
      operationsRef.current = admitted;
      setOpeningOperations(admitted);
      setOpenError(undefined);
      try {
        await runBusy(
          () => loadStoredReview(profileId, reviewId, undefined, isActive),
          "Loading review…",
        );
      } catch (cause: unknown) {
        if (!isActive() || operationsRef.current.get(openingKey) !== operation)
          return;
        const detail = cause instanceof Error ? cause.message : String(cause);
        setOpenError(`Could not open the saved review. ${detail}`);
      } finally {
        if (operationsRef.current.get(openingKey) === operation) {
          const settled = new Map(operationsRef.current);
          settled.delete(openingKey);
          operationsRef.current = settled;
          setOpeningOperations(settled);
        }
      }
    },
    [loadStoredReview, runBusy],
  );

  const openInboxRow = useCallback(
    (row: InboxResponse["inbox"]["rows"][number]): void => {
      const openingKey = inboxIdentityKey(row);
      if (operationsRef.current.get(openingKey)?.status === "opening") return;

      const operation: ReviewOpeningOperation = { status: "opening" };
      const admitted = new Map(operationsRef.current);
      admitted.set(openingKey, operation);
      operationsRef.current = admitted;
      setOpeningOperations(admitted);
      setOpenedPr(undefined);
      setOpenError(undefined);

      const request = async (): Promise<void> => {
        if (
          row.recommendedAction.kind === "open_saved_review" ||
          row.recommendedAction.kind === "open_merge_readiness"
        ) {
          const profileId = dashboard?.profile.id;
          if (profileId === undefined) return;
          await loadStoredReview(
            profileId,
            row.recommendedAction.reviewId,
            row.identity,
          );
          return;
        }
        await loadPullRequest(
          row.identity,
          undefined,
          row.recommendedAction.kind === "open_merged_review"
            ? "/v1/reviews/open-merged"
            : "/v1/reviews/open",
        );
      };

      void runBusy(request, "Opening Review…")
        .catch((cause: unknown) => {
          if (operationsRef.current.get(openingKey) !== operation) return;
          const detail =
            cause instanceof PatchdeskApiError && cause.kind === "auth"
              ? "GitHub authentication is required. Run gh auth login for the exact GitHub account entered in Settings -> Workspace."
              : cause instanceof Error
                ? cause.message
                : String(cause);
          const failed = new Map(operationsRef.current);
          failed.set(openingKey, {
            status: "error",
            error: `Could not prepare ${row.identity.owner}/${row.identity.repo}#${row.identity.number}. ${detail}`,
          });
          operationsRef.current = failed;
          setOpeningOperations(failed);
        })
        .finally(() => {
          if (operationsRef.current.get(openingKey) !== operation) return;
          const settled = new Map(operationsRef.current);
          settled.delete(openingKey);
          operationsRef.current = settled;
          setOpeningOperations(settled);
        });
    },
    [dashboard?.profile.id, loadPullRequest, loadStoredReview, runBusy],
  );

  return {
    openedPr,
    openError,
    openingOperations,
    openInboxRow,
    openStoredReviewById,
  };
}
