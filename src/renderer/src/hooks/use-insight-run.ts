import { useCallback, useEffect, useRef, useState } from "react";

import { requestJson } from "../api-client";
import { parseInsightRunResponse, parseWorkbenchResponse, type InsightRunResponse, type WorkbenchResponse } from "../renderer-contracts";

export type InsightRunType = "analysis" | "walkthrough";

type InsightRunState = InsightRunResponse["status"] | "idle" | "error";

export type InsightRunController = {
  readonly status: InsightRunState;
  readonly runId?: string;
  readonly error: boolean;
  readonly busy: boolean;
  readonly run: (model: string, reasoning: "low" | "medium" | "high") => void;
  readonly cancel: () => void;
};

export function useInsightRun(input: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly type: InsightRunType;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
}): InsightRunController {
  const { profileId, reviewId, type, onWorkbenchReplace } = input;
  const [status, setStatus] = useState<InsightRunState>("idle");
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [error, setError] = useState(false);
  const [starting, setStarting] = useState(false);
  const activeRunRef = useRef<string | undefined>(undefined);
  const startingRef = useRef(false);

  const run = useCallback((model: string, reasoning: "low" | "medium" | "high"): void => {
    if (startingRef.current || activeRunRef.current !== undefined) return;
    startingRef.current = true;
    setStarting(true);
    setError(false);
    void requestJson(`/v1/reviews/insights/${type}/run`, {
      method: "POST",
      body: { profileId, reviewId, type, model, reasoning },
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
        if (parsed.status === "completed" || parsed.status === "failed" || parsed.status === "cancelled") {
          const workbenchValue = await requestJson("/v1/reviews/load", {
            method: "POST",
            body: { profileId, reviewId },
          });
          const workbench = parseWorkbenchResponse(workbenchValue);
          if (workbench === undefined) throw new Error("Invalid Review projection response");
          if (!cancelled && activeRunRef.current === runId) onWorkbenchReplace(workbench);
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
  }, [onWorkbenchReplace, profileId, reviewId, runId, type]);

  return {
    status,
    ...(runId === undefined ? {} : { runId }),
    error,
    busy: starting || runId !== undefined,
    run,
    cancel,
  };
}
