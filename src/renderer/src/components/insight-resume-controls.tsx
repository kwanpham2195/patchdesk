import { useState } from "react";

import type { GuideRunStatus } from "#src/domain/guide-progress";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import type { GuideSummaryState } from "#src/renderer/src/hooks/use-guide-summary";
import type { WalkthroughSummaryState } from "#src/renderer/src/hooks/use-walkthrough-summary";
import { INSIGHT_NOUNS } from "./insight-run-dialog";
import {
  guideCancelDisabledReason,
  guideRunReviewDisabledReason,
} from "./guide-review-controls";
import { definedProps } from "#src/domain/defined-props";
import { useInsightResume } from "#src/renderer/src/hooks/use-insight-resume";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";

/** Run identity remains cancellable independently of result pages and refresh availability. */
export function InsightActiveRunControls({
  type,
  workbench,
  state,
  run,
  refresh,
}: {
  readonly workbench: WorkbenchResponse;
  readonly type: "guide" | "walkthrough";
  readonly state: GuideSummaryState | WalkthroughSummaryState;
  readonly run: GuideRunStatus;
  readonly refresh: () => void;
}): React.JSX.Element | null {
  if (run === null) return null;
  const current =
    state.status === "loaded" &&
    state.summary.run?.runId === run.runId &&
    state.summary.run.generation === run.generation;
  const noun = INSIGHT_NOUNS[type];
  const cancelDisabledReason = guideCancelDisabledReason(workbench, noun);
  const disabledReason =
    cancelDisabledReason ??
    (run.status !== "paused"
      ? undefined
      : current
        ? guideRunReviewDisabledReason(workbench, noun)
        : `Refresh ${noun} run status before resuming.`);
  return (
    <InsightResumeControls
      key={`${type}:${run.runId}:${run.generation}`}
      type={type}
      identity={{
        profileId: workbench.session.key.profileId,
        reviewId: workbench.review.id,
      }}
      run={run}
      onSettled={refresh}
      {...definedProps({
        cancelDisabledReason,
        disabledReason,
      })}
    />
  );
}

/** Resume requires acknowledgment of unknown responses and possible repeat spend. */
function InsightResumeControls({
  type,
  identity,
  run,
  disabledReason,
  cancelDisabledReason,
  onSettled,
}: {
  readonly type: "guide" | "walkthrough";
  readonly identity: { readonly profileId: string; readonly reviewId: string };
  readonly run: NonNullable<GuideRunStatus>;
  readonly disabledReason?: string;
  readonly cancelDisabledReason?: string;
  readonly onSettled: () => void;
}): React.JSX.Element {
  const controls = useInsightResume(type, identity, run, onSettled);
  const noun = INSIGHT_NOUNS[type];
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <section
      aria-label={`${noun} run`}
      className="mb-3 space-y-2 rounded-md border p-3 text-sm"
    >
      {run.status === "paused" ? (
        <>
          <p>{resumeSpendDisclosure(run)}</p>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I understand that resuming starts a new generation from the same
              prepared inputs, may spend again, and does not recover those
              responses.
            </span>
          </label>
          <div className="flex gap-2">
            <Button
              size="xs"
              disabled={
                !acknowledged ||
                !hasResumeEvidence(run) ||
                controls.busy ||
                disabledReason !== undefined
              }
              onClick={controls.resume}
            >
              Resume as a new generation
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={controls.busy || cancelDisabledReason !== undefined}
              onClick={controls.cancel}
            >
              Cancel run
            </Button>
          </div>
        </>
      ) : (
        <>
          <p role="status">
            {run.status === "queued"
              ? `The ${noun} is being prepared.`
              : run.status === "cancelling"
                ? `The ${noun} run is being cancelled.`
                : `The ${noun} is being generated.`}
          </p>
          {run.status === "cancelling" ? null : (
            <Button
              size="xs"
              variant="outline"
              disabled={controls.busy || cancelDisabledReason !== undefined}
              onClick={controls.cancel}
            >
              Cancel run
            </Button>
          )}
        </>
      )}
      {disabledReason === undefined ? null : (
        <p role="note" className="text-xs text-muted-foreground">
          {disabledReason}
        </p>
      )}
      {controls.failed ? (
        <InlineError>
          The request was refused. The run is unchanged.
        </InlineError>
      ) : null}
    </section>
  );
}

function hasResumeEvidence(run: NonNullable<GuideRunStatus>): boolean {
  return run.native === undefined
    ? run.lastRequestHash !== null && run.dispatches > 0
    : run.native.lastStartHash !== null &&
        run.native.starts > 0 &&
        run.native.cessationConfirmed;
}

function resumeSpendDisclosure(run: NonNullable<GuideRunStatus>): string {
  return run.native === undefined
    ? `Generation ${run.generation} stopped with ${run.dispatches} recorded provider request${run.dispatches === 1 ? "" : "s"} whose responses are unknown. Nothing was sent again.`
    : "A native turn may have spent your account allowance. Resume starts a new generation and may spend again; it cannot recover the previous response.";
}
