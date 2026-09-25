import { useCallback, useRef, useState } from "react";
import * as v from "valibot";

import { definedProps } from "../../../domain/defined-props";
import { isApiErrorCode, requestJson } from "../api-client";
import {
  localDraftListSchema,
  type LocalDraftEntry,
} from "../local-draft-contracts";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { ReviewWorkbenchPatch } from "./use-review-observation";

/** The Local draft list of one local Review and its Add to draft and Remove commands (ADR 0050). */
export type LocalDraftControls = {
  readonly entries: ReadonlyArray<LocalDraftEntry>;
  /** Findings of the retained Analysis run that are drafted. */
  readonly draftedFindingIds: ReadonlySet<string>;
  /** Add to draft needs an open Review and a current Analysis; Remove needs only an open Review. */
  readonly canAdd: boolean;
  readonly canRemove: boolean;
  /** Keys from `localDraftKey` with a request in flight. */
  readonly pending: ReadonlySet<string>;
  readonly error?: string;
  readonly add: (findingId: string) => Promise<void>;
  readonly remove: (entry: {
    readonly analysisRunId: string;
    readonly findingId: string;
  }) => Promise<void>;
  /** One Finding row's toggle: Add to draft, or Remove once drafted. */
  readonly forFinding: (findingId: string) => {
    readonly drafted: boolean;
    readonly pending: boolean;
    readonly onToggle?: () => void;
  };
};

/** One draft's identity: its Analysis run and Finding. */
export function localDraftKey(runId: string, findingId: string): string {
  return `${runId}\n${findingId}`;
}

function failureMessage(cause: unknown): string {
  if (isApiErrorCode(cause, "in_progress"))
    return "Another action on this review is running. Try again when it finishes.";
  if (isApiErrorCode(cause, "not_applicable"))
    return "This finding can no longer be drafted. Run Analysis again on the current files.";
  return "The draft list was not changed.";
}

/**
 * Owns the Local draft list on a local Review. Each command names the Finding
 * only; the main process reads its anchor, comment, and suggestion. Undefined
 * on a pull request Review, which drafts into GitHub instead.
 */
export function useLocalDrafts({
  workbench,
  onWorkbenchPatch,
}: {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): LocalDraftControls | undefined {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  const [error, setError] = useState<string | undefined>(undefined);
  const profileId = workbench.session.key.profileId;
  const reviewId = workbench.review.id;

  const send = useCallback(
    async (
      action: "add" | "remove",
      runId: string,
      findingId: string,
    ): Promise<void> => {
      const key = localDraftKey(runId, findingId);
      if (pendingRef.current.has(key)) return;
      pendingRef.current.add(key);
      setPending(new Set(pendingRef.current));
      setError(undefined);
      try {
        const parsed = v.safeParse(
          localDraftListSchema,
          await requestJson(`/v1/reviews/local-drafts/${action}`, {
            method: "POST",
            body: { profileId, reviewId, runId, findingId },
          }),
        );
        if (parsed.success)
          onWorkbenchPatch({ localDrafts: parsed.output.localDrafts });
        else setError("The draft list was not changed.");
      } catch (cause: unknown) {
        setError(failureMessage(cause));
      } finally {
        pendingRef.current.delete(key);
        setPending(new Set(pendingRef.current));
      }
    },
    [onWorkbenchPatch, profileId, reviewId],
  );

  const runId = workbench.insights.analysis.retained?.runId;
  const add = useCallback(
    async (findingId: string): Promise<void> => {
      if (runId !== undefined) await send("add", runId, findingId);
    },
    [runId, send],
  );
  const remove = useCallback(
    (entry: {
      readonly analysisRunId: string;
      readonly findingId: string;
    }): Promise<void> => send("remove", entry.analysisRunId, entry.findingId),
    [send],
  );

  const entries = workbench.localDrafts;
  if (entries === undefined) return undefined;
  const reviewOpen = workbench.review.status === "open";
  const canAdd =
    reviewOpen &&
    runId !== undefined &&
    workbench.insights.analysis.status === "current";
  const draftedFindingIds = new Set(
    entries.flatMap((entry) =>
      entry.analysisRunId === runId ? [entry.findingId] : [],
    ),
  );
  return {
    entries,
    draftedFindingIds,
    canAdd,
    canRemove: reviewOpen,
    pending,
    add,
    remove,
    forFinding: (findingId) => {
      const drafted = draftedFindingIds.has(findingId);
      const allowed = drafted ? reviewOpen : canAdd;
      return {
        drafted,
        pending:
          runId !== undefined && pending.has(localDraftKey(runId, findingId)),
        ...definedProps({
          onToggle:
            !allowed || runId === undefined
              ? undefined
              : drafted
                ? () => void remove({ analysisRunId: runId, findingId })
                : () => void add(findingId),
        }),
      };
    },
    ...definedProps({ error }),
  };
}
