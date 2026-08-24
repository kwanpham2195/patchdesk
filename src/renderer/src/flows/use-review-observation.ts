import { useCallback, useEffect, useRef, useState } from "react";
import * as v from "valibot";

import type { RecentReviewWrite } from "../../../domain/recent-review-write";
import { requestJson } from "../api-client";
import {
  parseWorkbenchResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";
import { useLatestCommitted } from "../hooks/use-latest-committed";

export type ReviewWorkbenchPatch = Omit<
  Partial<WorkbenchResponse>,
  "insights"
> & {
  readonly insights?: Partial<WorkbenchResponse["insights"]>;
};

export type ReviewObservationInput = {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
};

export type ReviewObservationResult = {
  readonly refreshing: boolean;
  readonly refreshError: boolean;
  readonly runDetect: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly replaceWorkbench: (workbench: WorkbenchResponse) => void;
  readonly runDirectCommand: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly observeConfirmedReviewWrite: (
    recentWrites?: ReadonlyArray<RecentReviewWrite>,
  ) => Promise<void>;
  readonly appendRecentWrites: (
    entries: RecentReviewWrite | ReadonlyArray<RecentReviewWrite>,
  ) => void;
};

const DETECT_INTERVAL_MS = 90_000;
const FOCUS_DETECT_DEBOUNCE_MS = 1_500;

/** Owns detector scheduling, refresh replacement, and the recent-write journal. */
export function useReviewObservation({
  workbench,
  onWorkbenchReplace,
  onWorkbenchPatch,
}: ReviewObservationInput): ReviewObservationResult {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
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
  const detectInFlightRef = useRef(false);
  const detectCompletionRef = useRef<Promise<void> | undefined>(undefined);
  const commandInFlightCountRef = useRef(0);
  const directCommandGenerationRef = useRef(0);
  const focusTimerRef = useRef<number | undefined>(undefined);
  const onWorkbenchPatchRef = useLatestCommitted(onWorkbenchPatch);
  const refreshInFlightCountRef = useRef(0);

  const appendRecentWrites = useCallback(
    (entries: RecentReviewWrite | ReadonlyArray<RecentReviewWrite>): void => {
      setRecentWrites((current) => [
        ...current,
        ...(Array.isArray(entries) ? entries : [entries]),
      ]);
    },
    [],
  );

  useEffect(() => {
    return () => {
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
    if (
      detectInFlightRef.current ||
      commandInFlightCountRef.current > 0 ||
      refreshInFlightCountRef.current > 0
    )
      return;
    detectInFlightRef.current = true;
    let resolveDetectCompletion!: () => void;
    const detectCompletion = new Promise<void>((resolve) => {
      resolveDetectCompletion = resolve;
    });
    detectCompletionRef.current = detectCompletion;
    const generation = generationRef.current;
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
          const next = parseWorkbenchResponse(observation.projection);
          if (
            next !== undefined &&
            next.review.id === current.review.id &&
            next.session.id === current.session.id &&
            next.revision.reviewedHeadSha === current.revision.reviewedHeadSha
          ) {
            replaceWorkbenchRef.current(next);
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
      detectInFlightRef.current = false;
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

  const requestRefresh = useCallback(async (): Promise<WorkbenchResponse> => {
    const wb = workbenchRef.current;
    generationRef.current += 1;
    refreshInFlightCountRef.current += 1;
    try {
      const value = await requestJson("/v1/reviews/refresh", {
        method: "POST",
        body: {
          profileId: wb.session.key.profileId,
          reviewId: wb.review.id,
        },
      });
      const parsed = parseWorkbenchResponse(value);
      if (parsed === undefined)
        throw new Error("Invalid Review refresh response");
      setDetectedStaleFreshness(undefined);
      replaceWorkbench(parsed);
      return parsed;
    } finally {
      refreshInFlightCountRef.current -= 1;
    }
  }, [replaceWorkbench, workbenchRef]);

  const refresh = useCallback(async (): Promise<void> => {
    const wb = workbenchRef.current;
    if (wb.review.status !== "open" || refreshingRef.current) return;
    setRefreshing(true);
    setRefreshError(false);
    try {
      await requestRefresh();
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
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
        const next = parseWorkbenchResponse(observation.projection);
        if (
          next !== undefined &&
          next.review.id === latest.review.id &&
          next.session.id === latest.session.id &&
          next.revision.reviewedHeadSha === latest.revision.reviewedHeadSha
        ) {
          replaceWorkbench(next);
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
