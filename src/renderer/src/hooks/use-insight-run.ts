import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

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

/** The Insight types a run can be started for; the wire contract owns the list. */
export type InsightRunType = InsightRunResponse["type"];
type InsightRunState = InsightRunResponse["status"] | "idle" | "error";
type InsightRunRequestFailure = "start" | "cancel" | "status";

export type InsightRunController = {
  readonly status: InsightRunState;
  readonly runId?: string;
  readonly error: boolean;
  readonly requestFailure?: InsightRunRequestFailure;
  readonly failureReason?: InsightRunResponse["failureReason"];
  readonly starting: boolean;
  readonly cancelling: boolean;
  readonly busy: boolean;
  readonly run: (
    provider: InsightProvider,
    model: string,
    reasoning: InsightReasoning,
    onAccepted?: () => void,
  ) => void;
  readonly cancel: () => void;
};

/** Owns one generation-safe Insight start, poll, and cancellation lifecycle. */
export function useInsightRun(input: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly type: InsightRunType;
  readonly activeRun?: NonNullable<
    WorkbenchResponse["insights"][InsightRunType]
  >["activeRun"];
  readonly onWorkbenchReplace?: (workbench: WorkbenchResponse) => void;
  readonly onInsightPatch?: (
    type: InsightRunType,
    projection: NonNullable<WorkbenchResponse["insights"][InsightRunType]>,
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
  const scope = `${profileId}\u0000${reviewId}\u0000${type}`;
  const [status, setStatus] = useState<InsightRunState>(() =>
    persistedRunId === undefined ? "idle" : "running",
  );
  const [runId, setRunId] = useState<string | undefined>(persistedRunId);
  const [requestFailure, setRequestFailure] =
    useState<InsightRunRequestFailure>();
  const [failureReason, setFailureReason] =
    useState<InsightRunResponse["failureReason"]>();
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const scopeRef = useRef(scope);
  const persistedRunIdRef = useRef(persistedRunId);
  const generationRef = useRef(0);
  const activeRunRef = useRef<string | undefined>(persistedRunId);
  const startingRef = useRef(false);
  const cancellingRef = useRef(false);
  const mountedRef = useRef(true);
  const onWorkbenchReplaceRef = useLatestCommitted(onWorkbenchReplace);
  const onInsightPatchRef = useLatestCommitted(onInsightPatch);
  const onCompletedRef = useLatestCommitted(onCompleted);

  useLayoutEffect(() => {
    if (scopeRef.current !== scope) {
      scopeRef.current = scope;
      persistedRunIdRef.current = persistedRunId;
      generationRef.current += 1;
      activeRunRef.current = persistedRunId;
      startingRef.current = false;
      cancellingRef.current = false;
      setRunId(persistedRunId);
      setStatus(persistedRunId === undefined ? "idle" : "running");
      setRequestFailure(undefined);
      setFailureReason(undefined);
      setStarting(false);
      setCancelling(false);
      return;
    }
    if (persistedRunIdRef.current === persistedRunId) return;
    persistedRunIdRef.current = persistedRunId;
    if (
      persistedRunId === undefined ||
      persistedRunId === activeRunRef.current ||
      startingRef.current
    )
      return;
    generationRef.current += 1;
    activeRunRef.current = persistedRunId;
    cancellingRef.current = false;
    setRunId(persistedRunId);
    setStatus("running");
    setRequestFailure(undefined);
    setFailureReason(undefined);
    setCancelling(false);
  }, [persistedRunId, scope]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  const run = useCallback(
    (
      provider: InsightProvider,
      model: string,
      reasoning: InsightReasoning,
      onAccepted?: () => void,
    ): void => {
      if (
        startingRef.current ||
        cancellingRef.current ||
        activeRunRef.current !== undefined
      )
        return;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      startingRef.current = true;
      setStarting(true);
      setRequestFailure(undefined);
      setFailureReason(undefined);
      void requestJson(`/v1/reviews/insights/${type}/run`, {
        method: "POST",
        body: { profileId, reviewId, type, provider, model, reasoning },
      })
        .then((value) => {
          const parsed = parseInsightRunResponse(value);
          if (parsed === undefined || parsed.type !== type)
            throw new Error("Invalid Insight run response");
          if (!mountedRef.current || generationRef.current !== generation)
            return;
          activeRunRef.current = parsed.runId;
          setRunId(parsed.runId);
          setStatus(parsed.status);
          onAccepted?.();
        })
        .catch(() => {
          if (!mountedRef.current || generationRef.current !== generation)
            return;
          setRequestFailure("start");
          setStatus("error");
        })
        .finally(() => {
          if (!mountedRef.current || generationRef.current !== generation)
            return;
          startingRef.current = false;
          setStarting(false);
        });
    },
    [profileId, reviewId, type],
  );

  const cancel = useCallback((): void => {
    const activeRunId = activeRunRef.current;
    if (
      activeRunId === undefined ||
      startingRef.current ||
      cancellingRef.current
    )
      return;
    const generation = generationRef.current;
    cancellingRef.current = true;
    setCancelling(true);
    setRequestFailure(undefined);
    void requestJson(`/v1/reviews/insights/${type}/cancel`, {
      method: "POST",
      body: { profileId, reviewId, type, runId: activeRunId },
    })
      .then((value) => {
        const parsed = parseInsightRunResponse(value);
        if (
          parsed === undefined ||
          parsed.type !== type ||
          parsed.runId !== activeRunId
        )
          throw new Error("Invalid Insight cancellation response");
        if (
          !mountedRef.current ||
          generationRef.current !== generation ||
          activeRunRef.current !== activeRunId
        )
          return;
        setStatus(parsed.status);
      })
      .catch(() => {
        if (
          !mountedRef.current ||
          generationRef.current !== generation ||
          activeRunRef.current !== activeRunId
        )
          return;
        setRequestFailure("cancel");
      })
      .finally(() => {
        if (
          !mountedRef.current ||
          generationRef.current !== generation ||
          activeRunRef.current !== activeRunId
        )
          return;
        cancellingRef.current = false;
        setCancelling(false);
      });
  }, [profileId, reviewId, type]);

  useEffect(() => {
    if (runId === undefined) return undefined;
    const generation = generationRef.current;
    let disposed = false;
    let timer: number | undefined;
    const ownsRun = (): boolean =>
      !disposed &&
      generationRef.current === generation &&
      activeRunRef.current === runId;
    const poll = (): void => {
      void requestJson(
        `/v1/reviews/insights/runs/${encodeURIComponent(runId)}?profileId=${encodeURIComponent(profileId)}&reviewId=${encodeURIComponent(reviewId)}&type=${type}`,
      )
        .then((value) => {
          if (!ownsRun()) return undefined;
          const parsed = parseInsightRunResponse(value);
          if (
            parsed === undefined ||
            parsed.type !== type ||
            parsed.runId !== runId
          )
            throw new Error("Invalid Insight status response");
          setStatus(parsed.status);
          setFailureReason(parsed.failureReason);
          setRequestFailure(undefined);
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
          if (terminal === undefined || !ownsRun()) return;
          const workbench = parseWorkbenchResponse(terminal.workbenchValue);
          if (workbench === undefined)
            throw new Error("Invalid Review projection response");
          // A projection that carries no Brief at all cannot be patched into
          // place, so the whole workbench is replaced instead.
          const projected = workbench.insights[type];
          if (
            onInsightPatchRef.current !== undefined &&
            projected !== undefined
          )
            onInsightPatchRef.current(type, projected);
          else onWorkbenchReplaceRef.current?.(workbench);
          if (terminal.parsed.status === "completed")
            onCompletedRef.current?.();
          activeRunRef.current = undefined;
          cancellingRef.current = false;
          setCancelling(false);
          setRunId(undefined);
        })
        .catch(() => {
          if (!ownsRun()) return;
          setRequestFailure("status");
          setStatus("error");
        })
        .finally(() => {
          if (ownsRun()) timer = window.setTimeout(poll, 500);
        });
    };
    poll();
    return () => {
      disposed = true;
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
    error: requestFailure !== undefined,
    ...definedProps({ requestFailure, failureReason }),
    starting,
    cancelling,
    busy: starting || runId !== undefined || activeRun !== undefined,
    run,
    cancel,
  };
}
