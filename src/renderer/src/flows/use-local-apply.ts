import { useCallback, useRef, useState } from "react";
import * as v from "valibot";

import { definedProps } from "../../../domain/defined-props";
import { PatchdeskApiError, requestJson } from "../api-client";
import {
  parseWorkbenchResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";

type LocalApplyLock = "outcome_unknown" | "check_required";

/** What one session's Apply flow remembers; a new session starts it afresh. */
type SessionApplyState = {
  readonly sessionId: string;
  readonly selected: ReadonlySet<string>;
  readonly refusal: string | undefined;
  readonly notice: string | undefined;
  /** `settled` is a check that cleared the lock the projection still reports. */
  readonly lock: LocalApplyLock | "settled" | undefined;
};

type SessionApplyUpdate = Partial<Omit<SessionApplyState, "sessionId">>;

function freshSessionState(sessionId: string): SessionApplyState {
  return {
    sessionId,
    selected: new Set(),
    refusal: undefined,
    notice: undefined,
    lock: undefined,
  };
}

/** Selection, the Apply write, and the file check for one working-tree Review's Analysis. */
export type LocalApplyControls = {
  readonly selectedIds: ReadonlySet<string>;
  readonly setSelected: (findingId: string, selected: boolean) => void;
  readonly apply: () => Promise<void>;
  readonly check: () => Promise<void>;
  readonly pending: boolean;
  /** The session no longer matches the checkout, so Apply stays disabled. */
  readonly blocked: boolean;
  /** Why the last Apply was refused, shown beside the control. */
  readonly refusal?: string;
  readonly notice?: string;
  /** An earlier Apply whose outcome is not settled; Apply waits for a check. */
  readonly lock?: LocalApplyLock;
};

const REVISION_CHANGED_MESSAGE =
  "The working tree changed after this Analysis ran. Press Refresh, then run Analysis on the current files.";

/** The sentence for each reason the Apply route refuses with. */
function refusalFor(reason: string): string | undefined {
  switch (reason) {
    case "revision_changed":
    case "not_fresh":
      return REVISION_CHANGED_MESSAGE;
    case "stale":
      return "This Analysis no longer matches the review. Press Refresh.";
    case "overlapping":
      return "Two selected suggestions change the same lines. Select only one of them.";
    case "not_applicable":
      return "A selected finding has no suggestion that can be applied.";
    case "file_changed":
      return "A file no longer holds the lines a suggestion replaces. Press Refresh.";
    case "working_tree_conversion":
      return "Git would convert line endings or run a filter on a changed file. Apply this change in your editor.";
    case "check_failed":
      return "git apply refused the change. Nothing was written.";
    case "path_refused":
      return "A file is outside the checkout or behind a symlink. Nothing was written.";
    case "apply_locked":
      return "An earlier Apply is not settled. Check the files first.";
    case "in_progress":
      return "Another action on this review is running. Try again when it finishes.";
    case "checkout_unavailable":
      return "Patchdesk could not read the local checkout.";
    case "not_working_tree":
      return "Apply works only on a working-tree review.";
    default:
      return undefined;
  }
}

// A projection that fails validation reads as absent, so the caller falls back to a notice.
const nextWorkbenchSchema = v.optional(
  v.pipe(v.unknown(), v.transform(parseWorkbenchResponse)),
);
const errorBodySchema = v.object({ error: v.string() });
const applyResponseSchema = v.variant("status", [
  v.object({
    status: v.literal("applied"),
    workbench: nextWorkbenchSchema,
  }),
  v.object({ status: v.literal("outcome_unknown") }),
]);
const recoverResponseSchema = v.object({
  decision: v.picklist(["none", "confirmed", "not_applied", "check_required"]),
  workbench: nextWorkbenchSchema,
});

function refusalMessage(cause: unknown): string {
  const body =
    cause instanceof PatchdeskApiError
      ? v.safeParse(errorBodySchema, cause.responseBody)
      : undefined;
  return (
    (body?.success === true ? refusalFor(body.output.error) : undefined) ??
    "The suggestions were not applied."
  );
}

/**
 * Owns the Apply suggestion flow on a working-tree local Review (ADR 0050).
 * The request names Findings only; the main process derives every change.
 * Undefined for any other Review, and while the Analysis is not current.
 */
export function useLocalApply({
  workbench,
  onWorkbenchReplace,
}: {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
}): LocalApplyControls | undefined {
  const sessionId = workbench.session.id;
  // Selection, messages, and a settled lock belong to the session they were made on.
  const [state, setState] = useState<SessionApplyState>(() =>
    freshSessionState(sessionId),
  );
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const current =
    state.sessionId === sessionId ? state : freshSessionState(sessionId);
  const lock =
    current.lock === "settled"
      ? undefined
      : (current.lock ?? workbench.localApply?.state);
  const retained = workbench.insights.analysis.retained;
  const patchHash = workbench.revision.patchHash;

  const run = useCallback(
    async (action: () => Promise<SessionApplyUpdate>): Promise<void> => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      try {
        const next = await action();
        setState((previous) => ({
          ...(previous.sessionId === sessionId
            ? previous
            : freshSessionState(sessionId)),
          refusal: undefined,
          notice: undefined,
          ...next,
        }));
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [sessionId],
  );

  const replaceWith = useCallback(
    (next: WorkbenchResponse | undefined): boolean => {
      if (next === undefined) return false;
      onWorkbenchReplace(next);
      return true;
    },
    [onWorkbenchReplace],
  );

  const apply = useCallback(
    () =>
      run(async () => {
        if (retained === undefined || patchHash === undefined)
          return { refusal: "The suggestions were not applied." };
        try {
          const response = v.safeParse(
            applyResponseSchema,
            await requestJson("/v1/reviews/local-apply", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                reviewId: workbench.review.id,
                runId: retained.runId,
                findingIds: [...current.selected],
                expected: {
                  sessionId,
                  headSha: workbench.session.key.headSha,
                  patchHash,
                },
              },
            }),
          );
          if (!response.success) return { lock: "outcome_unknown" };
          if (response.output.status === "outcome_unknown")
            return { lock: "outcome_unknown" };
          return replaceWith(response.output.workbench)
            ? {}
            : {
                selected: new Set<string>(),
                notice: "Applied. Press Refresh to read the changed files.",
              };
        } catch (cause: unknown) {
          return { refusal: refusalMessage(cause) };
        }
      }),
    [
      current.selected,
      patchHash,
      replaceWith,
      retained,
      run,
      sessionId,
      workbench.review.id,
      workbench.session.key.headSha,
      workbench.session.key.profileId,
    ],
  );

  const check = useCallback(
    () =>
      run(async () => {
        try {
          const response = v.safeParse(
            recoverResponseSchema,
            await requestJson("/v1/reviews/local-apply/recover", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                reviewId: workbench.review.id,
              },
            }),
          );
          if (!response.success)
            return { refusal: "Patchdesk could not check the files." };
          switch (response.output.decision) {
            case "check_required":
              return {
                lock: "check_required",
                refusal:
                  "The files match neither the original nor the applied content. Restore or finish the change by hand, then check again.",
              };
            case "confirmed":
              return replaceWith(response.output.workbench)
                ? {}
                : {
                    lock: "settled",
                    notice:
                      "The suggestions were applied. Press Refresh to read the changed files.",
                  };
            case "not_applied":
              return {
                lock: "settled",
                notice: "Nothing was applied. Apply is available again.",
              };
            case "none":
              return { lock: "settled" };
          }
        } catch (cause: unknown) {
          return { refusal: refusalMessage(cause) };
        }
      }),
    [replaceWith, run, workbench.review.id, workbench.session.key.profileId],
  );

  const setSelected = useCallback(
    (findingId: string, selected: boolean) =>
      setState((previous) => {
        const base =
          previous.sessionId === sessionId
            ? previous
            : freshSessionState(sessionId);
        const next = new Set(base.selected);
        if (selected) next.add(findingId);
        else next.delete(findingId);
        return { ...base, selected: next, refusal: undefined };
      }),
    [sessionId],
  );

  if (
    workbench.session.key.source.kind !== "working_tree" ||
    workbench.review.status !== "open" ||
    workbench.insights.analysis.status !== "current" ||
    retained === undefined
  )
    return undefined;
  // A refused Apply marked the Review RevisionChanged; only Refresh reads the checkout again.
  const blocked = workbench.revision.freshness !== "fresh";
  return {
    selectedIds: current.selected,
    setSelected,
    apply,
    check,
    pending,
    blocked,
    ...definedProps({
      refusal:
        current.refusal ?? (blocked ? REVISION_CHANGED_MESSAGE : undefined),
      notice: current.notice,
      lock,
    }),
  };
}
