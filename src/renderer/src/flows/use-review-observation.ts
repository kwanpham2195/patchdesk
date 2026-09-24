import { useCallback, useEffect, useRef, useState } from "react";
import * as v from "valibot";

import {
  appendRecentWriteReceipts,
  type RecentReviewWrite,
} from "../../../domain/recent-review-write";
import { requestJson } from "../api-client";
import {
  parseWorkbenchResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";
import { useLatestCommitted } from "../hooks/use-latest-committed";
import { useDurableRefreshResume } from "../hooks/use-durable-refresh-resume";
import { reconciledProjection } from "./review-observation-projection";

export type ReviewWorkbenchPatch = Omit<
  Partial<WorkbenchResponse>,
  "insights"
> & {
  readonly insights?: Partial<WorkbenchResponse["insights"]>;
};

/** Runs one renderer-issued write through the observation queue. */
export type RunDirectCommand = <T>(operation: () => Promise<T>) => Promise<T>;

/** Records writes the renderer just made so the next read can confirm them. */
export type AppendRecentWrites = (
  entries: RecentReviewWrite | ReadonlyArray<RecentReviewWrite>,
) => void;

export type ReviewObservationInput = {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
};

export type ReviewObservationResult = {
  readonly refreshing: boolean;
  readonly refreshError:
    | "github_read"
    | "github_auth"
    | "not_found"
    | "storage"
    | "head_changed"
    | "terminal"
    | "interrupted"
    | undefined;
  readonly runDetect: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  /** Adopts the pull request's current revision; rejects when the refresh fails. */
  readonly requestRefresh: () => Promise<WorkbenchResponse>;
  /** Rebuilds the represented Review's local preparation without changing its revision. */
  readonly requestReprepare: () => Promise<WorkbenchResponse>;
  readonly replaceWorkbench: (workbench: WorkbenchResponse) => void;
  readonly runDirectCommand: RunDirectCommand;
  readonly observeConfirmedReviewWrite: (
    recentWrites?: ReadonlyArray<RecentReviewWrite>,
  ) => Promise<void>;
  readonly appendRecentWrites: AppendRecentWrites;
};

const DETECT_INTERVAL_MS = 90_000;
const FOCUS_DETECT_DEBOUNCE_MS = 1_500;
const REFRESH_BEGINNING = "beginning";

/** Owns detector scheduling, refresh replacement, and the recent-write journal. */
export function useReviewObservation({
  workbench,
  onWorkbenchReplace,
  onWorkbenchPatch,
}: ReviewObservationInput): ReviewObservationResult {
  const [refreshActivity, setRefreshActivity] = useState(() =>
    loadRefreshOperationId(refreshOperationKey(workbench)) === undefined
      ? 0
      : 1,
  );
  const refreshing = refreshActivity > 0;
  const [refreshError, setRefreshError] =
    useState<ReviewObservationResult["refreshError"]>(undefined);
  const [recentWrites, setRecentWrites] = useState<
    ReadonlyArray<RecentReviewWrite>
  >([]);
  const [detectedStaleFreshness, setDetectedStaleFreshness] = useState<
    "fresh" | "not_refreshed" | "unavailable" | undefined
  >(undefined);
  const replaceWorkbench = useCallback(
    (next: WorkbenchResponse): void => {
      setRecentWrites([]);
      onWorkbenchReplace(next);
    },
    [onWorkbenchReplace],
  );
  const replaceWorkbenchRef = useLatestCommitted(replaceWorkbench);
  const workbenchRef = useLatestCommitted(workbench);
  const recentWritesRef = useLatestCommitted(recentWrites);
  const detectedStaleFreshnessRef = useLatestCommitted(detectedStaleFreshness);
  const refreshingRef = useLatestCommitted(refreshing);
  const [initialSnapshotKey] = useState(() => snapshotKey(workbench));
  const snapshotKeyRef = useRef(initialSnapshotKey);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const mountEpochRef = useRef(0);
  // Keyed by generation so a Strict Mode remount, which bumps the generation and discards the first run's result, can start its own run.
  const detectInFlightGenerationRef = useRef<number | undefined>(undefined);
  const detectCompletionRef = useRef<Promise<void> | undefined>(undefined);
  const commandInFlightCountRef = useRef(0);
  const directCommandGenerationRef = useRef(0);
  const focusTimerRef = useRef<number | undefined>(undefined);
  const onWorkbenchPatchRef = useLatestCommitted(onWorkbenchPatch);
  const refreshInFlightCountRef = useRef(0);

  const appendRecentWrites = useCallback(
    (entries: RecentReviewWrite | ReadonlyArray<RecentReviewWrite>): void => {
      setRecentWrites((current) =>
        appendRecentWriteReceipts(
          current,
          Array.isArray(entries) ? entries : [entries],
        ),
      );
    },
    [],
  );

  useEffect(() => {
    mountEpochRef.current += 1;
    mountedRef.current = true;
    const mountEpoch = mountEpochRef.current;
    return () => {
      if (mountEpochRef.current === mountEpoch) mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);
  useEffect(() => {
    const key = snapshotKey(workbench);
    if (key !== snapshotKeyRef.current) {
      snapshotKeyRef.current = key;
      generationRef.current += 1;
    }
  }, [workbench]);

  const runDetect = useCallback(async (): Promise<void> => {
    const wb = workbenchRef.current;
    if (wb.review.status !== "open") return;
    if (document.visibilityState !== "visible") return;
    const generation = generationRef.current;
    if (
      detectInFlightGenerationRef.current === generation ||
      commandInFlightCountRef.current > 0 ||
      refreshInFlightCountRef.current > 0
    )
      return;
    detectInFlightGenerationRef.current = generation;
    let resolveDetectCompletion!: () => void;
    const detectCompletion = new Promise<void>((resolve) => {
      resolveDetectCompletion = resolve;
    });
    detectCompletionRef.current = detectCompletion;
    const directCommandGeneration = directCommandGenerationRef.current;
    const key = snapshotKey(wb);
    try {
      const journal = recentWritesRef.current;
      const detectUpdatesBody = {
        profileId: wb.session.key.profileId,
        reviewId: wb.review.id,
      };
      const value = await requestJson("/v1/reviews/detect-updates", {
        method: "POST",
        body:
          journal.length === 0
            ? detectUpdatesBody
            : { ...detectUpdatesBody, recentWrites: journal },
      });
      const current = workbenchRef.current;
      if (
        generationRef.current !== generation ||
        directCommandGenerationRef.current !== directCommandGeneration ||
        snapshotKey(current) !== key
      )
        return;
      const observation = isReviewObservation(value);
      if (observation !== undefined) {
        if (observation._tag === "Reconciled") {
          const next = reconciledProjection(observation);
          if (
            next._tag === "parsed" &&
            next.workbench.review.id === current.review.id &&
            next.workbench.session.id === current.session.id &&
            next.workbench.revision.reviewedHeadSha ===
              current.revision.reviewedHeadSha
          ) {
            replaceWorkbenchRef.current(next.workbench);
            setDetectedStaleFreshness(undefined);
          }
        } else if (observation._tag === "RevisionChanged") {
          onWorkbenchPatchRef.current({
            revision: { ...current.revision, freshness: "updates_available" },
          });
        } else if (observation._tag === "Unavailable") {
          onWorkbenchPatchRef.current({
            revision: { ...current.revision, freshness: "unavailable" },
          });
        } else if (observation._tag === "Terminal") {
          onWorkbenchPatchRef.current({
            review: { ...current.review, status: observation.status },
          });
        }
        return;
      }
      if (isDetection(value) && value.updatesAvailable) {
        if (current.revision.freshness !== "updates_available") {
          if (detectedStaleFreshnessRef.current === undefined)
            setDetectedStaleFreshness(current.revision.freshness);
          onWorkbenchPatchRef.current({
            revision: { ...current.revision, freshness: "updates_available" },
          });
        }
      } else if (
        isDetection(value) &&
        !value.updatesAvailable &&
        current.revision.freshness === "updates_available"
      ) {
        onWorkbenchPatchRef.current({
          revision: {
            ...current.revision,
            freshness: detectedStaleFreshnessRef.current ?? "fresh",
          },
        });
        setDetectedStaleFreshness(undefined);
      }
    } catch {
      // Detection is advisory and never replaces the represented snapshot.
    } finally {
      if (detectInFlightGenerationRef.current === generation)
        detectInFlightGenerationRef.current = undefined;
      resolveDetectCompletion();
      if (detectCompletionRef.current === detectCompletion)
        detectCompletionRef.current = undefined;
    }
  }, [
    detectedStaleFreshnessRef,
    onWorkbenchPatchRef,
    recentWritesRef,
    replaceWorkbenchRef,
    workbenchRef,
  ]);

  useEffect(() => {
    void runDetect();
    if (workbench.review.status !== "open") return undefined;
    const timer = window.setInterval(() => {
      if (focusTimerRef.current !== undefined) {
        window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = undefined;
      }
      void runDetect();
    }, DETECT_INTERVAL_MS);
    const scheduleFocusDetect = (): void => {
      if (document.visibilityState !== "visible") return;
      if (focusTimerRef.current !== undefined)
        window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = window.setTimeout(() => {
        focusTimerRef.current = undefined;
        void runDetect();
      }, FOCUS_DETECT_DEBOUNCE_MS);
    };
    const onFocus = (): void => scheduleFocusDetect();
    const onVisibility = (): void => scheduleFocusDetect();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (focusTimerRef.current !== undefined)
        window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = undefined;
    };
  }, [runDetect, workbench.review.status]);

  const runRefreshOperation = useCallback(
    async (
      operationId?: string,
      startPath = "/v1/reviews/refresh",
    ): Promise<WorkbenchResponse> => {
      const wb = workbenchRef.current;
      generationRef.current += 1;
      const generation = generationRef.current;
      refreshInFlightCountRef.current += 1;
      try {
        const operationKey = refreshOperationKey(wb);
        let activeOperationId = operationId;
        if (activeOperationId === undefined) {
          saveRefreshOperationId(operationKey, REFRESH_BEGINNING);
          const begun = parseRefreshOperationStatus(
            await requestJson(startPath, {
              method: "POST",
              body: {
                profileId: wb.session.key.profileId,
                reviewId: wb.review.id,
              },
            }),
          );
          if (begun === undefined) throw new RefreshOperationError("storage");
          activeOperationId = begun.operationId;
          saveRefreshOperationId(operationKey, activeOperationId);
        }
        let status: RefreshOperationStatus | undefined;
        while (
          generationRef.current === generation &&
          snapshotKey(workbenchRef.current) === snapshotKey(wb)
        ) {
          status = parseRefreshOperationStatus(
            await requestJson("/v1/reviews/refresh/status", {
              method: "POST",
              body: {
                profileId: wb.session.key.profileId,
                reviewId: wb.review.id,
                operationId: activeOperationId,
              },
            }),
          );
          if (status === undefined) throw new RefreshOperationError("storage");
          if (
            generationRef.current !== generation ||
            snapshotKey(workbenchRef.current) !== snapshotKey(wb)
          )
            throw new RefreshOperationError("interrupted");
          if (status.state !== "requested" && status.state !== "prepared")
            break;
          await refreshPollDelay();
        }
        if (generationRef.current !== generation)
          throw new RefreshOperationError("interrupted");
        if (status === undefined) throw new RefreshOperationError("storage");
        if (status.state === "failed" || status.state === "interrupted") {
          clearRefreshOperationId(operationKey);
          try {
            await acknowledgeRefreshOperation(wb, activeOperationId);
          } catch {
            // Terminal state is already known; acknowledgment is cleanup and cannot change it.
          }
          throw new RefreshOperationError(
            status.state === "interrupted"
              ? "interrupted"
              : (status.reason ?? "storage"),
          );
        }
        if (status.state !== "completed")
          throw new RefreshOperationError("interrupted");
        const value = await requestJson("/v1/reviews/load", {
          method: "POST",
          body: {
            profileId: wb.session.key.profileId,
            reviewId: wb.review.id,
          },
        });
        const parsed = parseWorkbenchResponse(value);
        if (parsed === undefined)
          throw new Error("Invalid Review refresh response");
        clearRefreshOperationId(operationKey);
        if (generationRef.current === generation) {
          setDetectedStaleFreshness(undefined);
          replaceWorkbench(parsed);
        }
        try {
          await acknowledgeRefreshOperation(wb, activeOperationId);
        } catch {
          // The exact saved Review is already loaded; acknowledgment is best-effort cleanup.
        }
        return parsed;
      } finally {
        refreshInFlightCountRef.current -= 1;
      }
    },
    [replaceWorkbench, workbenchRef],
  );

  const requestRefresh = useCallback(
    (): Promise<WorkbenchResponse> => runRefreshOperation(),
    [runRefreshOperation],
  );

  const requestReprepare = useCallback(
    (): Promise<WorkbenchResponse> =>
      runRefreshOperation(undefined, "/v1/reviews/reprepare"),
    [runRefreshOperation],
  );

  const currentRefreshOperationKey = refreshOperationKey(workbench);
  const resumeRefreshOperation = useCallback(
    async (operationKey: string, mountEpoch: number): Promise<void> => {
      let operationId = loadRefreshOperationId(operationKey);
      if (operationId === undefined) return;
      await waitForRefreshSlot(
        () => mountEpochRef.current === mountEpoch,
        () => refreshInFlightCountRef.current > 0,
      );
      if (mountEpochRef.current !== mountEpoch) return;
      operationId = loadRefreshOperationId(operationKey);
      if (operationId === undefined) return;
      setRefreshError(undefined);
      setRefreshActivity((current) => Math.max(1, current));
      try {
        await runRefreshOperation(
          operationId === REFRESH_BEGINNING ? undefined : operationId,
        );
      } catch (cause: unknown) {
        if (mountEpochRef.current === mountEpoch)
          setRefreshError(refreshFailureReason(cause));
      } finally {
        if (mountEpochRef.current === mountEpoch)
          setRefreshActivity((current) => Math.max(0, current - 1));
      }
    },
    [runRefreshOperation],
  );
  useDurableRefreshResume(
    currentRefreshOperationKey,
    mountEpochRef,
    resumeRefreshOperation,
  );

  const refresh = useCallback(async (): Promise<void> => {
    const wb = workbenchRef.current;
    if (
      wb.review.status !== "open" ||
      refreshingRef.current ||
      refreshInFlightCountRef.current > 0
    )
      return;
    setRefreshActivity((current) => current + 1);
    setRefreshError(undefined);
    try {
      await requestRefresh();
    } catch (cause: unknown) {
      if (mountedRef.current) setRefreshError(refreshFailureReason(cause));
    } finally {
      if (mountedRef.current)
        setRefreshActivity((current) => Math.max(0, current - 1));
    }
  }, [refreshingRef, requestRefresh, workbenchRef]);

  const runDirectCommand = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      directCommandGenerationRef.current += 1;
      commandInFlightCountRef.current += 1;
      try {
        await detectCompletionRef.current;
        return await operation();
      } finally {
        commandInFlightCountRef.current -= 1;
      }
    },
    [],
  );

  const observeConfirmedReviewWrite = useCallback(
    async (recentWrites?: ReadonlyArray<RecentReviewWrite>): Promise<void> => {
      const current = workbenchRef.current;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const key = snapshotKey(current);
      const detectUpdatesBody = {
        profileId: current.session.key.profileId,
        reviewId: current.review.id,
      };
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/detect-updates", {
          method: "POST",
          body:
            recentWrites === undefined
              ? detectUpdatesBody
              : { ...detectUpdatesBody, recentWrites },
        }),
      );
      const latest = workbenchRef.current;
      if (generationRef.current !== generation || snapshotKey(latest) !== key)
        return;
      const observation = isReviewObservation(value);
      if (observation?._tag === "Reconciled") {
        const next = reconciledProjection(observation);
        if (
          next._tag === "parsed" &&
          next.workbench.review.id === latest.review.id &&
          next.workbench.session.id === latest.session.id &&
          next.workbench.revision.reviewedHeadSha ===
            latest.revision.reviewedHeadSha
        ) {
          replaceWorkbench(next.workbench);
          setDetectedStaleFreshness(undefined);
        }
        return;
      }
      if (observation?._tag === "RevisionChanged") {
        onWorkbenchPatchRef.current({
          revision: { ...latest.revision, freshness: "updates_available" },
        });
      } else if (observation?._tag === "Unavailable") {
        onWorkbenchPatchRef.current({
          revision: { ...latest.revision, freshness: "unavailable" },
        });
      } else if (observation?._tag === "Terminal") {
        onWorkbenchPatchRef.current({
          review: { ...latest.review, status: observation.status },
        });
      }
    },
    [onWorkbenchPatchRef, replaceWorkbench, runDirectCommand, workbenchRef],
  );

  return {
    refreshing,
    refreshError,
    runDetect,
    refresh,
    requestRefresh,
    requestReprepare,
    replaceWorkbench,
    runDirectCommand,
    observeConfirmedReviewWrite,
    appendRecentWrites,
  };
}

const detectionSchema = v.looseObject({ updatesAvailable: v.boolean() });

function isDetection(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this predicate is itself the JSON I/O boundary parser for the detect-updates response; no earlier parser can run here.
  value: unknown,
): value is { readonly updatesAvailable: boolean } {
  return v.safeParse(detectionSchema, value).success;
}

const reviewObservationSchema = v.variant("_tag", [
  v.looseObject({ _tag: v.literal("Unchanged") }),
  v.looseObject({ _tag: v.literal("RevisionChanged") }),
  v.looseObject({ _tag: v.literal("Unavailable") }),
  v.looseObject({
    _tag: v.literal("Reconciled"),
    projection: v.optional(v.unknown()),
  }),
  v.looseObject({
    _tag: v.literal("Terminal"),
    status: v.picklist(["merged", "closed"]),
  }),
]);

function isReviewObservation(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this predicate is itself the JSON I/O boundary parser for the review-observation response; no earlier parser can run here.
  value: unknown,
):
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Reconciled"; readonly projection?: unknown }
  | { readonly _tag: "RevisionChanged" }
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Terminal"; readonly status: "merged" | "closed" }
  | undefined {
  const parsed = v.safeParse(reviewObservationSchema, value);
  return parsed.success ? parsed.output : undefined;
}

function snapshotKey(workbench: WorkbenchResponse): string {
  return `${workbench.review.id}:${workbench.session.id}:${workbench.revision.reviewedHeadSha}:${workbench.revision.refreshedAt}`;
}

type RefreshFailureReason = NonNullable<
  ReviewObservationResult["refreshError"]
>;

type RefreshOperationStatus = {
  readonly operationId: string;
  readonly state:
    | "requested"
    | "prepared"
    | "completed"
    | "interrupted"
    | "failed";
  readonly reason?: Exclude<RefreshFailureReason, "interrupted">;
};

class RefreshOperationError extends Error {
  constructor(readonly reason: RefreshFailureReason) {
    super(reason);
  }
}

const refreshOperationStatusSchema = v.strictObject({
  operationId: v.pipe(v.string(), v.minLength(1)),
  state: v.picklist([
    "requested",
    "prepared",
    "completed",
    "interrupted",
    "failed",
  ]),
  reason: v.optional(
    v.picklist([
      "github_read",
      "github_auth",
      "not_found",
      "storage",
      "head_changed",
      "terminal",
    ]),
  ),
});

function parseRefreshOperationStatus(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the renderer's local-API response parser boundary.
  value: unknown,
): RefreshOperationStatus | undefined {
  const parsed = v.safeParse(refreshOperationStatusSchema, value);
  if (!parsed.success) return undefined;
  return parsed.output.reason === undefined
    ? {
        operationId: parsed.output.operationId,
        state: parsed.output.state,
      }
    : {
        operationId: parsed.output.operationId,
        state: parsed.output.state,
        reason: parsed.output.reason,
      };
}

function refreshOperationKey(workbench: WorkbenchResponse): string {
  return `patchdesk:refresh:${workbench.session.key.profileId}:${workbench.review.id}`;
}

function loadRefreshOperationId(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveRefreshOperationId(key: string, operationId: string): void {
  try {
    window.localStorage.setItem(key, operationId);
  } catch {
    // The in-memory owner keeps polling when persistent browser storage is unavailable.
  }
}

function clearRefreshOperationId(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // A stale key is harmless: the next load receives operation_expired.
  }
}

function refreshPollDelay(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 500));
}

async function waitForRefreshSlot(
  ownsMount: () => boolean,
  isBusy: () => boolean,
): Promise<void> {
  if (!ownsMount() || !isBusy()) return;
  await refreshPollDelay();
  return waitForRefreshSlot(ownsMount, isBusy);
}

async function acknowledgeRefreshOperation(
  workbench: WorkbenchResponse,
  operationId: string,
): Promise<void> {
  await requestJson("/v1/reviews/refresh/acknowledge", {
    method: "POST",
    body: {
      profileId: workbench.session.key.profileId,
      reviewId: workbench.review.id,
      operationId,
    },
  });
}

function refreshFailureReason(cause: unknown): RefreshFailureReason {
  return cause instanceof RefreshOperationError ? cause.reason : "storage";
}
