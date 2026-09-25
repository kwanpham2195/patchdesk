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

/** The Change intent of a local Review (#467) and the command that sets or clears it. */
export type ChangeIntentControls = {
  readonly current: NonNullable<WorkbenchResponse["changeIntent"]> | null;
  readonly saving: boolean;
  /** Sets the intent, or clears it with `null`; rejects with the sentence the dialog shows. */
  readonly save: (intent: ChangeIntentInput | null) => Promise<void>;
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
      } catch (cause: unknown) {
        throw new Error(saveFailureMessage(cause));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [onWorkbenchPatch, profileId, reviewId],
  );

  const current = workbench.changeIntent;
  if (current === undefined) return undefined;
  return { current, saving, save };
}
