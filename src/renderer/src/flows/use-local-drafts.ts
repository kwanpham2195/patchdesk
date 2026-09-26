import { useCallback, useMemo, useRef, useState } from "react";
import * as v from "valibot";

import { definedProps } from "../../../domain/defined-props";
import { findingDraftStates } from "../../../domain/local-draft";
import { isApiErrorCode, requestJson } from "../api-client";
import type { LocalCommentLocation } from "../components/review-diff-view";
import {
  localDraftListSchema,
  type LocalDraftEntry,
} from "../local-draft-contracts";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { ReviewWorkbenchPatch } from "./use-review-observation";

/** Maintainer notes on a local Review (ADR 0051). Each command rejects with a message its form shows beside the text. */
export type LocalNoteControls = {
  readonly add: (location: LocalCommentLocation, text: string) => Promise<void>;
  readonly edit: (noteId: string, text: string) => Promise<void>;
  readonly remove: (noteId: string) => Promise<void>;
};

/** The Local draft list of one local Review and its commands (ADR 0050, ADR 0051). */
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
  /** Remove from the Local drafts card; a failure shows as `error`. */
  readonly remove: (entry: LocalDraftEntry) => Promise<void>;
  /** The drafts as one prompt for the coding agent, composed by the main process. */
  readonly loadAgentPrompt: () => Promise<string>;
  /** One Finding row's toggle: Add to draft, or Remove once drafted. */
  readonly forFinding: (findingId: string) => {
    readonly drafted: boolean;
    readonly pending: boolean;
    readonly onToggle?: () => void;
  };
  /** Absent once the Review is merged or closed. */
  readonly notes?: LocalNoteControls;
};

/** What a command names beside the Review: a Finding, a note's lines and text, or a note. */
type LocalDraftCommand =
  | { readonly runId: string; readonly findingId: string }
  | (LocalCommentLocation & { readonly text: string })
  | { readonly noteId: string; readonly text?: string };

const agentPromptSchema = v.strictObject({ markdown: v.string() });

/** One draft's identity: its Analysis run and Finding, or its note id. */
export function localDraftKey(
  entry:
    | { readonly analysisRunId: string; readonly findingId: string }
    | { readonly noteId: string },
): string {
  return "noteId" in entry
    ? `note\n${entry.noteId}`
    : `${entry.analysisRunId}\n${entry.findingId}`;
}

function failureMessage(cause: unknown): string {
  if (isApiErrorCode(cause, "in_progress"))
    return "Another action on this review is running. Try again when it finishes.";
  if (isApiErrorCode(cause, "not_applicable"))
    return "The review changed or this finding can no longer be drafted. Press Refresh, then run Analysis on the current files.";
  if (isApiErrorCode(cause, "draft_sensitive"))
    return "This finding's comment contains what looks like a credential, which Patchdesk never stores.";
  return "The draft list was not changed.";
}

function noteFailureMessage(cause: unknown): string {
  if (isApiErrorCode(cause, "in_progress"))
    return "Another action on this review is running. Try again when it finishes.";
  if (isApiErrorCode(cause, "not_applicable"))
    return "The review changed or these lines are not in the current diff. Press Refresh and select them again.";
  if (isApiErrorCode(cause, "not_found"))
    return "This note was removed. Press Refresh.";
  if (isApiErrorCode(cause, "draft_sensitive"))
    return "The note contains what looks like a credential. Remove it and save again.";
  return "The note was not saved.";
}

/**
 * Owns the Local draft list on a local Review. A Finding command names the
 * Finding only, and a note command names its lines and text; the main process
 * reads or fingerprints every anchor. Undefined on a pull request Review,
 * which drafts into GitHub instead.
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
  // Every write names the session on screen; the main process refuses one the Review has moved past (#452).
  const sessionId = workbench.session.id;

  /** Posts one command and applies the list it answers with; throws when it was refused. */
  const post = useCallback(
    async (
      key: string,
      path: string,
      command: LocalDraftCommand,
    ): Promise<void> => {
      if (pendingRef.current.has(key)) return;
      pendingRef.current.add(key);
      setPending(new Set(pendingRef.current));
      try {
        const parsed = v.safeParse(
          localDraftListSchema,
          await requestJson(path, {
            method: "POST",
            body: { profileId, reviewId, sessionId, ...command },
          }),
        );
        if (!parsed.success) throw new Error("Unexpected Local draft response");
        onWorkbenchPatch({ localDrafts: parsed.output.localDrafts });
      } finally {
        pendingRef.current.delete(key);
        setPending(new Set(pendingRef.current));
      }
    },
    [onWorkbenchPatch, profileId, reviewId, sessionId],
  );

  const sendFinding = useCallback(
    async (
      action: "add" | "remove",
      runId: string,
      findingId: string,
    ): Promise<void> => {
      setError(undefined);
      try {
        await post(
          localDraftKey({ analysisRunId: runId, findingId }),
          `/v1/reviews/local-drafts/${action}`,
          { runId, findingId },
        );
      } catch (cause: unknown) {
        setError(failureMessage(cause));
      }
    },
    [post],
  );

  const notes = useMemo<LocalNoteControls>(() => {
    const send = async (
      key: string,
      path: string,
      command: LocalDraftCommand,
    ): Promise<void> => {
      try {
        await post(key, path, command);
      } catch (cause: unknown) {
        throw new Error(noteFailureMessage(cause));
      }
    };
    return {
      add: (location, text) =>
        send("note\nnew", "/v1/reviews/local-drafts/notes/add", {
          ...location,
          text,
        }),
      edit: (noteId, text) =>
        send(localDraftKey({ noteId }), "/v1/reviews/local-drafts/notes/edit", {
          noteId,
          text,
        }),
      remove: (noteId) =>
        send(
          localDraftKey({ noteId }),
          "/v1/reviews/local-drafts/notes/remove",
          { noteId },
        ),
    };
  }, [post]);

  const runId = workbench.insights.analysis.retained?.runId;
  const add = useCallback(
    async (findingId: string): Promise<void> => {
      if (runId !== undefined) await sendFinding("add", runId, findingId);
    },
    [runId, sendFinding],
  );
  const remove = useCallback(
    async (entry: LocalDraftEntry): Promise<void> => {
      if (entry.kind === "finding") {
        await sendFinding("remove", entry.analysisRunId, entry.findingId);
        return;
      }
      setError(undefined);
      await notes.remove(entry.noteId).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : undefined);
      });
    },
    [notes, sendFinding],
  );

  const loadAgentPrompt = useCallback(async (): Promise<string> => {
    const parsed = v.safeParse(
      agentPromptSchema,
      await requestJson("/v1/reviews/local-drafts/agent-prompt", {
        method: "POST",
        body: { profileId, reviewId },
      }),
    );
    if (!parsed.success) throw new Error("Unexpected agent prompt response");
    return parsed.output.markdown;
  }, [profileId, reviewId]);

  const entries = workbench.localDrafts;
  if (entries === undefined) return undefined;
  const reviewOpen = workbench.review.status === "open";
  const canAdd =
    reviewOpen &&
    runId !== undefined &&
    workbench.insights.analysis.status === "current";
  const draftedFindingIds = new Set(findingDraftStates(entries, runId).keys());
  return {
    entries,
    draftedFindingIds,
    canAdd,
    canRemove: reviewOpen,
    pending,
    add,
    remove,
    loadAgentPrompt,
    forFinding: (findingId) => {
      const drafted = draftedFindingIds.has(findingId);
      const allowed = drafted ? reviewOpen : canAdd;
      return {
        drafted,
        pending:
          runId !== undefined &&
          pending.has(localDraftKey({ analysisRunId: runId, findingId })),
        ...definedProps({
          onToggle:
            !allowed || runId === undefined
              ? undefined
              : drafted
                ? () => void sendFinding("remove", runId, findingId)
                : () => void add(findingId),
        }),
      };
    },
    ...definedProps({ error, notes: reviewOpen ? notes : undefined }),
  };
}
