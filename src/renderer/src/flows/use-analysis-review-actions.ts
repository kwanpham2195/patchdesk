import { useCallback } from "react";

import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import { parseRepoRelativePath } from "../../../domain/ids";
import { requestJson } from "../api-client";
import {
  parseWorkbenchResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";

type RunDirectCommand = <T>(operation: () => Promise<T>) => Promise<T>;

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

/** Owns Finding anchor validation and the protected Add-to-review command. */
export function useAnalysisReviewActions({
  workbench,
  onWorkbenchReplace,
  runDirectCommand,
}: AnalysisReviewActionsInput): AnalysisReviewActionsResult {
  const addFindingToPendingReview = useCallback(
    async (finding: AnalysisFinding): Promise<void> => {
      const runId = workbench.insights.analysis.retained?.runId;
      const patchHash = workbench.revision.patchHash;
      const status =
        workbench.analysisReviewActions?.findings[finding.id]?.state;
      if (
        runId === undefined ||
        patchHash === undefined ||
        status !== "actionable" ||
        finding.mappingStatus !== "mapped" ||
        finding.file === undefined ||
        finding.lineStart === undefined ||
        workbench.fullPatch === undefined
      )
        throw new Error(
          "This Finding is not actionable on the current Review.",
        );
      const findingLocationBase = {
        file: finding.file,
        lineStart: finding.lineStart,
      };
      const findingLocationWithEnd =
        finding.lineEnd === undefined
          ? findingLocationBase
          : { ...findingLocationBase, lineEnd: finding.lineEnd };
      const findingLocation =
        finding.diffSide === undefined
          ? findingLocationWithEnd
          : { ...findingLocationWithEnd, diffSide: finding.diffSide };
      const mapped = mapFindingLocation(
        parseUnifiedPatch(workbench.fullPatch),
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
      const anchor = {
        path: path.value,
        startLine: mapped.startLine ?? mapped.line,
        line: mapped.line,
        side: mapped.side,
      };
      const expected = {
        sessionId: workbench.session.id,
        headSha: workbench.revision.reviewedHeadSha,
        patchHash,
      };
      const pending = workbench.pendingReview;
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
      await runDirectCommand(() =>
        requestJson("/v1/reviews/pending-review/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command,
          },
        }),
      );
      const value = await requestJson("/v1/reviews/load", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          reviewId: workbench.review.id,
        },
      });
      const next = parseWorkbenchResponse(value);
      if (next === undefined)
        throw new Error("Invalid Review projection response");
      onWorkbenchReplace(next);
    },
    [onWorkbenchReplace, runDirectCommand, workbench],
  );

  return { addFindingToPendingReview };
}
