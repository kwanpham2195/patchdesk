import { useCallback, useState } from "react";
import * as v from "valibot";

import { parseGitHubThreadId, type GitHubThreadId } from "../../../domain/ids";
import type { RecentReviewWrite } from "../../../domain/recent-review-write";
import { PatchdeskApiError, requestJson } from "../api-client";
import type { PendingReviewComposerActions } from "../components/review-diff-view";
import {
  parsePendingReviewProjection,
  parseWorkbenchResponse,
  type PendingReviewProjection,
  type WorkbenchResponse,
} from "../renderer-contracts";
import type { ReviewWorkbenchPatch } from "./use-review-observation";

const pendingReviewEnvelopeSchema = v.looseObject({
  pendingReview: v.optional(v.unknown()),
});

type AppendRecentWrites = (
  entries: RecentReviewWrite | ReadonlyArray<RecentReviewWrite>,
) => void;

type PendingReviewCommand =
  | {
      readonly _tag: "Start" | "AddThread";
      readonly pendingReviewNodeId?: string;
      readonly anchor: {
        readonly path: string;
        readonly startLine: number;
        readonly line: number;
        readonly side: "new" | "old";
      };
      readonly body: string;
    }
  | {
      readonly _tag: "Submit";
      readonly event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
      readonly summaryBody: string;
    }
  | {
      readonly _tag: "Discard";
      readonly confirmation: true;
    };

export type PendingReviewPanel = {
  readonly projection: WorkbenchResponse["pendingReview"];
  readonly busy: boolean;
  readonly finishDialogOpen: boolean;
  readonly finishDialogInitialSummary?: string;
  readonly onOpenFinishDialog: () => void;
  readonly onCloseFinishDialog: () => void;
  readonly onSubmit: (
    event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
    summaryBody: string,
  ) => Promise<void>;
  readonly onDiscard: () => Promise<void>;
  readonly onCheckGitHubAgain: () => Promise<void>;
  readonly finishDialogError?: string;
  readonly recoveryError?: string;
};

export type PendingReviewActionsInput = {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
  readonly appendRecentWrites: AppendRecentWrites;
};

export type PendingReviewActionsResult = {
  readonly pendingReviewComposer: PendingReviewComposerActions | undefined;
  readonly pendingReview: PendingReviewPanel | undefined;
  readonly openFinishDialogWithSummary: (summary: string) => void;
};

function boundedPendingReviewError(cause: unknown): string {
  if (cause instanceof PatchdeskApiError) {
    if (
      cause.kind === "outcome_unknown" ||
      cause.kind === "ambiguous_write" ||
      cause.kind === "timeout"
    )
      return "GitHub could not confirm the submission. Check GitHub again before trying again.";
    if (cause.kind === "pending_review")
      return "A pending review already exists. Refresh, then finish or discard that review before submitting a summary.";
    if (cause.kind === "stale_head")
      return "The pull request changed. Refresh, then finish the review.";
    if (cause.kind === "rejected" || cause.kind === "github_rejected")
      return "GitHub rejected the submission.";
    if (
      cause.kind === "no_pending_review" ||
      cause.kind === "pending_review_locked"
    )
      return "The pending review changed. Check GitHub again or refresh.";
    if (cause.kind === "forbidden")
      return "GitHub blocked this submission: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.";
  }
  return "Patchdesk could not finish this review. Check GitHub again or refresh.";
}

function boundedPendingReviewRecoveryError(cause: unknown): string {
  if (cause instanceof PatchdeskApiError) {
    if (cause.kind === "review_write_in_progress") {
      return "Another Review operation is still finishing. Check GitHub again in a moment.";
    }
    if (
      cause.kind === "timeout" ||
      cause.kind === "unavailable" ||
      cause.kind === "outcome_unknown"
    ) {
      return "Patchdesk could not check GitHub right now. Try again.";
    }
  }
  return "Patchdesk could not reconcile this pending review. Try again or refresh.";
}

function threadIdsOf(
  projection: PendingReviewProjection | undefined,
): ReadonlyArray<GitHubThreadId> {
  if (projection === undefined || projection.state !== "pending") return [];
  return projection.review.comments.flatMap((comment) => {
    const parsed = parseGitHubThreadId(comment.threadId);
    return parsed._tag === "ok" ? [parsed.value] : [];
  });
}

/** Owns pending-review commands, recovery, dialog state, and thread journaling. */
export function usePendingReviewActions({
  workbench,
  onWorkbenchReplace,
  onWorkbenchPatch,
  appendRecentWrites,
}: PendingReviewActionsInput): PendingReviewActionsResult {
  const [pendingReviewBusy, setPendingReviewBusy] = useState(false);
  const [finishDialogOpen, setFinishDialogOpen] = useState(false);
  const [finishDialogInitialSummary, setFinishDialogInitialSummary] = useState<
    string | undefined
  >(undefined);
  const [finishDialogError, setFinishDialogError] = useState<
    string | undefined
  >(undefined);

  const applyPendingReviewProjection = useCallback(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this callback is itself the JSON I/O boundary parser shared by every command response that may carry a pending-review projection; there is no earlier boundary to run it at.
    (value: unknown): PendingReviewProjection | undefined => {
      const envelope = v.safeParse(pendingReviewEnvelopeSchema, value);
      const projection = parsePendingReviewProjection(
        envelope.success ? envelope.output.pendingReview : undefined,
      );
      if (projection !== undefined)
        onWorkbenchPatch({ pendingReview: projection });
      return projection;
    },
    [onWorkbenchPatch],
  );

  const runPendingReviewCommand = useCallback(
    async (command: PendingReviewCommand): Promise<void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot accept review comments.");
      const priorThreadIds =
        command._tag === "Start" ||
        command._tag === "AddThread" ||
        command._tag === "Discard"
          ? threadIdsOf(workbench.pendingReview)
          : [];
      setPendingReviewBusy(true);
      try {
        const expected = {
          sessionId: workbench.session.id,
          headSha: workbench.revision.reviewedHeadSha,
          patchHash,
        };
        const requestCommand =
          command._tag === "Discard"
            ? {
                _tag: "Discard" as const,
                expected,
                confirmation: command.confirmation,
              }
            : command._tag === "Submit"
              ? {
                  _tag: "Submit" as const,
                  expected,
                  event: command.event,
                  summaryBody: command.summaryBody,
                }
              : command._tag === "AddThread"
                ? {
                    _tag: "AddThread" as const,
                    expected,
                    anchor: command.anchor,
                    body: command.body,
                    pendingReviewNodeId: command.pendingReviewNodeId,
                  }
                : {
                    _tag: "Start" as const,
                    expected,
                    anchor: command.anchor,
                    body: command.body,
                  };
        const value = await requestJson("/v1/reviews/pending-review/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: requestCommand,
          },
        });
        const projection = applyPendingReviewProjection(value);
        setFinishDialogError(undefined);
        if (command._tag === "Start" || command._tag === "AddThread") {
          const priorThreadIdSet = new Set(priorThreadIds);
          const added = threadIdsOf(projection).filter(
            (id) => !priorThreadIdSet.has(id),
          );
          if (added.length > 0) {
            appendRecentWrites(
              added.map((threadId) => ({
                _tag: "PendingThread" as const,
                threadId,
              })),
            );
          }
        } else if (command._tag === "Discard" && projection?.state === "none") {
          if (priorThreadIds.length > 0) {
            appendRecentWrites(
              priorThreadIds.map((threadId) => ({
                _tag: "PendingThread" as const,
                threadId,
              })),
            );
          }
        }
      } catch (cause) {
        if (
          cause instanceof PatchdeskApiError &&
          (cause.kind === "outcome_unknown" ||
            cause.kind === "ambiguous_write" ||
            cause.kind === "timeout")
        ) {
          const projected = applyPendingReviewProjection(cause.responseBody);
          if (projected === undefined) {
            const action =
              command._tag === "Start"
                ? "start"
                : command._tag === "AddThread"
                  ? "add_thread"
                  : command._tag === "Submit"
                    ? "submit"
                    : "discard";
            onWorkbenchPatch({
              pendingReview: { state: "recovery_required", action },
            });
          }
        }
        throw cause;
      } finally {
        setPendingReviewBusy(false);
      }
    },
    [
      appendRecentWrites,
      applyPendingReviewProjection,
      onWorkbenchPatch,
      workbench,
    ],
  );

  const checkGitHubAgain = useCallback(async (): Promise<void> => {
    setPendingReviewBusy(true);
    setFinishDialogError(undefined);
    try {
      const value = await requestJson("/v1/reviews/pending-review/recover", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          reviewId: workbench.review.id,
        },
      });
      const projection = applyPendingReviewProjection(value);
      if (projection?.state === "recovery_required") {
        setFinishDialogError(
          "Patchdesk found the pending review, but it cannot identify the exact Finding comment. Inspect or discard the pending review on GitHub, then check again.",
        );
      } else {
        const loaded = await requestJson("/v1/reviews/load", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
          },
        });
        const next = parseWorkbenchResponse(loaded);
        if (next === undefined)
          throw new Error("Invalid Review projection response");
        onWorkbenchReplace(next);
        setFinishDialogError(undefined);
      }
    } catch (cause) {
      setFinishDialogError(boundedPendingReviewRecoveryError(cause));
    } finally {
      setPendingReviewBusy(false);
    }
  }, [applyPendingReviewProjection, onWorkbenchReplace, workbench]);

  const onOpenFinishDialog = useCallback((): void => {
    setFinishDialogInitialSummary(undefined);
    setFinishDialogOpen(true);
  }, []);
  const onCloseFinishDialog = useCallback((): void => {
    setFinishDialogOpen(false);
    setFinishDialogInitialSummary(undefined);
  }, []);
  const openFinishDialogWithSummary = useCallback((summary: string): void => {
    setFinishDialogInitialSummary(summary);
    setFinishDialogOpen(true);
  }, []);

  const pendingReviewComposer: PendingReviewComposerActions | undefined =
    workbench.pendingReview === undefined
      ? undefined
      : {
          state:
            workbench.pendingReview.state === "pending"
              ? {
                  state: "pending" as const,
                  nodeId: workbench.pendingReview.review.nodeId,
                }
              : { state: workbench.pendingReview.state },
          busy: pendingReviewBusy,
          onStartReview: async (anchor, body) => {
            await runPendingReviewCommand({ _tag: "Start", anchor, body });
          },
          onAddReviewComment: async (nodeId, anchor, body) => {
            await runPendingReviewCommand({
              _tag: "AddThread",
              pendingReviewNodeId: nodeId,
              anchor,
              body,
            });
          },
        };

  const pendingReviewPanelBase: PendingReviewPanel = {
    projection: workbench.pendingReview,
    busy: pendingReviewBusy,
    finishDialogOpen,
    onOpenFinishDialog,
    onCloseFinishDialog,
    onSubmit: async (
      event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
      summaryBody: string,
    ): Promise<void> => {
      try {
        await runPendingReviewCommand({ _tag: "Submit", event, summaryBody });
        setFinishDialogOpen(false);
      } catch (cause) {
        setFinishDialogError(boundedPendingReviewError(cause));
      }
    },
    onDiscard: async (): Promise<void> => {
      try {
        await runPendingReviewCommand({ _tag: "Discard", confirmation: true });
        setFinishDialogOpen(false);
      } catch (cause) {
        setFinishDialogError(boundedPendingReviewError(cause));
      }
    },
    onCheckGitHubAgain: checkGitHubAgain,
  };
  const pendingReviewPanelWithSummary =
    finishDialogInitialSummary === undefined
      ? pendingReviewPanelBase
      : { ...pendingReviewPanelBase, finishDialogInitialSummary };
  const pendingReviewPanelWithRecoveryError =
    finishDialogError === undefined
      ? pendingReviewPanelWithSummary
      : {
          ...pendingReviewPanelWithSummary,
          recoveryError: finishDialogError,
          finishDialogError,
        };
  const pendingReview =
    pendingReviewComposer === undefined
      ? undefined
      : pendingReviewPanelWithRecoveryError;

  return {
    pendingReviewComposer,
    pendingReview,
    openFinishDialogWithSummary,
  };
}
