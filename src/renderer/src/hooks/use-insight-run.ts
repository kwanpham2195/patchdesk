import { useCallback, useEffect, useRef, useState } from "react";

import { requestJson } from "../api-client";
import { parseInsightRunResponse, parseWorkbenchResponse, type InsightRunResponse, type WorkbenchResponse } from "../renderer-contracts";

export type InsightRunType = "analysis" | "walkthrough";
export type InsightCompletionAction = { readonly _tag: "SaveAsReviewDraft" } | { readonly _tag: "OpenPreviewWhenComplete" } | { readonly _tag: "PublishWhenComplete"; readonly event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"; readonly authorizationId: string };

type InsightRunState = InsightRunResponse["status"] | "idle" | "error";

export type InsightRunController = {
  readonly status: InsightRunState;
  readonly runId?: string;
  readonly error: boolean;
  readonly failureReason?: InsightRunResponse["failureReason"];
  readonly busy: boolean;
  readonly run: (model: string, reasoning: "low" | "medium" | "high", completion?: InsightCompletionAction) => void;
  readonly cancel: () => void;
};

export function useInsightRun(input: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly type: InsightRunType;
  readonly activeRun?: WorkbenchResponse["insights"][InsightRunType]["activeRun"];
  readonly onWorkbenchReplace?: (workbench: WorkbenchResponse) => void;
  readonly onInsightPatch?: (type: InsightRunType, projection: WorkbenchResponse["insights"][InsightRunType]) => void;
  readonly onCompleted?: () => void;
}): InsightRunController {
  const { profileId, reviewId, type, activeRun, onWorkbenchReplace, onInsightPatch, onCompleted } = input;
  const persistedRunId = activeRun?.runId;
  const [status, setStatus] = useState<InsightRunState>("idle");
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [error, setError] = useState(false);
  const [failureReason, setFailureReason] = useState<InsightRunResponse["failureReason"]>();
  const [starting, setStarting] = useState(false);
  const activeRunRef = useRef<string | undefined>(undefined);
  const startingRef = useRef(false);
  const onWorkbenchReplaceRef = useRef(onWorkbenchReplace);
  const onInsightPatchRef = useRef(onInsightPatch);
  const onCompletedRef = useRef(onCompleted);
  onWorkbenchReplaceRef.current = onWorkbenchReplace;
  onInsightPatchRef.current = onInsightPatch;
  onCompletedRef.current = onCompleted;

  useEffect(() => {
    if (persistedRunId === undefined || startingRef.current || activeRunRef.current !== undefined) return;
    activeRunRef.current = persistedRunId;
    setRunId(persistedRunId);
    setStatus("running");
    setError(false);
    setFailureReason(undefined);
  }, [persistedRunId]);

  const run = useCallback((model: string, reasoning: "low" | "medium" | "high", completion?: InsightCompletionAction): void => {
    if (startingRef.current || activeRunRef.current !== undefined) return;
    startingRef.current = true;
    setStarting(true);
    setError(false);
    setFailureReason(undefined);
    void requestJson(`/v1/reviews/insights/${type}/run`, {
      method: "POST",
      body: { profileId, reviewId, type, model, reasoning, ...(completion === undefined ? {} : { completion }) },
    }).then((value) => {
      const parsed = parseInsightRunResponse(value);
      if (parsed === undefined || parsed.type !== type) throw new Error("Invalid Insight run response");
      activeRunRef.current = parsed.runId;
      startingRef.current = false;
      setStarting(false);
      setRunId(parsed.runId);
      setStatus(parsed.status);
    }).catch(() => {
      startingRef.current = false;
      setStarting(false);
      setError(true);
      setStatus("error");
    });
  }, [profileId, reviewId, type]);

  const cancel = useCallback((): void => {
    const activeRunId = activeRunRef.current;
    if (activeRunId === undefined) return;
    void requestJson(`/v1/reviews/insights/${type}/cancel`, {
      method: "POST",
      body: { profileId, reviewId, type, runId: activeRunId },
    }).then((value) => {
      const parsed = parseInsightRunResponse(value);
      if (parsed === undefined) throw new Error("Invalid Insight cancellation response");
      setStatus(parsed.status);
    }).catch(() => setError(true));
  }, [profileId, reviewId, type]);

  useEffect(() => {
    if (runId === undefined) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const value = await requestJson(`/v1/reviews/insights/runs/${encodeURIComponent(runId)}?profileId=${encodeURIComponent(profileId)}&reviewId=${encodeURIComponent(reviewId)}&type=${type}`);
        if (cancelled || activeRunRef.current !== runId) return;
        const parsed = parseInsightRunResponse(value);
        if (parsed === undefined || parsed.type !== type) throw new Error("Invalid Insight status response");
        setStatus(parsed.status);
        setFailureReason(parsed.failureReason);
        if (parsed.status === "completed" || parsed.status === "failed" || parsed.status === "cancelled") {
          const workbenchValue = await requestJson("/v1/reviews/load", {
            method: "POST",
            body: { profileId, reviewId },
          });
          const workbench = parseWorkbenchResponse(workbenchValue);
          if (workbench === undefined) throw new Error("Invalid Review projection response");
          if (!cancelled && activeRunRef.current === runId) {
            if (onInsightPatchRef.current !== undefined) {
              onInsightPatchRef.current(type, workbench.insights[type]);
            } else {
              onWorkbenchReplaceRef.current?.(workbench);
            }
          }
          if (parsed.status === "completed") onCompletedRef.current?.();
          activeRunRef.current = undefined;
          setRunId(undefined);
          return;
        }
      } catch {
        if (!cancelled) {
          setError(true);
          setStatus("error");
          activeRunRef.current = undefined;
          setRunId(undefined);
        }
        return;
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [profileId, reviewId, runId, type]);

  return {
    status,
    ...(runId === undefined ? {} : { runId }),
    error,
    ...(failureReason === undefined ? {} : { failureReason }),
    busy: starting || runId !== undefined || activeRun !== undefined,
    run,
    cancel,
  };
}
