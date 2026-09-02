import { useCallback, useRef, useState } from "react";
import { PatchdeskApiError, requestJson } from "../api-client";
import { useBusy } from "../hooks/use-busy";
import { useLatestCommitted } from "../hooks/use-latest-committed";
import {
  parseWorkbenchResponse,
  pullRequestIdentityKey,
} from "../renderer-contracts";
import type { InboxResponse } from "../renderer-contracts";
import type { Dashboard, WorkbenchPayload } from "../renderer-models";
import type { PullRequestRef } from "../../../domain/pull-request";

type PrRef = {
  readonly host?: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

/** A pull request named completely enough to key an opening operation. */
type IdentifiedPrRef = PrRef & { readonly host: string };

export type InboxReviewOpeningControls = {
  readonly openedPr: string | undefined;
  readonly openError: string | undefined;
  readonly openingOperations: ReadonlyMap<string, ReviewOpeningRowOperation>;
  readonly openInboxRow: (row: InboxResponse["inbox"]["rows"][number]) => void;
  /** Opens a pull request named directly — by a pasted link — rather than by
   * a listed row, under the same operation owner the row entry points use. */
  readonly openPullRequestByRef: (ref: PullRequestRef) => void;
  readonly openStoredReviewById: (
    profileId: string,
    reviewId: string,
    isActive: () => boolean,
  ) => Promise<void>;
  /** Raises the screen's "Could not open review" alert for a refusal decided
   * in the renderer, so it clears with the same profile and open rules. */
  readonly reportOpenError: (message: string) => void;
};

type ReviewOpeningOperation = {
  readonly profileId: string;
  readonly rowKey?: string;
  readonly status: "opening" | "error";
  readonly error?: string;
};

type ReviewOpeningRowOperation = {
  readonly status: "opening" | "error";
  readonly error?: string;
};

/**
 * Owns a Review-opening operation by profile and stable pull-request identity.
 * A ref admits the operation before an await so the row, inspector, and
 * keyboard entry points cannot each start the same request in one event turn.
 */
export function useInboxReviewOpening({
  dashboard,
  onOpenWorkbench,
}: {
  readonly dashboard: Dashboard | undefined;
  readonly onOpenWorkbench: (workbench: WorkbenchPayload) => void;
}): InboxReviewOpeningControls {
  const dashboardProfileId = dashboard?.profile.id;
  const dashboardProfileIdRef = useLatestCommitted(dashboardProfileId);
  const [openedPrByProfile, setOpenedPrByProfile] = useState<
    ReadonlyMap<string, string>
  >(new Map());
  const [openErrorByProfile, setOpenErrorByProfile] = useState<
    ReadonlyMap<string, string>
  >(new Map());
  const operationsRef = useRef<Map<string, ReviewOpeningOperation>>(new Map());
  const [operations, setOperations] = useState<
    ReadonlyMap<string, ReviewOpeningOperation>
  >(operationsRef.current);
  const { runBusy } = useBusy();

  const loadPullRequest = useCallback(
    async (
      pr: PrRef,
      profileId: string,
      githubHost: string,
      endpoint:
        | "/v1/reviews/open"
        | "/v1/reviews/open-merged" = "/v1/reviews/open",
      isActive: () => boolean,
    ): Promise<void> => {
      const value = await requestJson(endpoint, {
        method: "POST",
        body: {
          profileId,
          host: pr.host ?? githubHost,
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
        },
      });
      const parsed = parseWorkbenchResponse(value);
      if (parsed === undefined) throw new Error("Invalid workbench projection");
      if (!isActive()) return;
      setOpenedPrByProfile((openedPr) => {
        const next = new Map(openedPr);
        next.set(profileId, `${pr.owner}/${pr.repo}#${pr.number}`);
        return next;
      });
      onOpenWorkbench(parsed);
    },
    [onOpenWorkbench],
  );

  const loadStoredReview = useCallback(
    async (
      profileId: string,
      githubHost: string,
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
        if (!isActive()) return;
        // Opening by identity heals a missing or obsolete saved record.
        if (identity !== undefined)
          await loadPullRequest(
            identity,
            profileId,
            githubHost,
            "/v1/reviews/open",
            isActive,
          );
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
      const githubHost = dashboard?.profile.githubHost ?? "github.com";
      if (dashboardProfileIdRef.current !== profileId) return;
      const operationKey = `review:${profileId}:${reviewId}`;
      if (operationsRef.current.get(operationKey)?.status === "opening") return;
      const operation: ReviewOpeningOperation = {
        profileId,
        status: "opening",
      };
      const admitted = new Map(operationsRef.current);
      admitted.set(operationKey, operation);
      operationsRef.current = admitted;
      setOperations(admitted);
      setOpenErrorByProfile((openErrors) => {
        const next = new Map(openErrors);
        next.delete(profileId);
        return next;
      });
      const isOperationActive = () =>
        dashboardProfileIdRef.current === profileId && isActive();
      try {
        await runBusy(
          () =>
            loadStoredReview(
              profileId,
              githubHost,
              reviewId,
              undefined,
              isOperationActive,
            ),
          "Loading review…",
        );
      } catch (cause: unknown) {
        if (
          !isOperationActive() ||
          operationsRef.current.get(operationKey) !== operation
        )
          return;
        const detail = cause instanceof Error ? cause.message : String(cause);
        setOpenErrorByProfile((openErrors) => {
          const next = new Map(openErrors);
          next.set(profileId, `Could not open the saved review. ${detail}`);
          return next;
        });
      } finally {
        if (operationsRef.current.get(operationKey) === operation) {
          const settled = new Map(operationsRef.current);
          settled.delete(operationKey);
          operationsRef.current = settled;
          setOperations(settled);
        }
      }
    },
    [
      dashboard?.profile.githubHost,
      dashboardProfileIdRef,
      loadStoredReview,
      runBusy,
    ],
  );

  /**
   * Admits one opening operation for `identity` under the active profile and
   * runs `request` inside it. Every entry point — the row title, a
   * double-click, Enter, the inspector, the palette, and a pasted
   * pull-request link — comes through here, so two of them naming the same
   * pull request in one event turn still send one request.
   */
  const openByIdentity = useCallback(
    (
      identity: IdentifiedPrRef,
      request: (
        profileId: string,
        githubHost: string,
        isActive: () => boolean,
      ) => Promise<void>,
    ): void => {
      const profileId = dashboard?.profile.id;
      const githubHost = dashboard?.profile.githubHost ?? "github.com";
      if (profileId === undefined) return;
      const rowKey = pullRequestIdentityKey(identity);
      const operationKey = `row:${profileId}:${rowKey}`;
      if (operationsRef.current.get(operationKey)?.status === "opening") return;

      const operation: ReviewOpeningOperation = {
        profileId,
        rowKey,
        status: "opening",
      };
      const admitted = new Map(operationsRef.current);
      admitted.set(operationKey, operation);
      operationsRef.current = admitted;
      setOperations(admitted);
      setOpenedPrByProfile((openedPr) => {
        const next = new Map(openedPr);
        next.delete(profileId);
        return next;
      });
      setOpenErrorByProfile((openErrors) => {
        const next = new Map(openErrors);
        next.delete(profileId);
        return next;
      });
      const isOperationActive = () =>
        dashboardProfileIdRef.current === profileId;

      void runBusy(
        () => request(profileId, githubHost, isOperationActive),
        "Opening Review…",
      )
        .catch((cause: unknown) => {
          if (
            !isOperationActive() ||
            operationsRef.current.get(operationKey) !== operation
          )
            return;
          const detail =
            cause instanceof PatchdeskApiError && cause.kind === "auth"
              ? "GitHub authentication is required. Run gh auth login for the exact GitHub account entered in Settings -> Workspace."
              : cause instanceof Error
                ? cause.message
                : String(cause);
          const failed = new Map(operationsRef.current);
          failed.set(operationKey, {
            profileId,
            rowKey,
            status: "error",
            error: `Could not prepare ${identity.owner}/${identity.repo}#${identity.number}. ${detail}`,
          });
          operationsRef.current = failed;
          setOperations(failed);
        })
        .finally(() => {
          if (operationsRef.current.get(operationKey) !== operation) return;
          const settled = new Map(operationsRef.current);
          settled.delete(operationKey);
          operationsRef.current = settled;
          setOperations(settled);
        });
    },
    [
      dashboard?.profile.githubHost,
      dashboard?.profile.id,
      dashboardProfileIdRef,
      runBusy,
    ],
  );

  const openInboxRow = useCallback(
    (row: InboxResponse["inbox"]["rows"][number]): void => {
      openByIdentity(row.identity, (profileId, githubHost, isActive) => {
        if (row.recommendedAction.kind === "open_saved_review")
          return loadStoredReview(
            profileId,
            githubHost,
            row.recommendedAction.reviewId,
            row.identity,
            isActive,
          );
        return loadPullRequest(
          row.identity,
          profileId,
          githubHost,
          row.recommendedAction.kind === "open_merged_review"
            ? "/v1/reviews/open-merged"
            : "/v1/reviews/open",
          isActive,
        );
      });
    },
    [loadPullRequest, loadStoredReview, openByIdentity],
  );

  const openPullRequestByRef = useCallback(
    (ref: PullRequestRef): void => {
      // A ref names no saved review, so this always reads the pull request
      // fresh; a saved review for it is resumed by the row entry points.
      openByIdentity(ref, (profileId, githubHost, isActive) =>
        loadPullRequest(
          ref,
          profileId,
          githubHost,
          "/v1/reviews/open",
          isActive,
        ),
      );
    },
    [loadPullRequest, openByIdentity],
  );

  const reportOpenError = useCallback(
    (message: string): void => {
      const profileId = dashboard?.profile.id;
      if (profileId === undefined) return;
      setOpenErrorByProfile((openErrors) => {
        const next = new Map(openErrors);
        next.set(profileId, message);
        return next;
      });
    },
    [dashboard?.profile.id],
  );

  return {
    openedPr:
      dashboardProfileId === undefined
        ? undefined
        : openedPrByProfile.get(dashboardProfileId),
    openError:
      dashboardProfileId === undefined
        ? undefined
        : openErrorByProfile.get(dashboardProfileId),
    openingOperations: projectCurrentProfileOpeningOperations(
      operations,
      dashboardProfileId,
    ),
    openInboxRow,
    openPullRequestByRef,
    openStoredReviewById,
    reportOpenError,
  };
}

function projectCurrentProfileOpeningOperations(
  operations: ReadonlyMap<string, ReviewOpeningOperation>,
  profileId: string | undefined,
): ReadonlyMap<string, ReviewOpeningRowOperation> {
  const projected = new Map<string, ReviewOpeningRowOperation>();
  if (profileId === undefined) return projected;
  for (const operation of operations.values()) {
    if (operation.profileId !== profileId || operation.rowKey === undefined)
      continue;
    const rowOperation =
      operation.error === undefined
        ? { status: operation.status }
        : { status: operation.status, error: operation.error };
    projected.set(operation.rowKey, rowOperation);
  }
  return projected;
}
