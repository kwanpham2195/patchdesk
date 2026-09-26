import {
  displayClientName,
  type AgentRunRequestView,
} from "../agent-run-requests";
import type { ReviewWorkbenchPatch } from "../flows/use-review-observation";
import { useAgentRunRequests } from "../hooks/use-agent-run-requests";
import type { WorkbenchResponse } from "../renderer-contracts";
import { INSIGHT_NOUNS } from "./insight-run-dialog";
import { RelativeTime } from "./relative-time";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";
import { Spinner } from "./ui/spinner";

/**
 * The coding agent's Insight run requests awaiting the maintainer on a local
 * Review (ADR 0052 "Per-run approval in the app"). Run opens the ordinary run
 * dialog for the request; Decline is final for the session. Renders nothing
 * while no request awaits.
 */
export function AgentRequestsBar({
  workbench,
  onWorkbenchPatch,
  profileLabel,
  runBlockedReason,
  onRun,
}: {
  readonly workbench: Pick<
    WorkbenchResponse,
    "session" | "review" | "agentRunRequests"
  >;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
  /** Set when more than one workspace profile is configured (ADR 0052 "Profile switch"). */
  readonly profileLabel?: string;
  /** Why Run cannot start the request's type now; undefined when it can. */
  readonly runBlockedReason: (
    type: AgentRunRequestView["type"],
  ) => string | undefined;
  readonly onRun: (request: AgentRunRequestView) => void;
}): React.JSX.Element | null {
  const controls = useAgentRunRequests({
    profileId: workbench.session.key.profileId,
    reviewId: workbench.review.id,
    requests: workbench.agentRunRequests,
    onWorkbenchPatch,
  });
  if (controls.awaiting.length === 0) return null;
  return (
    <section
      aria-label="Agent requests"
      className="flex shrink-0 flex-col gap-1.5 rounded-lg border bg-muted/30 p-2"
    >
      <h3 className="text-xs font-medium text-muted-foreground">
        {profileLabel === undefined
          ? "Agent requests"
          : `Agent requests · ${profileLabel} profile`}
      </h3>
      <ul className="flex flex-col gap-1.5">
        {controls.awaiting.map((request) => {
          const blocked = runBlockedReason(request.type);
          const declining = controls.declining === request.requestId;
          return (
            <li
              key={request.requestId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">
                  {INSIGHT_NOUNS[request.type]}
                </span>
                <span className="text-muted-foreground">
                  {` · ${displayClientName(request.clientName)} · `}
                  <RelativeTime iso={request.requestedAt} prefix="asked " />
                </span>
              </span>
              {blocked === undefined ? null : (
                <span className="text-xs text-muted-foreground">{blocked}</span>
              )}
              <span className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  disabled={blocked !== undefined || declining}
                  onClick={() => onRun(request)}
                  aria-label={`Run ${INSIGHT_NOUNS[request.type]}`}
                >
                  Run
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={controls.declining !== undefined}
                  onClick={() => controls.decline(request.requestId)}
                  aria-label={`Decline ${INSIGHT_NOUNS[request.type]}`}
                >
                  {declining ? (
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                  ) : null}
                  {declining ? "Declining…" : "Decline"}
                </Button>
              </span>
              {controls.declineFailed === request.requestId ? (
                <InlineError className="basis-full">
                  Decline failed. Try again.
                </InlineError>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
