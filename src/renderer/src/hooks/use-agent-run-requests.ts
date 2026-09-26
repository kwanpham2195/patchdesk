import { useCallback, useState } from "react";
import * as v from "valibot";

import { definedProps } from "../../../domain/defined-props";
import { agentRunRequestSchema } from "../../../domain/agent-run-request";
import { requestJson, untrustedWriteResponseError } from "../api-client";
import type { AgentRunRequestView } from "../agent-run-requests";
import type { ReviewWorkbenchPatch } from "../flows/use-review-observation";
import { useLatestCommitted } from "./use-latest-committed";

const declinedResponseSchema = v.strictObject({
  request: agentRunRequestSchema,
});

export type AgentRunRequestsControls = {
  /** The session's requests still awaiting the maintainer, in the order they arrived. */
  readonly awaiting: ReadonlyArray<AgentRunRequestView>;
  /** The request a Decline is in flight for. */
  readonly declining?: string;
  /** The request whose last Decline failed. */
  readonly declineFailed?: string;
  readonly decline: (requestId: string) => void;
};

/**
 * Owns Decline on the Agent requests bar (ADR 0052): one write at a time, and
 * the declined request patched into the workbench from the main process's
 * answer so the bar drops it.
 */
export function useAgentRunRequests({
  profileId,
  reviewId,
  requests,
  onWorkbenchPatch,
}: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly requests: ReadonlyArray<AgentRunRequestView> | undefined;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): AgentRunRequestsControls {
  const [declining, setDeclining] = useState<string>();
  const [declineFailed, setDeclineFailed] = useState<string>();
  const requestsRef = useLatestCommitted(requests);
  const patchRef = useLatestCommitted(onWorkbenchPatch);
  const decline = useCallback(
    (requestId: string): void => {
      if (declining !== undefined) return;
      setDeclining(requestId);
      setDeclineFailed(undefined);
      void requestJson("/v1/reviews/insights/agent-requests/decline", {
        method: "POST",
        body: { profileId, reviewId, requestId },
      })
        .then((value) => {
          const parsed = v.safeParse(declinedResponseSchema, value);
          if (!parsed.success || parsed.output.request.requestId !== requestId)
            throw untrustedWriteResponseError("invalid-declined-request");
          const declined = parsed.output.request;
          patchRef.current({
            agentRunRequests: (requestsRef.current ?? []).map((request) =>
              request.requestId === requestId ? declined : request,
            ),
          });
        })
        .catch(() => setDeclineFailed(requestId))
        .finally(() => setDeclining(undefined));
    },
    [declining, patchRef, profileId, requestsRef, reviewId],
  );
  return {
    awaiting: (requests ?? []).filter(
      (request) => request.status === "awaiting_approval",
    ),
    ...definedProps({ declining, declineFailed }),
    decline,
  };
}
