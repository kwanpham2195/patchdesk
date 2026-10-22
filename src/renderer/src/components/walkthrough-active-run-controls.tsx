import { useState } from "react";
import { requestJson } from "#src/renderer/src/api-client";
import type { WalkthroughSummary } from "#src/domain/walkthrough-progress";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";

/** Reopened runs are controlled by the summary's identity, not a legacy active-run record. */
export function WalkthroughActiveRunControls({
  run,
  profileId,
  reviewId,
  reviewOpen,
  refresh,
}: {
  readonly run: WalkthroughSummary["run"];
  readonly profileId: string;
  readonly reviewId: string;
  readonly reviewOpen: boolean;
  readonly refresh: () => void;
}): React.JSX.Element | null {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  if (run === null) return null;
  const cancel = async (): Promise<void> => {
    setPending(true);
    setFailed(false);
    try {
      await requestJson("/v1/reviews/insights/walkthrough/cancel", {
        method: "POST",
        body: { profileId, reviewId, type: "walkthrough", runId: run.runId },
      });
      refresh();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <p role="status">
        {run.status === "paused"
          ? "Walkthrough is paused. The provider request outcome is unknown; explicit Resume is required before generation can continue."
          : run.status === "queued"
            ? "Walkthrough is preparing."
            : run.status === "cancelling"
              ? "Walkthrough is cancelling."
              : "Walkthrough is running."}
      </p>
      {reviewOpen ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void cancel()}
          disabled={pending || run.status === "cancelling"}
        >
          Cancel Walkthrough
        </Button>
      ) : null}
      {failed ? (
        <InlineError>
          Walkthrough cancel failed; the run is unchanged. Try again.
        </InlineError>
      ) : null}
    </div>
  );
}
