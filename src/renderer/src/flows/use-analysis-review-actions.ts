import { useCallback, useEffect, useRef } from "react";
import * as v from "valibot";

import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import { parseRepoRelativePath } from "../../../domain/ids";
import { isOutcomeUnknownRetry, requestJson } from "../api-client";
import {
  parsePendingReviewProjection,
  type PendingReviewProjection,
  type WorkbenchResponse,
} from "../renderer-contracts";
import type { RunDirectCommand } from "./use-review-observation";

export type AnalysisFinding = NonNullable<
  WorkbenchResponse["insights"]["analysis"]["retained"]
>["value"]["findings"][number];

export type AnalysisReviewActionsInput = {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly runDirectCommand: RunDirectCommand;
};

export type AnalysisReviewActionsResult = {
  readonly addFindingToPendingReview: (
    finding: AnalysisFinding,
  ) => Promise<void>;
};

const pendingReviewCommandResponseSchema = v.strictObject({
  pendingReview: v.unknown(),
});

type FindingReviewCommand = {
  readonly _tag: "Start" | "AddThread";
  readonly pendingReviewNodeId?: string;
  readonly expected: { readonly headSha: string };
  readonly anchor: {
    readonly path: string;
    readonly startLine: number;
    readonly line: number;
    readonly side: "new" | "old";
  };
  readonly body: string;
};

type FindingLocation = {
  file: string;
  lineStart: number;
  lineEnd?: number;
  diffSide?: "new" | "old";
};

type PendingProjection = Extract<
  PendingReviewProjection,
  { readonly state: "pending" }
>;

function hasTargetComment(
  projection: PendingProjection,
  command: FindingReviewCommand,
): boolean {
  return projection.review.comments.some(
    (comment) =>
      comment.body === command.body &&
      comment.path === command.anchor.path &&
      comment.startLine === command.anchor.startLine &&
      comment.line === command.anchor.line &&
      comment.side === command.anchor.side,
  );
}

function parseConfirmedFindingProjection(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the command response's JSON boundary parser; there is no earlier boundary to run it at.
  value: unknown,
  command: FindingReviewCommand,
  allowFailureEnvelope = false,
): PendingProjection | undefined {
  const envelope = v.safeParse(
    allowFailureEnvelope
      ? v.looseObject({ pendingReview: v.unknown() })
      : pendingReviewCommandResponseSchema,
    value,
  );
  if (!envelope.success) return undefined;
  const projection = parsePendingReviewProjection(
    envelope.output.pendingReview,
  );
  if (
    projection?.state !== "pending" ||
    projection.count !== projection.review.comments.length ||
    projection.review.headSha !== command.expected.headSha ||
    (command._tag === "AddThread" &&
      projection.review.nodeId !== command.pendingReviewNodeId) ||
    !hasTargetComment(projection, command)
  )
    return undefined;
  return projection;
}

function isStalePendingResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this helper immediately parses the command response through its owned strict envelope.
  value: unknown,
  current: WorkbenchResponse["pendingReview"],
): boolean {
  const envelope = v.safeParse(pendingReviewCommandResponseSchema, value);
  if (!envelope.success || current?.state !== "pending") return false;
  const candidate = parsePendingReviewProjection(envelope.output.pendingReview);
  return (
    candidate?.state === "pending" &&
    candidate.review.nodeId === current.review.nodeId &&
    candidate.count === candidate.review.comments.length &&
    candidate.count <= current.count
  );
}

function containsAllComments(
  candidate: PendingProjection,
  current: PendingProjection,
): boolean {
  const ids = new Set(
    candidate.review.comments.map((comment) => comment.threadId),
  );
  return current.review.comments.every((comment) => ids.has(comment.threadId));
}

function sameWorkbenchScope(
  left: WorkbenchResponse,
  right: WorkbenchResponse,
): boolean {
  return (
    left.review.id === right.review.id &&
    left.session.id === right.session.id &&
    left.revision.reviewedHeadSha === right.revision.reviewedHeadSha &&
    left.revision.patchHash === right.revision.patchHash
  );
}

/** Owns Finding anchor validation and the protected Add-to-review command. */
export function useAnalysisReviewActions({
  workbench,
  onWorkbenchReplace,
  runDirectCommand,
}: AnalysisReviewActionsInput): AnalysisReviewActionsResult {
  const latestWorkbenchRef = useRef(workbench);
  useEffect(() => {
    if (!sameWorkbenchScope(latestWorkbenchRef.current, workbench))
      latestWorkbenchRef.current = workbench;
    else if (
      workbench.pendingReview?.state === "pending" &&
      (latestWorkbenchRef.current.pendingReview?.state !== "pending" ||
        workbench.pendingReview.count >=
          latestWorkbenchRef.current.pendingReview.count)
    )
      latestWorkbenchRef.current = {
        ...workbench,
        analysisReviewActions:
          latestWorkbenchRef.current.analysisReviewActions ??
          workbench.analysisReviewActions,
      };
  }, [workbench]);

  const addFindingToPendingReview = useCallback(
    async (finding: AnalysisFinding): Promise<void> => {
      const currentWorkbench = latestWorkbenchRef.current;
      const runId = currentWorkbench.insights.analysis.retained?.runId;
      const patchHash = currentWorkbench.revision.patchHash;
      const status =
        currentWorkbench.analysisReviewActions?.findings[finding.id]?.state;
      if (
        runId === undefined ||
        patchHash === undefined ||
        status !== "actionable" ||
        finding.mappingStatus !== "mapped" ||
        finding.file === undefined ||
        finding.lineStart === undefined ||
        currentWorkbench.fullPatch === undefined
      )
        throw new Error(
          "This Finding is not actionable on the current Review.",
        );
      const findingLocation: FindingLocation = {
        file: finding.file,
        lineStart: finding.lineStart,
      };
      if (finding.lineEnd !== undefined)
        findingLocation.lineEnd = finding.lineEnd;
      if (finding.diffSide !== undefined)
        findingLocation.diffSide = finding.diffSide;
      const mapped = mapFindingLocation(
        parseUnifiedPatch(currentWorkbench.fullPatch),
        findingLocation,
      );
      const path =
        mapped.path === undefined
          ? undefined
          : parseRepoRelativePath(mapped.path);
      if (
        path?._tag !== "ok" ||
        mapped.line === undefined ||
        mapped.side === undefined
      )
        throw new Error(
          "Patchdesk could not verify this Finding's diff anchor.",
        );
      const expected = {
        sessionId: currentWorkbench.session.id,
        headSha: currentWorkbench.revision.reviewedHeadSha,
        patchHash,
      };
      const anchor = {
        path: path.value,
        startLine: mapped.startLine ?? mapped.line,
        line: mapped.line,
        side: mapped.side,
      };
      const pending = currentWorkbench.pendingReview;
      const command =
        pending?.state === "none"
          ? {
              _tag: "Start" as const,
              expected,
              anchor,
              body: finding.suggestedComment ?? finding.explanation,
              finding: {
                analysisRunId: runId,
                findingId: finding.id,
                ...expected,
              },
            }
          : pending?.state === "pending"
            ? {
                _tag: "AddThread" as const,
                expected,
                pendingReviewNodeId: pending.review.nodeId,
                anchor,
                body: finding.suggestedComment ?? finding.explanation,
                finding: {
                  analysisRunId: runId,
                  findingId: finding.id,
                  ...expected,
                },
              }
            : undefined;
      if (command === undefined)
        throw new Error("Check GitHub again before changing this Finding.");

      const retainUnconfirmedFinding = (): void => {
        const latest = latestWorkbenchRef.current;
        const next: WorkbenchResponse = {
          ...latest,
          analysisReviewActions: {
            findings: {
              ...(latest.analysisReviewActions?.findings ?? {}),
              [finding.id]: { state: "locked" },
            },
            canFinishWithAnalysisSummary:
              latest.analysisReviewActions?.canFinishWithAnalysisSummary ??
              false,
          },
        };
        latestWorkbenchRef.current = next;
        onWorkbenchReplace(next);
      };
      const requirePendingReviewRecovery = (): void => {
        const latest = latestWorkbenchRef.current;
        const recovery: WorkbenchResponse = {
          ...latest,
          pendingReview: {
            state: "recovery_required",
            action: command._tag === "Start" ? "start" : "add_thread",
          },
        };
        latestWorkbenchRef.current = recovery;
        onWorkbenchReplace(recovery);
      };

      let retainedNewerProjection = false;
      const applyConfirmedProjection = (
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this helper immediately parses the command response through its owned strict envelope.
        value: unknown,
        allowFailureEnvelope = false,
      ): boolean => {
        const projection = parseConfirmedFindingProjection(
          value,
          command,
          allowFailureEnvelope,
        );
        if (projection === undefined) return false;
        const latest = latestWorkbenchRef.current;
        if (!sameWorkbenchScope(latest, currentWorkbench)) return false;
        const latestPending = latest.pendingReview;
        const selected =
          latestPending?.state !== "pending"
            ? projection
            : hasTargetComment(latestPending, command)
              ? latestPending
              : projection.review.nodeId !== latestPending.review.nodeId ||
                  projection.count < latestPending.count ||
                  !containsAllComments(projection, latestPending)
                ? undefined
                : projection;
        if (selected === undefined) {
          retainedNewerProjection = true;
          return false;
        }
        const next: WorkbenchResponse = {
          ...latest,
          pendingReview: selected,
          analysisReviewActions: {
            findings: {
              ...(latest.analysisReviewActions?.findings ?? {}),
              [finding.id]: { state: "pending_review" },
            },
            canFinishWithAnalysisSummary: true,
          },
        };
        latestWorkbenchRef.current = next;
        onWorkbenchReplace(next);
        return true;
      };

      try {
        const value = await runDirectCommand(() =>
          requestJson("/v1/reviews/pending-review/command", {
            method: "POST",
            body: {
              profileId: currentWorkbench.session.key.profileId,
              reviewId: currentWorkbench.review.id,
              command,
            },
          }),
        );
        if (!sameWorkbenchScope(latestWorkbenchRef.current, currentWorkbench))
          return;
        if (applyConfirmedProjection(value)) return;
        if (
          isStalePendingResponse(
            value,
            latestWorkbenchRef.current.pendingReview,
          )
        )
          retainedNewerProjection = true;
      } catch (cause) {
        if (!sameWorkbenchScope(latestWorkbenchRef.current, currentWorkbench))
          return;
        if (!isOutcomeUnknownRetry(cause)) throw cause;
        const projection = parseConfirmedFindingProjection(
          cause.responseBody,
          command,
          true,
        );
        if (
          projection !== undefined &&
          applyConfirmedProjection(cause.responseBody, true)
        )
          return;
        if (
          isStalePendingResponse(
            cause.responseBody,
            latestWorkbenchRef.current.pendingReview,
          )
        )
          retainUnconfirmedFinding();
        else requirePendingReviewRecovery();
        throw cause;
      }
      if (retainedNewerProjection) {
        retainUnconfirmedFinding();
        throw new Error(
          "Patchdesk received stale Finding evidence. Check GitHub again before trying again.",
        );
      }
      requirePendingReviewRecovery();
      throw new Error(
        "Patchdesk could not confirm this Finding write. Check GitHub again before trying again.",
      );
    },
    [onWorkbenchReplace, runDirectCommand],
  );

  return { addFindingToPendingReview };
}
