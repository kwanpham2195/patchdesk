import { useCallback } from "react";
import * as v from "valibot";

import { isApiErrorCode, requestJson } from "../api-client";
import { agentExplanationListSchema } from "../local-draft-contracts";
import type { WorkbenchResponse } from "../renderer-contracts";
import type {
  ReviewWorkbenchPatch,
  RunDirectCommand,
} from "./use-review-observation";

function dismissFailureMessage(cause: unknown): string {
  if (isApiErrorCode(cause, "in_progress"))
    return "Another action on this review is running. Try again when it finishes.";
  if (isApiErrorCode(cause, "not_applicable"))
    return "The review changed. Press Refresh, then try again.";
  return "The explanation was not dismissed.";
}

/**
 * Dismiss on an Agent explanation (#665): deletes it and adopts the list the
 * main process answers with. It runs as a direct command, so a detection read
 * before it cannot bring the explanation back. Undefined on a pull request
 * Review and once a local Review is merged or closed.
 */
export function useAgentExplanationDismiss({
  workbench,
  runDirectCommand,
  onWorkbenchPatch,
}: {
  readonly workbench: WorkbenchResponse;
  readonly runDirectCommand: RunDirectCommand;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): ((explanationId: string) => Promise<void>) | undefined {
  const profileId = workbench.session.key.profileId;
  const reviewId = workbench.review.id;
  const sessionId = workbench.session.id;
  const dismiss = useCallback(
    async (explanationId: string): Promise<void> => {
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/agent-explanations/dismiss", {
          method: "POST",
          body: { profileId, reviewId, sessionId, explanationId },
        }),
      ).catch((cause: unknown) => {
        throw new Error(dismissFailureMessage(cause));
      });
      const parsed = v.safeParse(agentExplanationListSchema, value);
      if (!parsed.success)
        throw new Error("The explanation was not dismissed.");
      onWorkbenchPatch({ agentExplanations: parsed.output.agentExplanations });
    },
    [onWorkbenchPatch, profileId, reviewId, runDirectCommand, sessionId],
  );
  return workbench.agentExplanations === undefined ||
    workbench.review.status !== "open"
    ? undefined
    : dismiss;
}
