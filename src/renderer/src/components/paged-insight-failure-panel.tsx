import type { GuideSummaryState } from "#src/renderer/src/hooks/use-guide-summary";
import type { WalkthroughSummaryState } from "#src/renderer/src/hooks/use-walkthrough-summary";
import { INSIGHT_NOUNS } from "./insight-run-dialog";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import { definedProps } from "#src/domain/defined-props";
import { InsightFailed } from "./insight-panels";
import { Alert, AlertDescription } from "./ui/alert";
import { InsightAttemptDetails } from "./insight-attempt-details";
import { Info } from "lucide-react";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

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
  if (summary.run !== null || failure === null) return null;
  if (failure.reason === "cancelled" || failure.reason === "superseded")
    return (
      <PagedInsightInterruption
        type={type}
        summary={summary}
        failure={failure}
        identity={identity}
      />
    );
  return (
    <InsightFailed
      projection={{ status: "failed" }}
      guideFailure={failure}
      onReprepare={onReprepare}
      nativeAttempts={summary.nativeAttempts}
      detailsSource={{ ...identity, type, runId: failure.runId }}
      {...definedProps({
        retainedHeadSha:
          summary._tag === "ready" ? summary.revision.headSha : undefined,
        retainedGeneratedAt:
          summary._tag === "ready" ? summary.generatedAt : undefined,
        onRetry: failure.retryable && runEnabled ? onRetry : undefined,
      })}
    />
  );
}

type LoadedSummary = Extract<
  GuideSummaryState | WalkthroughSummaryState,
  { readonly status: "loaded" }
>["summary"];

/** A cancelled or superseded run is not a failure: it keeps its run details beside the previous result. */
function PagedInsightInterruption({
  type,
  summary,
  failure,
  identity,
}: {
  readonly type: "guide" | "walkthrough";
  readonly summary: LoadedSummary;
  readonly failure: NonNullable<LoadedSummary["failure"]>;
  readonly identity: { readonly profileId: string; readonly reviewId: string };
}): React.JSX.Element {
  const noun = INSIGHT_NOUNS[type];
  const interruptionDetails = (
    <div className="flex min-w-0 flex-col gap-2 text-xs">
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
  );
  if (failure.reason === "cancelled" && summary._tag === "ready")
    return (
      <div className="mb-2 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <p role="status">Replacement cancelled; showing previous result.</p>
        <Popover>
          <PopoverTrigger
            aria-label="Cancelled run details"
            render={<Button size="icon-xs" variant="ghost" />}
          >
            <Info aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent
            aria-label="Cancelled run details"
            align="start"
            className="max-h-96 w-[min(36rem,calc(100vw-2rem))] overflow-y-auto"
          >
            {interruptionDetails}
          </PopoverContent>
        </Popover>
      </div>
    );
  return (
    <Alert>
      <AlertDescription>
        <p>
          {failure.reason === "cancelled"
            ? `The ${noun} run was cancelled.`
            : `The ${noun} run was superseded by a different Review revision.`}
        </p>
        <details className="text-xs">
          <summary className="cursor-pointer">Run details</summary>
          {interruptionDetails}
        </details>
        <p>
          {summary._tag === "ready"
            ? `The previous ${noun} is unchanged.`
            : `No ${noun} was published.`}
        </p>
      </AlertDescription>
    </Alert>
  );
}
