import { useCallback, useRef, useState } from "react";
import * as v from "valibot";

import { changeIntentViewSchema } from "../../../domain/change-intent";
import { isApiErrorCode, requestJson } from "../api-client";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { ReviewWorkbenchPatch } from "./use-review-observation";

/** What the dialog sends: Markdown text, or a repository-relative spec file path. */
export type ChangeIntentInput =
  | { readonly kind: "text"; readonly markdown: string }
  | { readonly kind: "file"; readonly path: string };

type SavedChangeIntent = NonNullable<WorkbenchResponse["changeIntent"]> | null;

/** What the dialog holds: the chosen tab and both fields, so reopening restores each (#662). */
export type ChangeIntentDraft = {
  readonly kind: ChangeIntentInput["kind"];
  readonly markdown: string;
  readonly path: string;
};

/** The dialog's fields as the saved intent fills them. */
export function changeIntentDraftFromSaved(
  saved: SavedChangeIntent,
): ChangeIntentDraft {
  const intent = saved?.intent;
  return {
    kind: intent?.kind ?? "text",
    markdown: intent?.kind === "text" ? intent.markdown : "",
    path: intent?.kind === "file" ? intent.path : "",
  };
}

/**
 * The draft's active field, trimmed, when it holds text that differs from the
 * saved intent; empty when the draft is clean. Leaving the Review asks while
 * it is not empty (#662).
 */
export function changeIntentUnsentText(
  draft: ChangeIntentDraft,
  saved: SavedChangeIntent,
): string {
  const savedDraft = changeIntentDraftFromSaved(saved);
  const field = draft.kind === "text" ? "markdown" : "path";
  const active = draft[field].trim();
  const savedValue =
    savedDraft.kind === draft.kind ? savedDraft[field].trim() : "";
  return active === savedValue ? "" : active;
}

/** The Change intent of a local Review (#467), the command that sets or clears it, and an edit kept between openings of its dialog (#662). */
export type ChangeIntentControls = {
  readonly current: SavedChangeIntent;
  readonly saving: boolean;
  /** Sets the intent, or clears it with `null`, and drops the kept draft; rejects with the sentence the dialog shows. */
  readonly save: (intent: ChangeIntentInput | null) => Promise<void>;
  /** An unsent edit kept after the dialog closed without Save or Cancel. */
  readonly draft: ChangeIntentDraft | undefined;
  /** Keeps `draft` for the next opening, or drops it when it holds nothing unsent. */
  readonly keepDraft: (draft: ChangeIntentDraft) => void;
  readonly dropDraft: () => void;
};

const changeIntentResponseSchema = v.strictObject({
  changeIntent: v.nullable(changeIntentViewSchema),
});

function saveFailureMessage(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected request is `unknown` by construction; this maps it to one sentence.
  cause: unknown,
): string {
  if (isApiErrorCode(cause, "invalid_input"))
    return "Enter text of at most 64 KiB, or a file path inside the repository such as docs/spec.md.";
  if (isApiErrorCode(cause, "change_intent_sensitive"))
    return "The text contains what looks like a credential. Remove it and save again.";
  if (isApiErrorCode(cause, "in_progress"))
    return "Another action on this review is running. Try again when it finishes.";
  if (isApiErrorCode(cause, "terminal"))
    return "This review is closed, so its change intent cannot change.";
  return "The change intent was not saved.";
}

/**
 * Owns the Change intent of a local Review: one write at a time, and the
 * workbench patched with what the main process stored. Undefined on a pull
 * request Review, which has no Change intent.
 */
export function useChangeIntent({
  workbench,
  onWorkbenchPatch,
}: {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): ChangeIntentControls | undefined {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const profileId = workbench.session.key.profileId;
  const reviewId = workbench.review.id;
  const current = workbench.changeIntent;
  // Renderer memory only, like the Finish review summary (#606): a reload or quit drops it.
  const [keptDraft, setKeptDraft] = useState<
    { readonly reviewId: string; readonly draft: ChangeIntentDraft } | undefined
  >(undefined);
  const draft = keptDraft?.reviewId === reviewId ? keptDraft.draft : undefined;
  const keepDraft = useCallback(
    (next: ChangeIntentDraft): void =>
      setKeptDraft(
        current === undefined || changeIntentUnsentText(next, current) === ""
          ? undefined
          : { reviewId, draft: next },
      ),
    [current, reviewId],
  );
  const dropDraft = useCallback((): void => setKeptDraft(undefined), []);

  const save = useCallback(
    async (intent: ChangeIntentInput | null): Promise<void> => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      try {
        const parsed = v.safeParse(
          changeIntentResponseSchema,
          await requestJson("/v1/reviews/local-intent", {
            method: "POST",
            body: { profileId, reviewId, intent },
          }),
        );
        if (!parsed.success)
          throw new Error("Unexpected change intent response");
        onWorkbenchPatch({ changeIntent: parsed.output.changeIntent });
        setKeptDraft(undefined);
      } catch (cause: unknown) {
        throw new Error(saveFailureMessage(cause));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [onWorkbenchPatch, profileId, reviewId],
  );

  if (current === undefined) return undefined;
  return { current, saving, save, draft, keepDraft, dropDraft };
}
