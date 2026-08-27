import { useCallback, useState } from "react";
import * as v from "valibot";

import { parseGitHubThreadId, type GitHubThreadId } from "../../../domain/ids";
import {
  PatchdeskApiError,
  contextualMessage,
  isOutcomeUnknownRetry,
  requestJson,
} from "../api-client";
import {
  FINISH_REVIEW_MESSAGES,
  PENDING_REVIEW_RECOVERY_MESSAGES,
} from "../review-copy";
import type { PendingReviewComposerActions } from "../components/review-diff-view";
import {
  parsePendingReviewProjection,
  parseWorkbenchResponse,
  type PendingReviewProjection,
  type WorkbenchResponse,
} from "../renderer-contracts";
import type { ReviewWorkbenchPatch } from "./use-review-observation";
import type { GitHubReviewEvent } from "../../../domain/pending-review";
import type {
  RunDirectCommand,
  AppendRecentWrites,
} from "./use-review-observation";

const pendingReviewEnvelopeSchema = v.looseObject({
  pendingReview: v.optional(v.unknown()),
});

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
      readonly event: GitHubReviewEvent;
      readonly summaryBody: string;
    }
  | {
      readonly _tag: "Discard";
      readonly confirmation: true;
    };

type PendingReviewPanel = {
  readonly projection: WorkbenchResponse["pendingReview"];
  readonly busy: boolean;
  readonly finishDialogOpen: boolean;
  readonly finishDialogInitialSummary?: string;
  readonly onOpenFinishDialog: () => void;
  readonly onCloseFinishDialog: () => void;
  readonly onSubmit: (
    event: GitHubReviewEvent,
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
  readonly runDirectCommand: RunDirectCommand;
  readonly appendRecentWrites: AppendRecentWrites;
  readonly observeConfirmedReviewWrite: () => Promise<void>;
};

export type PendingReviewActionsResult = {
  readonly pendingReviewComposer: PendingReviewComposerActions | undefined;
  readonly pendingReview: PendingReviewPanel | undefined;
  readonly openFinishDialogWithSummary: (summary: string) => void;
};

function threadIdsOf(
  projection: PendingReviewProjection | undefined,
): ReadonlyArray<GitHubThreadId> {
  if (projection === undefined || projection.state !== "pending") return [];
  return projection.review.comments.flatMap((comment) => {
    const parsed = parseGitHubThreadId(comment.threadId);
    return parsed._tag === "ok" ? [parsed.value] : [];
  });
}

function recoveryActionOf(
  command: PendingReviewCommand,
): "start" | "add_thread" | "submit" | "discard" {
  if (command._tag === "Start") return "start";
  if (command._tag === "AddThread") return "add_thread";
  if (command._tag === "Submit") return "submit";
  return "discard";
}

/** Owns pending-review commands, recovery, dialog state, and thread journaling. */
export function usePendingReviewActions({
  workbench,
  onWorkbenchReplace,
  onWorkbenchPatch,
  runDirectCommand,
  appendRecentWrites,
  observeConfirmedReviewWrite,
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
      const recoveryAction = recoveryActionOf(command);
      let recoveryRequired = false;
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
        const value = await runDirectCommand(() =>
          requestJson("/v1/reviews/pending-review/command", {
            method: "POST",
            body: {
              profileId: workbench.session.key.profileId,
              reviewId: workbench.review.id,
              command: requestCommand,
            },
          }),
        );
        const projection = applyPendingReviewProjection(value);
        if (projection === undefined) {
          recoveryRequired = true;
          onWorkbenchPatch({
            pendingReview: {
              state: "recovery_required",
              action: recoveryAction,
            },
          });
          throw new PatchdeskApiError(
            "outcome_unknown",
            200,
            false,
            "invalid-pending-review-projection",
            "GitHub could not confirm this write. Check GitHub again before trying again.",
          );
        }
        setFinishDialogError(undefined);
        if (command._tag === "Submit" && projection.state === "none") {
          void observeConfirmedReviewWrite().catch(() => {
            // This read-only observer never retries the confirmed GitHub write.
          });
        } else if (command._tag === "Start" || command._tag === "AddThread") {
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
        if (isOutcomeUnknownRetry(cause)) {
          const projected = applyPendingReviewProjection(cause.responseBody);
          if (projected === undefined && !recoveryRequired) {
            onWorkbenchPatch({
              pendingReview: {
                state: "recovery_required",
                action: recoveryAction,
              },
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
      observeConfirmedReviewWrite,
      runDirectCommand,
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
      setFinishDialogError(
        contextualMessage(cause, PENDING_REVIEW_RECOVERY_MESSAGES),
      );
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
      event: GitHubReviewEvent,
      summaryBody: string,
    ): Promise<void> => {
      try {
        await runPendingReviewCommand({ _tag: "Submit", event, summaryBody });
        setFinishDialogOpen(false);
      } catch (cause) {
        setFinishDialogError(contextualMessage(cause, FINISH_REVIEW_MESSAGES));
      }
    },
    onDiscard: async (): Promise<void> => {
      try {
        await runPendingReviewCommand({ _tag: "Discard", confirmation: true });
        setFinishDialogOpen(false);
      } catch (cause) {
        setFinishDialogError(contextualMessage(cause, FINISH_REVIEW_MESSAGES));
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
