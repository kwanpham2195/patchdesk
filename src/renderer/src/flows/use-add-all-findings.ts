import { useCallback, useEffect, useRef, useState } from "react";

import { contextualMessage } from "../api-client";
import { useLatestCommitted } from "../hooks/use-latest-committed";
import { FINDING_ACTION_MESSAGES } from "../review-copy";
import type { AnalysisFinding } from "./use-analysis-review-actions";

export type AddAllFindingsProgress = {
  /** Findings whose write has settled in this batch. */
  readonly done: number;
  readonly total: number;
  readonly currentFindingId: string;
  /** Stop was asked for; the batch ends once the in-flight write settles. */
  readonly stopping: boolean;
};

export type AddAllFindingsOutcome =
  | { readonly _tag: "completed" }
  | { readonly _tag: "stopped"; readonly added: number }
  | {
      readonly _tag: "failed";
      readonly findingId: string;
      readonly message: string;
    };

export type AddAllFindingsControls = {
  readonly progress: AddAllFindingsProgress | undefined;
  readonly addAll: (
    findings: ReadonlyArray<AnalysisFinding>,
  ) => Promise<AddAllFindingsOutcome>;
  readonly stop: () => void;
};

export type AddAllFindingsInput = {
  /** The single-Finding Add path; each call records its own intent before its write. */
  readonly addFinding: (finding: AnalysisFinding) => Promise<void>;
  readonly analysisRunId: string | undefined;
};

/**
 * Adds Findings one at a time through the single-Finding path and stops at the
 * first failure, on Stop, or when the Analysis run changes; nothing is rolled back.
 */
export function useAddAllFindings({
  addFinding,
  analysisRunId,
}: AddAllFindingsInput): AddAllFindingsControls {
  const [progress, setProgress] = useState<AddAllFindingsProgress | undefined>(
    undefined,
  );
  const runningRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const mountedRef = useRef(true);
  const runIdRef = useLatestCommitted(analysisRunId);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const addAll = useCallback(
    async (
      findings: ReadonlyArray<AnalysisFinding>,
    ): Promise<AddAllFindingsOutcome> => {
      if (runningRef.current) return { _tag: "stopped", added: 0 };
      runningRef.current = true;
      stopRequestedRef.current = false;
      const startRunId = runIdRef.current;
      let added = 0;
      try {
        for (const finding of findings) {
          if (
            stopRequestedRef.current ||
            !mountedRef.current ||
            runIdRef.current !== startRunId
          )
            return { _tag: "stopped", added };
          setProgress({
            done: added,
            total: findings.length,
            currentFindingId: finding.id,
            stopping: false,
          });
          try {
            // oxlint-disable-next-line react-doctor/async-await-in-loop -- the batch is sequential by contract: each write must settle before the next starts.
            await addFinding(finding);
          } catch (cause) {
            return {
              _tag: "failed",
              findingId: finding.id,
              message: contextualMessage(cause, FINDING_ACTION_MESSAGES),
            };
          }
          added += 1;
        }
        return { _tag: "completed" };
      } finally {
        runningRef.current = false;
        if (mountedRef.current) setProgress(undefined);
      }
    },
    [addFinding, runIdRef],
  );

  const stop = useCallback((): void => {
    if (!runningRef.current) return;
    stopRequestedRef.current = true;
    setProgress((current) =>
      current === undefined ? current : { ...current, stopping: true },
    );
  }, []);

  return { progress, addAll, stop };
}
