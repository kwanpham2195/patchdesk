import type { GuideSummaryState } from "#src/renderer/src/hooks/use-guide-summary";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import { definedProps } from "#src/domain/defined-props";
import { InsightFailed } from "./insight-panels";
import { Alert, AlertDescription } from "./ui/alert";

/** Terminal status belongs to the last admitted run, independently of the previous published Guide. */
export function GuideFailurePanel({
  state,
  runEnabled,
  onRetry,
  onReprepare,
}: {
  readonly state: GuideSummaryState;
  readonly runEnabled: boolean;
  readonly onRetry: (() => void) | undefined;
  readonly onReprepare: () => Promise<WorkbenchResponse>;
}): React.JSX.Element | null {
  if (state.status !== "loaded") return null;
  const summary = state.summary;
  const failure = summary.failure;
  if (summary.run !== null || failure === null) return null;
  if (failure.reason === "cancelled" || failure.reason === "superseded")
    return (
      <Alert>
        <AlertDescription>
          <p>
            {failure.reason === "cancelled"
              ? "The Guide run was cancelled."
              : "The Guide run was superseded by a different Review revision."}
          </p>
          <p>
            {summary._tag === "ready"
              ? "The previous Guide is unchanged."
              : "No Guide was published."}
          </p>
        </AlertDescription>
      </Alert>
    );
  return (
    <InsightFailed
      projection={{ status: "failed" }}
      guideFailure={failure}
      retainedDescription="previous Guide"
      onReprepare={onReprepare}
      {...definedProps({
        retainedHeadSha:
          summary._tag === "ready" ? summary.revision.headSha : undefined,
        onRetry: failure.retryable && runEnabled ? onRetry : undefined,
      })}
    />
  );
}
