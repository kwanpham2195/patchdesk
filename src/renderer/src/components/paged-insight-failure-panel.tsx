import type { GuideSummaryState } from "#src/renderer/src/hooks/use-guide-summary";
import type { WalkthroughSummaryState } from "#src/renderer/src/hooks/use-walkthrough-summary";
import { INSIGHT_NOUNS } from "./insight-run-dialog";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import { definedProps } from "#src/domain/defined-props";
import { InsightFailed } from "./insight-panels";
import { Alert, AlertDescription } from "./ui/alert";
import { InsightAttemptDetails } from "./insight-attempt-details";

/** Terminal status belongs to the last admitted run, independently of the previous published result. */
export function PagedInsightFailurePanel({
  type,
  state,
  runEnabled,
  onRetry,
  onReprepare,
  identity,
}: {
  readonly type: "guide" | "walkthrough";
  readonly state: GuideSummaryState | WalkthroughSummaryState;
  readonly runEnabled: boolean;
  readonly onRetry: (() => void) | undefined;
  readonly onReprepare: () => Promise<WorkbenchResponse>;
  readonly identity: { readonly profileId: string; readonly reviewId: string };
}): React.JSX.Element | null {
  if (state.status !== "loaded") return null;
  const summary = state.summary;
  const failure = summary.failure;
  const noun = INSIGHT_NOUNS[type];
  if (summary.run !== null || failure === null) return null;
  const interruptionDetails = (
    <details className="text-xs">
      <summary className="cursor-pointer">Details</summary>
      <div className="flex min-w-0 flex-col gap-2 pt-2">
        <p>
          Run: {failure.runId} · Outcome: {failure.reason}. This does not
          establish whether native history is complete.
        </p>
        {summary._tag === "ready" ? (
          <p>Published revision: {summary.revision.headSha}</p>
        ) : null}
        <InsightAttemptDetails
          key={failure.runId}
          page={summary.nativeAttempts}
          source={{ ...identity, type, runId: failure.runId }}
        />
      </div>
    </details>
  );
  if (failure.reason === "cancelled" && summary._tag === "ready")
    return (
      <div className="mb-3 flex shrink-0 flex-col gap-2">
        <p
          role="status"
          className="mb-3 shrink-0 text-sm text-muted-foreground"
        >
          Replacement cancelled; showing previous result
        </p>
        {interruptionDetails}
      </div>
    );
  if (failure.reason === "cancelled" || failure.reason === "superseded")
    return (
      <Alert>
        <AlertDescription>
          <p>
            {failure.reason === "cancelled"
              ? `The ${noun} run was cancelled.`
              : `The ${noun} run was superseded by a different Review revision.`}
          </p>
          {interruptionDetails}
          <p>
            {summary._tag === "ready"
              ? `The previous ${noun} is unchanged.`
              : `No ${noun} was published.`}
          </p>
        </AlertDescription>
      </Alert>
    );
  return (
    <InsightFailed
      projection={{ status: "failed" }}
      guideFailure={failure}
      retainedDescription={`previous ${noun}`}
      onReprepare={onReprepare}
      nativeAttempts={summary.nativeAttempts}
      detailsSource={{ ...identity, type, runId: failure.runId }}
      {...definedProps({
        retainedHeadSha:
          summary._tag === "ready" ? summary.revision.headSha : undefined,
        onRetry: failure.retryable && runEnabled ? onRetry : undefined,
      })}
    />
  );
}
