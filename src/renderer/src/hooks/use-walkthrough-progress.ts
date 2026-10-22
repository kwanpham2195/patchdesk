import { useEffect, useRef, useState } from "react";
import * as v from "valibot";
import { isApiErrorCode, requestJson } from "#src/renderer/src/api-client";
import type {
  WalkthroughSummary,
  WalkthroughProgressMutationRequest,
} from "#src/domain/walkthrough-progress";
import { parseWalkthroughSummaryReply } from "#src/renderer/src/walkthrough-contracts";
import { useLatestCommitted } from "./use-latest-committed";
import { definedProps } from "#src/domain/defined-props";

type ReadySummary = Extract<WalkthroughSummary, { _tag: "ready" }>;
type Mutation = WalkthroughProgressMutationRequest["mutation"];
const savedSchema = v.strictObject({
  version: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

/** Only markers in the requested window are held in renderer memory. */
export type WalkthroughProgressControls = {
  readonly progress: {
    readonly reviewedSectionIds: ReadonlyArray<string>;
    readonly currentSectionId: string | null;
    readonly reviewedCount: number;
  };
  readonly saveFailed: boolean;
  readonly toggleSectionReviewed?: (sectionId: string) => void;
  readonly selectSection: (sectionId: string) => void;
};

/** Mounted under the reader's digest key; conflicts refresh the fence before retrying a still-current intent. */
export function useWalkthroughProgress({
  profileId,
  reviewId,
  reviewOpen,
  summary,
  sections,
  onSelectSection,
  onSaved,
}: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly reviewOpen: boolean;
  readonly summary: ReadySummary;
  readonly sections: ReadonlyArray<{
    readonly sectionId: string;
    readonly reviewed: boolean;
  }>;
  readonly onSelectSection: (sectionId: string) => void;
  readonly onSaved: (mutation: Mutation) => void;
}): WalkthroughProgressControls {
  const digest = summary.digest;
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [currentSectionId, setCurrentSectionId] = useState(
    summary.currentSectionId,
  );
  const [saveFailed, setSaveFailed] = useState(false);
  const latest = useLatestCommitted({
    digest,
    sections,
    summary,
    onSaved,
    reviewOpen,
  });
  const queue = useRef<Promise<void> | null>(null);
  const version = useRef({ digest, value: summary.progressVersion });
  const intents = useRef(new Map<string, Mutation>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (version.current.digest === digest)
      version.current.value = Math.max(
        version.current.value,
        summary.progressVersion,
      );
    if (intents.current.size === 0) setOverrides(new Map());
  }, [digest, summary.progressVersion]);

  const save = (mutation: Mutation): void => {
    if (!reviewOpen) return;
    const key =
      mutation.action === "set_current" ? "current" : mutation.sectionId;
    intents.current.set(key, mutation);
    const isCurrent = (): boolean =>
      latest.current.digest === digest &&
      latest.current.reviewOpen &&
      intents.current.get(key) === mutation;
    queue.current = (queue.current ?? Promise.resolve()).then(async () => {
      if (!isCurrent()) return;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const reply = v.safeParse(
              savedSchema,
              await requestJson(
                "/v1/reviews/insights/walkthrough/reading-progress",
                {
                  method: "POST",
                  body: {
                    profileId,
                    reviewId,
                    digest,
                    expectedVersion: version.current.value,
                    mutation,
                  },
                },
              ),
            );
            if (!reply.success)
              throw new Error("Invalid Walkthrough progress reply");
            if (latest.current.digest !== digest) return;
            version.current = { digest, value: reply.output.version };
            if (isCurrent()) intents.current.delete(key);
            if (mounted.current) {
              setSaveFailed(false);
              latest.current.onSaved(mutation);
            }
            return;
          } catch (cause) {
            if (!isApiErrorCode(cause, "version_conflict") || attempt !== 0)
              throw cause;
            const refreshed = parseWalkthroughSummaryReply(
              await requestJson("/v1/reviews/insights/walkthrough/summary", {
                method: "POST",
                body: { profileId, reviewId },
              }),
            );
            if (
              refreshed?._tag !== "ready" ||
              refreshed.digest !== digest ||
              !isCurrent()
            )
              return;
            version.current = { digest, value: refreshed.progressVersion };
          }
        }
      } catch {
        if (isCurrent()) {
          intents.current.delete(key);
          if (mounted.current) setSaveFailed(true);
        }
      }
    });
  };
  const reviewed = (sectionId: string): boolean =>
    overrides.get(sectionId) ??
    sections.find((section) => section.sectionId === sectionId)?.reviewed ??
    false;
  let reviewedCount = summary.reviewedCount;
  for (const section of sections) {
    const value = overrides.get(section.sectionId);
    if (value !== undefined && value !== section.reviewed)
      reviewedCount += value ? 1 : -1;
  }
  const selectSection = (sectionId: string): void => {
    setCurrentSectionId(sectionId);
    onSelectSection(sectionId);
    save({ action: "set_current", sectionId });
  };
  const progress = {
    reviewedSectionIds: sections.flatMap((section) =>
      reviewed(section.sectionId) ? [section.sectionId] : [],
    ),
    currentSectionId,
    reviewedCount,
  };
  return {
    progress,
    saveFailed,
    selectSection,
    ...definedProps({
      toggleSectionReviewed: reviewOpen
        ? (sectionId: string) => {
            const value = !reviewed(sectionId);
            setOverrides((current) =>
              new Map(
                [...current].filter(([id]) =>
                  sections.some((section) => section.sectionId === id),
                ),
              ).set(sectionId, value),
            );
            save({ action: "set_reviewed", sectionId, value });
          }
        : undefined,
    }),
  };
}
