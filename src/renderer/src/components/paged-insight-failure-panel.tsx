import type { GuideSummaryState } from "#src/renderer/src/hooks/use-guide-summary";
import type { WalkthroughSummaryState } from "#src/renderer/src/hooks/use-walkthrough-summary";
import { INSIGHT_NOUNS } from "./insight-run-dialog";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import { definedProps } from "#src/domain/defined-props";
import { InsightFailed } from "./insight-panels";
import { Alert, AlertDescription } from "./ui/alert";

/** Terminal status belongs to the last admitted run, independently of the previous published result. */
export function PagedInsightFailurePanel({
  type,
  state,
  runEnabled,
  onRetry,
  onReprepare,
}: {
  readonly type: "guide" | "walkthrough";
  readonly state: GuideSummaryState | WalkthroughSummaryState;
  readonly runEnabled: boolean;
  readonly onRetry: (() => void) | undefined;
  readonly onReprepare: () => Promise<WorkbenchResponse>;
}): React.JSX.Element | null {
  if (state.status !== "loaded") return null;
  const summary = state.summary;
  const failure = summary.failure;
  const noun = INSIGHT_NOUNS[type];
  if (summary.run !== null || failure === null) return null;
  if (failure.reason === "cancelled" || failure.reason === "superseded")
    return (
      <Alert>
        <AlertDescription>
          <p>
            {failure.reason === "cancelled"
              ? `The ${noun} run was cancelled.`
              : `The ${noun} run was superseded by a different Review revision.`}
          </p>
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
      {...definedProps({
        retainedHeadSha:
          summary._tag === "ready" ? summary.revision.headSha : undefined,
        onRetry: failure.retryable && runEnabled ? onRetry : undefined,
      })}
    />
  );
}
