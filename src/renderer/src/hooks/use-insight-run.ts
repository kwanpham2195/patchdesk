import { useCallback, useEffect, useRef, useState } from "react";

import { requestJson } from "../api-client";
import { useLatestCommitted } from "./use-latest-committed";
import { definedProps } from "../../../domain/defined-props";
import type {
  InsightProvider,
  InsightReasoning,
} from "../../../domain/insight-provider";
import {
  parseInsightRunResponse,
  parseWorkbenchResponse,
  type InsightRunResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";

export type InsightRunType = "analysis" | "walkthrough";
type InsightRunState = InsightRunResponse["status"] | "idle" | "error";

export type InsightRunController = {
  readonly status: InsightRunState;
  readonly runId?: string;
  readonly error: boolean;
  readonly failureReason?: InsightRunResponse["failureReason"];
  readonly busy: boolean;
  readonly run: (
    provider: InsightProvider,
    model: string,
    reasoning: InsightReasoning,
    onAccepted?: () => void,
  ) => void;
  readonly cancel: () => void;
};

export function useInsightRun(input: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly type: InsightRunType;
  readonly activeRun?: WorkbenchResponse["insights"][InsightRunType]["activeRun"];
  readonly onWorkbenchReplace?: (workbench: WorkbenchResponse) => void;
  readonly onInsightPatch?: (
    type: InsightRunType,
    projection: WorkbenchResponse["insights"][InsightRunType],
  ) => void;
  readonly onCompleted?: () => void;
}): InsightRunController {
  const {
    profileId,
    reviewId,
    type,
    activeRun,
    onWorkbenchReplace,
    onInsightPatch,
    onCompleted,
  } = input;
  const persistedRunId = activeRun?.runId;
  const [status, setStatus] = useState<InsightRunState>(() =>
    persistedRunId === undefined ? "idle" : "running",
  );
  const [runId, setRunId] = useState<string | undefined>(persistedRunId);
  const [error, setError] = useState(false);
  const [failureReason, setFailureReason] =
    useState<InsightRunResponse["failureReason"]>();
  const [starting, setStarting] = useState(false);
  const activeRunRef = useRef<string | undefined>(persistedRunId);
  const startingRef = useRef(false);
  const onWorkbenchReplaceRef = useLatestCommitted(onWorkbenchReplace);
  const onInsightPatchRef = useLatestCommitted(onInsightPatch);
  const onCompletedRef = useLatestCommitted(onCompleted);

  const [previousPersistedRunId, setPreviousPersistedRunId] =
    useState(persistedRunId);
  if (
    persistedRunId !== previousPersistedRunId &&
    !startingRef.current &&
    activeRunRef.current === undefined
  ) {
    setPreviousPersistedRunId(persistedRunId);
    if (persistedRunId !== undefined) {
      setRunId(persistedRunId);
      setStatus("running");
      setError(false);
      setFailureReason(undefined);
    }
  }

  const run = useCallback(
    (
      provider: InsightProvider,
      model: string,
      reasoning: InsightReasoning,
      onAccepted?: () => void,
    ): void => {
      if (
        startingRef.current ||
        activeRunRef.current !== undefined ||
        runId !== undefined
      )
        return;
      startingRef.current = true;
      setStarting(true);
      setError(false);
      setFailureReason(undefined);
      void requestJson(`/v1/reviews/insights/${type}/run`, {
        method: "POST",
        body: { profileId, reviewId, type, provider, model, reasoning },
      })
        .then((value) => {
          const parsed = parseInsightRunResponse(value);
          if (parsed === undefined || parsed.type !== type)
            throw new Error("Invalid Insight run response");
          activeRunRef.current = parsed.runId;
          startingRef.current = false;
          setStarting(false);
          setRunId(parsed.runId);
          setStatus(parsed.status);
          onAccepted?.();
        })
        .catch(() => {
          startingRef.current = false;
          setStarting(false);
          setError(true);
          setStatus("error");
        });
    },
    [profileId, reviewId, runId, type],
  );

  const cancel = useCallback((): void => {
    const activeRunId = activeRunRef.current ?? runId;
    if (activeRunId === undefined) return;
    void requestJson(`/v1/reviews/insights/${type}/cancel`, {
      method: "POST",
      body: { profileId, reviewId, type, runId: activeRunId },
    })
      .then((value) => {
        const parsed = parseInsightRunResponse(value);
        if (parsed === undefined)
          throw new Error("Invalid Insight cancellation response");
        setStatus(parsed.status);
      })
      .catch(() => setError(true));
  }, [profileId, reviewId, runId, type]);

  useEffect(() => {
    if (runId === undefined) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const poll = (): void => {
      void requestJson(
        `/v1/reviews/insights/runs/${encodeURIComponent(runId)}?profileId=${encodeURIComponent(profileId)}&reviewId=${encodeURIComponent(reviewId)}&type=${type}`,
      )
        .then((value) => {
          if (
            cancelled ||
            (activeRunRef.current !== undefined &&
              activeRunRef.current !== runId)
          )
            return undefined;
          const parsed = parseInsightRunResponse(value);
          if (parsed === undefined || parsed.type !== type)
            throw new Error("Invalid Insight status response");
          setStatus(parsed.status);
          setFailureReason(parsed.failureReason);
          if (
            parsed.status !== "completed" &&
            parsed.status !== "failed" &&
            parsed.status !== "cancelled"
          )
            return undefined;
          return requestJson("/v1/reviews/load", {
            method: "POST",
            body: { profileId, reviewId },
          }).then((workbenchValue) => ({ parsed, workbenchValue }));
        })
        .then((terminal) => {
          if (terminal === undefined) return;
          const workbench = parseWorkbenchResponse(terminal.workbenchValue);
          if (workbench === undefined)
            throw new Error("Invalid Review projection response");
          if (!cancelled && activeRunRef.current === runId) {
            if (onInsightPatchRef.current !== undefined)
              onInsightPatchRef.current(type, workbench.insights[type]);
            else onWorkbenchReplaceRef.current?.(workbench);
          }
          if (terminal.parsed.status === "completed")
            onCompletedRef.current?.();
          activeRunRef.current = undefined;
          setRunId(undefined);
        })
        .catch(() => {
          if (!cancelled) {
            setError(true);
            setStatus("error");
            activeRunRef.current = undefined;
            setRunId(undefined);
          }
        })
        .finally(() => {
          if (!cancelled && activeRunRef.current === runId)
            timer = window.setTimeout(poll, 500);
        });
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    onCompletedRef,
    onInsightPatchRef,
    onWorkbenchReplaceRef,
    profileId,
    reviewId,
    runId,
    type,
  ]);

  return {
    status,
    ...definedProps({ runId }),
    error,
    ...definedProps({ failureReason }),
    busy: starting || runId !== undefined || activeRun !== undefined,
    run,
    cancel,
  };
}
