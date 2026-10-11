import {
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import * as v from "valibot";
import {
  guideReadingStateSchema,
  validateGuideReadingContent,
  type GuideReadingContent,
  type GuideReadingState,
} from "#src/domain/guide-reading-state";
import { isApiErrorCode, requestJson } from "#src/renderer/src/api-client";
import {
  parseWorkbenchResponse,
  type WorkbenchResponse,
} from "#src/renderer/src/renderer-contracts";
import type { ReviewWorkbenchPatch } from "#src/renderer/src/flows/use-review-observation";
import { GuideReadingSaveQueue } from "./guide-reading-save-queue";
import { GuideReadingFlushContext } from "./use-guide-reading-flush";
import { useLatestCommitted } from "./use-latest-committed";

/** Result-bound optimistic progress; Retry never silently discards failed local edits. */
export type GuideReadingControls = {
  readonly progress: GuideReadingState;
  readonly saveFailed: boolean;
  readonly edit: (state: GuideReadingContent) => void;
  readonly retry: () => Promise<boolean>;
};

function createQueue(
  workbench: WorkbenchResponse,
  onConfirmed: (state: GuideReadingState) => void,
  onReplaced: (guide: WorkbenchResponse["insights"]["guide"]) => void,
): GuideReadingSaveQueue | undefined {
  const guide = workbench.insights.guide;
  const retained = guide.retained;
  if (retained === undefined || retained.runId === undefined) return undefined;
  const identity = {
    profileId: workbench.session.key.profileId,
    reviewId: workbench.review.id,
    runId: retained.runId,
    sessionId: retained.sessionId,
  };
  const initial: GuideReadingState =
    guide.readingState ??
    v.parse(guideReadingStateSchema, {
      runId: retained.runId,
      sessionId: retained.sessionId,
      version: 0,
      reviewedGroupIds: [],
      expandedAppearances: [],
      anchor: { kind: "top" },
    });
  return new GuideReadingSaveQueue(
    initial,
    async (state, expectedStateVersion) => {
      let response;
      try {
        response = await requestJson(
          "/v1/reviews/insights/guide/reading-state",
          {
            method: "POST",
            body: { ...identity, expectedStateVersion, state },
          },
        );
      } catch (cause) {
        if (!isApiErrorCode(cause, "guide_identity_conflict")) throw cause;
        const next = parseWorkbenchResponse(
          await requestJson("/v1/reviews/load", {
            method: "POST",
            body: {
              profileId: identity.profileId,
              reviewId: identity.reviewId,
            },
          }),
        );
        const replacement = next?.insights.guide;
        if (
          next?.session.key.profileId !== identity.profileId ||
          next.review.id !== identity.reviewId ||
          replacement?.retained?.runId === undefined ||
          (replacement.retained.runId === retained.runId &&
            replacement.retained.sessionId === retained.sessionId)
        )
          throw new Error("Invalid Guide replacement receipt");
        onReplaced(
          replacement.retained.sessionId === workbench.session.id
            ? replacement
            : {
                ...replacement,
                status: "outdated",
                retained: { ...replacement.retained, freshness: "outdated" },
              },
        );
        return undefined;
      }
      const saved = v.parse(guideReadingStateSchema, response);
      if (
        saved.runId !== retained.runId ||
        saved.sessionId !== retained.sessionId ||
        saved.version !== expectedStateVersion + 1 ||
        validateGuideReadingContent(saved, retained.value)._tag === "err"
      )
        throw new Error("Invalid Guide reading-state receipt");
      return saved;
    },
    async () => {
      const next = parseWorkbenchResponse(
        await requestJson("/v1/reviews/load", {
          method: "POST",
          body: { profileId: identity.profileId, reviewId: identity.reviewId },
        }),
      );
      const progress = next?.insights.guide.readingState;
      if (
        progress === undefined ||
        progress.runId !== retained.runId ||
        progress.sessionId !== retained.sessionId
      )
        throw new Error("Guide changed during progress reload");
      return progress;
    },
    onConfirmed,
  );
}

/** The workbench owns this queue even while another tab hides its reader. */
export function useGuideReadingState(
  workbench: WorkbenchResponse,
  onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void,
): GuideReadingControls | undefined {
  const owner = useContext(GuideReadingFlushContext);
  const latest = useLatestCommitted({ workbench, onWorkbenchPatch });
  const retained = workbench.insights.guide.retained;
  const key = JSON.stringify([
    workbench.session.key.profileId,
    workbench.review.id,
    retained?.runId,
    retained?.sessionId,
  ]);
  const confirmed = useCallback(
    (state: GuideReadingState) => {
      const current = latest.current;
      const projection = current.workbench.insights.guide;
      if (
        current.workbench.session.key.profileId ===
          workbench.session.key.profileId &&
        current.workbench.review.id === workbench.review.id &&
        projection.retained?.runId === state.runId &&
        projection.retained.sessionId === state.sessionId
      )
        current.onWorkbenchPatch({
          insights: { guide: { ...projection, readingState: state } },
        });
    },
    [latest, workbench.session.key.profileId, workbench.review.id],
  );
  const replaced = useCallback(
    (guide: WorkbenchResponse["insights"]["guide"]) => {
      const current = latest.current;
      if (
        current.workbench.session.key.profileId ===
          workbench.session.key.profileId &&
        current.workbench.review.id === workbench.review.id &&
        current.workbench.insights.guide.retained?.runId === retained?.runId &&
        current.workbench.insights.guide.retained?.sessionId ===
          retained?.sessionId
      )
        current.onWorkbenchPatch({ insights: { guide } });
    },
    [
      latest,
      workbench.session.key.profileId,
      workbench.review.id,
      retained?.runId,
      retained?.sessionId,
    ],
  );
  const [held, setHeld] = useState(() => ({
    key,
    queue: createQueue(workbench, confirmed, replaced),
  }));
  if (held.key !== key)
    setHeld({ key, queue: createQueue(workbench, confirmed, replaced) });
  const queue = held.queue;
  const subscribe = useCallback(
    (listener: () => void) => queue?.subscribe(listener) ?? (() => undefined),
    [queue],
  );
  const read = useCallback(() => queue?.read(), [queue]);
  const snapshot = useSyncExternalStore(subscribe, read);
  useLayoutEffect(
    () =>
      queue === undefined
        ? undefined
        : owner?.register((retry) => (retry ? queue.retry() : queue.flush())),
    [owner, queue],
  );
  useLayoutEffect(() => {
    if (
      queue !== undefined &&
      workbench.insights.guide.readingState !== undefined
    )
      queue.acceptCanonical(workbench.insights.guide.readingState);
  }, [queue, workbench.insights.guide.readingState]);
  const edit = useCallback(
    (state: GuideReadingContent) => queue?.edit(state),
    [queue],
  );
  return snapshot === undefined || queue === undefined
    ? undefined
    : { ...snapshot, edit, retry: queue.retry };
}
