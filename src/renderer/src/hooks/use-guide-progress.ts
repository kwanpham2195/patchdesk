import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import * as v from "valibot";

import { guideFileIdSchema, guideGroupIdSchema } from "#src/domain/guide";
import {
  guideAnchorSchema,
  guideAppearanceGroupSchema,
  type GuideProgressMutationRequest,
  type GuideSummary,
} from "#src/domain/guide-progress";
import {
  guideReadingStateSchema,
  type GuideReadingContent,
  type GuideReadingState,
} from "#src/domain/guide-reading-state";
import { isApiErrorCode } from "#src/renderer/src/api-client";
import {
  parseGuidePageReply,
  parseGuideSummaryReply,
} from "#src/renderer/src/guide-contracts";
import { requestGuideJson } from "./guide-request-scheduler";
import { GuideReadingSaveQueue } from "./guide-reading-save-queue";
import type { GuideReadingControls } from "./use-guide-reading-state";
import { GuideReadingFlushContext } from "./use-guide-reading-flush";
import { useLatestCommitted } from "./use-latest-committed";

type ReadySummary = Extract<GuideSummary, { _tag: "ready" }>;
type Mutation = GuideProgressMutationRequest["mutation"];
type Identity = { readonly profileId: string; readonly reviewId: string };

const appearanceKey = (appearance: {
  readonly groupId: string;
  readonly fileId: string;
}): string => `${appearance.groupId}/${appearance.fileId}`;

/** The single-mark mutations that turn one content into another; each is its own versioned request. */
function mutationsBetween(
  from: GuideReadingContent,
  to: GuideReadingContent,
): ReadonlyArray<Mutation> {
  const mutations: Mutation[] = [];
  const reviewedBefore = new Set<string>(from.reviewedGroupIds);
  const reviewedAfter = new Set<string>(to.reviewedGroupIds);
  for (const groupId of to.reviewedGroupIds)
    if (!reviewedBefore.has(groupId))
      mutations.push({
        action: "set_reviewed",
        groupId: v.parse(guideGroupIdSchema, groupId),
        value: true,
      });
  for (const groupId of from.reviewedGroupIds)
    if (!reviewedAfter.has(groupId))
      mutations.push({
        action: "set_reviewed",
        groupId: v.parse(guideGroupIdSchema, groupId),
        value: false,
      });
  const expandedBefore = new Set(from.expandedAppearances.map(appearanceKey));
  const expandedAfter = new Set(to.expandedAppearances.map(appearanceKey));
  for (const appearance of to.expandedAppearances)
    if (!expandedBefore.has(appearanceKey(appearance)))
      mutations.push({
        action: "set_expanded",
        groupId: v.parse(guideAppearanceGroupSchema, appearance.groupId),
        fileId: v.parse(guideFileIdSchema, appearance.fileId),
        value: true,
      });
  for (const appearance of from.expandedAppearances)
    if (!expandedAfter.has(appearanceKey(appearance)))
      mutations.push({
        action: "set_expanded",
        groupId: v.parse(guideAppearanceGroupSchema, appearance.groupId),
        fileId: v.parse(guideFileIdSchema, appearance.fileId),
        value: false,
      });
  if (JSON.stringify(from.anchor) !== JSON.stringify(to.anchor))
    mutations.push({
      action: "set_anchor",
      anchor: v.parse(guideAnchorSchema, to.anchor),
    });
  return mutations;
}

/** Reads every reviewed mark and expanded appearance page for one exact result digest. */
async function loadProgress(
  identity: Identity,
  summary: ReadySummary,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GuideReadingState> {
  const reviewedGroupIds: string[] = [];
  const expandedAppearances: Array<{ groupId: string; fileId: string }> = [];
  for (const kind of ["reviewed", "expanded"] as const) {
    let cursor: string | null = null;
    do {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- progress pages follow their cursors in order
      const page = parseGuidePageReply(
        await requestGuideJson(
          "/v1/reviews/insights/guide/page",
          {
            method: "POST",
            body: {
              ...identity,
              digest: summary.digest,
              page: { kind, cursor },
            },
          },
          options,
        ),
      );
      if (page === undefined || page.kind !== kind)
        throw new Error("Invalid Guide progress page");
      if (page.kind === "reviewed") reviewedGroupIds.push(...page.groups);
      else if (page.kind === "expanded")
        expandedAppearances.push(...page.appearances);
      cursor = page.next;
    } while (cursor !== null);
  }
  const canonical = parseGuideSummaryReply(
    await requestGuideJson(
      "/v1/reviews/insights/guide/summary",
      { method: "POST", body: identity },
      options,
    ),
  );
  // Both lists and the anchor must belong to the same monotonic progress version.
  if (
    canonical?._tag !== "ready" ||
    canonical.digest !== summary.digest ||
    canonical.progressVersion !== summary.progressVersion ||
    JSON.stringify(canonical.anchor) !== JSON.stringify(summary.anchor)
  )
    throw new Error("Guide progress changed while loading");
  return v.parse(guideReadingStateSchema, {
    runId: summary.runId,
    sessionId: summary.sessionId,
    version: summary.progressVersion,
    reviewedGroupIds,
    expandedAppearances,
    anchor: summary.anchor,
  });
}

/**
 * Digest-bound reading progress for the paged Guide. It reuses the optimistic save queue: edits apply at once and a
 * refusal keeps them until Retry. Each queued save is sent as single-mark requests under the expected version; a
 * conflicting version reloads the stored progress before another attempt, and a replaced result retires the queue.
 */
export function useGuideProgress(
  identity: Identity,
  summary: ReadySummary | undefined,
): GuideReadingControls | undefined {
  const owner = useContext(GuideReadingFlushContext);
  const { profileId, reviewId } = identity;
  const scope = JSON.stringify([profileId, reviewId]);
  const requestedKey = JSON.stringify([profileId, reviewId, summary?.digest]);
  const latestSummary = useLatestCommitted(summary);
  const [held, setHeld] = useState<{
    readonly key: string;
    readonly scope: string;
    readonly queue: GuideReadingSaveQueue | undefined;
  }>({ key: requestedKey, scope, queue: undefined });
  // A status refresh must not unregister a dirty queue before navigation can flush it.
  const key =
    summary === undefined && held.scope === scope ? held.key : requestedKey;
  useEffect(() => {
    const summary = latestSummary.current;
    if (summary === undefined) return;
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const initial = await loadProgress({ profileId, reviewId }, summary, {
          signal: controller.signal,
        });
        if (cancelled) return;
        let confirmed: GuideReadingContent = initial;
        const queue = new GuideReadingSaveQueue(
          initial,
          async (content, expectedVersion) => {
            let version = expectedVersion;
            try {
              for (const mutation of mutationsBetween(confirmed, content)) {
                // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each mark is versioned on the previous reply
                const reply = await requestGuideJson(
                  "/v1/reviews/insights/guide/progress",
                  {
                    method: "POST",
                    body: {
                      profileId,
                      reviewId,
                      digest: summary.digest,
                      expectedVersion: version,
                      mutation,
                    },
                  },
                );
                const saved = v.parse(
                  v.strictObject({
                    version: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
                  }),
                  reply,
                );
                version = saved.version;
                confirmed = { ...applyMutation(confirmed, mutation) };
              }
            } catch (cause) {
              if (isApiErrorCode(cause, "stale_result")) return undefined;
              throw cause;
            }
            return v.parse(guideReadingStateSchema, {
              runId: summary.runId,
              sessionId: summary.sessionId,
              version,
              ...content,
            });
          },
          async () => {
            const next = parseGuideSummaryReply(
              await requestGuideJson("/v1/reviews/insights/guide/summary", {
                method: "POST",
                body: { profileId, reviewId },
              }),
            );
            if (next?._tag !== "ready" || next.digest !== summary.digest)
              throw new Error("Guide changed during progress reload");
            const state = await loadProgress({ profileId, reviewId }, next);
            confirmed = state;
            return state;
          },
          () => undefined,
        );
        setHeld({ key, scope, queue });
      } catch {
        if (!cancelled) setHeld({ key, scope, queue: undefined });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, profileId, reviewId, scope, latestSummary]);
  const queue =
    held.key === key && held.scope === scope ? held.queue : undefined;
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
  const edit = useCallback(
    (state: GuideReadingContent) => queue?.edit(state),
    [queue],
  );
  return snapshot === undefined || queue === undefined
    ? undefined
    : { ...snapshot, edit, retry: queue.retry };
}

function applyMutation(
  content: GuideReadingContent,
  mutation: Mutation,
): GuideReadingContent {
  if (mutation.action === "set_anchor")
    return {
      ...content,
      anchor: mutation.anchor,
    };
  if (mutation.action === "set_reviewed")
    return {
      ...content,
      reviewedGroupIds: mutation.value
        ? [...content.reviewedGroupIds, mutation.groupId]
        : content.reviewedGroupIds.filter((id) => id !== mutation.groupId),
    };
  const target = { groupId: mutation.groupId, fileId: mutation.fileId };
  return {
    ...content,
    expandedAppearances: mutation.value
      ? [...content.expandedAppearances, target]
      : content.expandedAppearances.filter(
          (appearance) => appearanceKey(appearance) !== appearanceKey(target),
        ),
  };
}
