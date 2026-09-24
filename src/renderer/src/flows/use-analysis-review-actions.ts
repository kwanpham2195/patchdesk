import { useCallback, useEffect, useRef } from "react";
import * as v from "valibot";

import { definedProps } from "../../../domain/defined-props";
import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import { resolveSuggestionTarget } from "../../../domain/finding-suggestion";
import { parseRepoRelativePath } from "../../../domain/ids";
import {
  ReviewPreconditionError,
  isOutcomeUnknownRetry,
  requestJson,
  untrustedWriteResponseError,
} from "../api-client";
import { appLog } from "../lib/logger";
import {
  parsePendingReviewProjection,
  type PendingReviewProjection,
  type WorkbenchResponse,
} from "../renderer-contracts";
import type { RunDirectCommand } from "./use-review-observation";

const PENDING_REVIEW_COMMAND_PATH = "/v1/reviews/pending-review/command";
const FINDING_SUGGESTION_PATH = "/v1/reviews/pending-review/finding-suggestion";

export type AnalysisFinding = NonNullable<
  WorkbenchResponse["insights"]["analysis"]["retained"]
>["value"]["findings"][number];

export type AnalysisReviewActionsInput = {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly runDirectCommand: RunDirectCommand;
};

/** `review_changed`: the session, head, patch, or Analysis run changed during the write, so the add is unconfirmed. */
export type FindingAddResult = "added" | "review_changed";

export type AnalysisReviewActionsResult = {
  readonly addFindingToPendingReview: (
    finding: AnalysisFinding,
  ) => Promise<FindingAddResult>;
};

const pendingReviewCommandResponseSchema = v.strictObject({
  pendingReview: v.unknown(),
  // Present only on the Finding-suggestion route, which names the exact
  // comment the main process composed and sent.
  composed: v.optional(v.unknown()),
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

/**
 * The exact comment the main process composed and sent for a Finding
 * suggestion. The renderer confirms this text against the returned pending
 * review rather than composing any suggestion Markdown itself (issue #316).
 */
const composedFindingSuggestionSchema = v.strictObject({
  anchor: v.strictObject({
    path: v.pipe(v.string(), v.minLength(1)),
    startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
    line: v.pipe(v.number(), v.integer(), v.minValue(1)),
    side: v.picklist(["new", "old"]),
  }),
  body: v.pipe(v.string(), v.minLength(1)),
});

function parseComposedFindingSuggestion(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the command response's JSON boundary parser; there is no earlier boundary to run it at.
  value: unknown,
): v.InferOutput<typeof composedFindingSuggestionSchema> | undefined {
  const parsed = v.safeParse(composedFindingSuggestionSchema, value);
  if (!parsed.success) return undefined;
  return parseRepoRelativePath(parsed.output.anchor.path)._tag === "ok"
    ? parsed.output
    : undefined;
}

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

/**
 * The command response's one envelope parse. An outcome-unknown failure body
 * carries the same two fields inside a larger envelope, so it is read loosely
 * rather than parsed a second time per field.
 */
type CommandEnvelope = {
  readonly pendingReview: unknown;
  readonly composed?: unknown;
};

function parseCommandEnvelope(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the command response's JSON boundary parser; there is no earlier boundary to run it at.
  value: unknown,
  allowFailureEnvelope: boolean,
): CommandEnvelope | undefined {
  const envelope = v.safeParse(
    allowFailureEnvelope
      ? v.looseObject({
          pendingReview: v.unknown(),
          composed: v.optional(v.unknown()),
        })
      : pendingReviewCommandResponseSchema,
    value,
  );
  return envelope.success ? envelope.output : undefined;
}

function confirmedFindingProjection(
  envelope: CommandEnvelope,
  command: FindingReviewCommand,
): PendingProjection | undefined {
  const projection = parsePendingReviewProjection(envelope.pendingReview);
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

// The Analysis run id is part of the scope because a new run invalidates every Finding state the ref holds.
function sameWorkbenchScope(
  left: WorkbenchResponse,
  right: WorkbenchResponse,
): boolean {
  return (
    left.review.id === right.review.id &&
    left.session.id === right.session.id &&
    left.revision.reviewedHeadSha === right.revision.reviewedHeadSha &&
    left.revision.patchHash === right.revision.patchHash &&
    left.insights.analysis.retained?.runId ===
      right.insights.analysis.retained?.runId
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
    async (finding: AnalysisFinding): Promise<FindingAddResult> => {
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
      ) {
        // The reader offers Add only for an actionable Finding, so reaching this is a defect.
        appLog.error(
          "finding-action",
          "This Finding is not actionable on the current Review.",
          {
            findingId: finding.id,
            hasRunId: runId !== undefined,
            hasPatchHash: patchHash !== undefined,
            hasFullPatch: currentWorkbench.fullPatch !== undefined,
            status: status ?? null,
            mappingStatus: finding.mappingStatus,
          },
        );
        throw new Error(
          "This Finding is not actionable on the current Review.",
        );
      }
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
      ) {
        appLog.warn("finding-action", "Finding diff anchor is unverifiable", {
          findingId: finding.id,
          mappingStatus: mapped.mappingStatus,
        });
        throw new ReviewPreconditionError("stale_finding_evidence");
      }
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
      const tag =
        pending?.state === "none"
          ? ("Start" as const)
          : pending?.state === "pending"
            ? ("AddThread" as const)
            : undefined;
      if (tag === undefined)
        throw new ReviewPreconditionError("stale_finding_evidence");
      const pendingReviewNodeId =
        pending?.state === "pending" ? pending.review.nodeId : undefined;
      // A verified replacement is published by the main process, which owns
      // the anchor and the suggestion body; this request carries identity and
      // the expected revision only (issue #316). The same resolution the
      // reader's label uses decides the route, so a replacement the
      // represented patch cannot anchor takes the ordinary comment path.
      const isSuggestion =
        finding.suggestedReplacement !== undefined &&
        resolveSuggestionTarget(currentWorkbench.fullPatch, findingLocation) !==
          undefined;
      const commentCommand: FindingReviewCommand | undefined = isSuggestion
        ? undefined
        : {
            _tag: tag,
            ...definedProps({ pendingReviewNodeId }),
            expected,
            anchor,
            body: finding.suggestedComment ?? finding.explanation,
          };
      const request =
        commentCommand === undefined
          ? {
              path: FINDING_SUGGESTION_PATH,
              body: {
                profileId: currentWorkbench.session.key.profileId,
                reviewId: currentWorkbench.review.id,
                runId,
                findingId: finding.id,
                expected,
                ...definedProps({ pendingReviewNodeId }),
              },
            }
          : {
              path: PENDING_REVIEW_COMMAND_PATH,
              body: {
                profileId: currentWorkbench.session.key.profileId,
                reviewId: currentWorkbench.review.id,
                command: {
                  ...commentCommand,
                  finding: {
                    analysisRunId: runId,
                    findingId: finding.id,
                    ...expected,
                  },
                },
              },
            };
      /**
       * The comment this write is confirmed against. An ordinary Finding knows
       * it before the request; a suggestion learns it from the response, the
       * only place the published body exists.
       */
      const confirmedCommand = (
        envelope: CommandEnvelope,
      ): FindingReviewCommand | undefined => {
        if (commentCommand !== undefined) return commentCommand;
        const composed = parseComposedFindingSuggestion(envelope.composed);
        return composed === undefined
          ? undefined
          : {
              _tag: tag,
              ...definedProps({ pendingReviewNodeId }),
              expected,
              anchor: composed.anchor,
              body: composed.body,
            };
      };

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
        const latestPending = latest.pendingReview;
        const recovery: WorkbenchResponse = {
          ...latest,
          pendingReview: {
            state: "recovery_required",
            action: tag === "Start" ? "start" : "add_thread",
            review:
              latestPending?.state === "pending" ||
              latestPending?.state === "recovery_required"
                ? latestPending.review
                : null,
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
        const envelope = parseCommandEnvelope(value, allowFailureEnvelope);
        if (envelope === undefined) return false;
        const command = confirmedCommand(envelope);
        if (command === undefined) return false;
        const projection = confirmedFindingProjection(envelope, command);
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
          requestJson(request.path, { method: "POST", body: request.body }),
        );
        if (!sameWorkbenchScope(latestWorkbenchRef.current, currentWorkbench))
          return "review_changed";
        if (applyConfirmedProjection(value)) return "added";
        if (
          isStalePendingResponse(
            value,
            latestWorkbenchRef.current.pendingReview,
          )
        )
          retainedNewerProjection = true;
      } catch (cause) {
        if (!sameWorkbenchScope(latestWorkbenchRef.current, currentWorkbench))
          return "review_changed";
        if (!isOutcomeUnknownRetry(cause)) throw cause;
        if (applyConfirmedProjection(cause.responseBody, true)) return "added";
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
        throw untrustedWriteResponseError("stale-finding-projection");
      }
      requirePendingReviewRecovery();
      throw untrustedWriteResponseError("invalid-finding-projection");
    },
    [onWorkbenchReplace, runDirectCommand],
  );

  return { addFindingToPendingReview };
}
