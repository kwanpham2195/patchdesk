import { useState } from "react";

import type { GuideRunStatus } from "#src/domain/guide-progress";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import type { GuideSummaryState } from "#src/renderer/src/hooks/use-guide-summary";
import {
  guideCancelDisabledReason,
  guideRunReviewDisabledReason,
} from "./guide-review-controls";
import { definedProps } from "#src/domain/defined-props";
import { useGuideResume } from "#src/renderer/src/hooks/use-guide-resume";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";

/** Run identity remains cancellable independently of result pages and refresh availability. */
export function GuideActiveRunControls({
  workbench,
  state,
  run,
  refresh,
}: {
  readonly workbench: WorkbenchResponse;
  readonly state: GuideSummaryState;
  readonly run: GuideRunStatus;
  readonly refresh: () => void;
}): React.JSX.Element | null {
  if (run === null) return null;
  const current =
    state.status === "loaded" &&
    state.summary.run?.runId === run.runId &&
    state.summary.run.generation === run.generation;
  const cancelDisabledReason = guideCancelDisabledReason(workbench);
  const disabledReason =
    cancelDisabledReason ??
    (run.status !== "paused"
      ? undefined
      : current
        ? guideRunReviewDisabledReason(workbench)
        : "Refresh Guide run status before resuming.");
  return (
    <GuideResumeControls
      key={`${run.runId}:${run.generation}`}
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

/**
 * The current Guide run after reopening: generating, cancelling, or paused with requests whose responses are unknown.
 * A paused run is resumed only after the maintainer acknowledges that a new generation spends again and does not
 * recover those responses; cancelling stays available throughout.
 */
function GuideResumeControls({
  identity,
  run,
  disabledReason,
  cancelDisabledReason,
  onSettled,
}: {
  readonly identity: { readonly profileId: string; readonly reviewId: string };
  readonly run: NonNullable<GuideRunStatus>;
  readonly disabledReason?: string;
  readonly cancelDisabledReason?: string;
  readonly onSettled: () => void;
}): React.JSX.Element {
  const controls = useGuideResume(identity, run, onSettled);
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <section
      aria-label="Guide run"
      className="mb-3 space-y-2 rounded-md border p-3 text-sm"
    >
      {run.status === "paused" ? (
        <>
          <p>
            Generation {run.generation} stopped with {run.dispatches} recorded
            provider request{run.dispatches === 1 ? "" : "s"} whose responses
            are unknown. Nothing was sent again.
          </p>
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
                run.lastRequestHash === null ||
                run.dispatches === 0 ||
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
              ? "The Guide is being prepared."
              : run.status === "cancelling"
                ? "The Guide run is being cancelled."
                : "The Guide is being generated."}
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
