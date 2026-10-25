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
import { InsightRunning } from "./insight-panels";
import type { InsightRunActivity } from "#src/renderer/src/insight-contracts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";

/** Run identity remains cancellable independently of result pages and refresh availability. */
export function InsightActiveRunControls({
  type,
  workbench,
  state,
  run,
  refresh,
  activity,
}: {
  readonly workbench: WorkbenchResponse;
  readonly type: "guide" | "walkthrough";
  readonly state: GuideSummaryState | WalkthroughSummaryState;
  readonly run: GuideRunStatus;
  readonly refresh: () => void;
  readonly activity?: InsightRunActivity | undefined;
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
        : `Refresh ${noun} run status before starting a new generation.`);
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
      activity={activity}
      startedAt={
        workbench.insights[type]?.activeRun?.runId === run.runId
          ? workbench.insights[type]?.activeRun?.startedAt
          : undefined
      }
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
  activity,
  startedAt,
}: {
  readonly type: "guide" | "walkthrough";
  readonly identity: { readonly profileId: string; readonly reviewId: string };
  readonly run: NonNullable<GuideRunStatus>;
  readonly disabledReason?: string;
  readonly cancelDisabledReason?: string;
  readonly onSettled: () => void;
  readonly activity?: InsightRunActivity | undefined;
  readonly startedAt?: string | undefined;
}): React.JSX.Element {
  const controls = useInsightResume(type, identity, run, onSettled);
  const noun = INSIGHT_NOUNS[type];
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const resumeReady = hasResumeEvidence(run);
  if (run.status !== "paused" || controls.cancelling)
    return (
      <InsightRunning
        type={type}
        status={
          controls.cancelling
            ? "cancelling"
            : run.status === "paused"
              ? "cancelling"
              : run.status
        }
        activity={activity}
        startedAt={startedAt}
        onCancel={controls.cancel}
        cancelDisabled={controls.busy || cancelDisabledReason !== undefined}
      >
        {cancelDisabledReason === undefined ? null : (
          <p role="note">{cancelDisabledReason}</p>
        )}
        {controls.failed ? (
          <InlineError>
            The request was refused. The run is unchanged.
          </InlineError>
        ) : null}
      </InsightRunning>
    );
  return (
    <section
      aria-label={`${noun} run`}
      className="mb-3 flex shrink-0 flex-col gap-2 rounded-md border p-3 text-sm"
    >
      <p role="status">
        {noun} · Paused. The previous response is unknown. A new generation
        starts again from the same prepared inputs.
      </p>
      {resumeReady ? null : <p>{resumeSpendDisclosure(run)}</p>}
      <div className="flex gap-2">
        <Button
          size="xs"
          disabled={
            !resumeReady || controls.busy || disabledReason !== undefined
          }
          onClick={() => {
            setAcknowledged(false);
            setConfirming(true);
          }}
        >
          Start new generation
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
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!controls.busy) {
            setConfirming(open);
            setAcknowledged(false);
          }
        }}
      >
        <DialogContent showCloseButton={!controls.busy}>
          <DialogHeader>
            <DialogTitle>Start new {noun} generation</DialogTitle>
            <DialogDescription>{resumeSpendDisclosure(run)}</DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={controls.busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I understand that this starts a new generation from the same
              prepared inputs, may spend again, and does not recover the
              previous response.
            </span>
          </label>
          {disabledReason === undefined ? null : (
            <p role="note">{disabledReason}</p>
          )}
          {controls.failed ? (
            <InlineError>
              The request was refused. The run is unchanged.
            </InlineError>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={controls.busy}
              onClick={() => {
                setConfirming(false);
                setAcknowledged(false);
              }}
            >
              Dismiss
            </Button>
            <Button
              disabled={
                !acknowledged ||
                !resumeReady ||
                controls.busy ||
                disabledReason !== undefined
              }
              onClick={() => {
                controls.resume();
                setConfirming(false);
                setAcknowledged(false);
              }}
            >
              Start new generation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    ? false
    : run.native.lastStartHash !== null &&
        run.native.starts > 0 &&
        run.native.cessationConfirmed;
}

function resumeSpendDisclosure(run: NonNullable<GuideRunStatus>): string {
  if (run.native === undefined && run.dispatches > 0)
    return "API integration removed; choose Codex or Pi CLI for a separately authorized new run. Recorded requests and unknown usage remain retained.";
  if (!hasResumeEvidence(run)) {
    return (run.native?.starts ?? run.dispatches) > 0
      ? "Recorded provider activity may have spent your account allowance. A new generation is unavailable because cleanup or recovery is not confirmed."
      : "No provider requests or native turn starts were recorded. A new generation is unavailable because cleanup or recovery is not confirmed.";
  }
  return "A native turn may have spent your account allowance. Starting a new generation may spend again; it cannot recover the previous response.";
}
