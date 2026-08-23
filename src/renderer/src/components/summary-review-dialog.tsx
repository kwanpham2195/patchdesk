import { useEffect, useRef, useState } from "react";

import type { DirectSummaryReviewProjection } from "../renderer-contracts";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";

const labels = {
  COMMENT: "Comment",
  APPROVE: "Approve",
  REQUEST_CHANGES: "Request changes",
} as const;
type Event = keyof typeof labels;

type ApprovalCapability = "allowed" | "blocked_author" | "unknown";

/** A direct GitHub write: it never creates or edits a pending review. */
function SummaryReviewDialogContent({
  open,
  busy,
  state,
  receipt,
  recoveryResolution,
  approvalCapability = "unknown",
  error,
  onOpenChange,
  onSubmit,
  onRecover,
  onOpenPullRequest,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly state: DirectSummaryReviewProjection["state"];
  readonly receipt?: Extract<
    DirectSummaryReviewProjection,
    { readonly state: "confirmed" }
  >["receipt"];
  readonly recoveryResolution?: Extract<
    DirectSummaryReviewProjection,
    { readonly state: "recovery_required" }
  >["resolution"];
  readonly approvalCapability?: ApprovalCapability;
  readonly error?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (
    event: Event,
    body: string,
  ) => Promise<DirectSummaryReviewProjection>;
  readonly onRecover: () => Promise<DirectSummaryReviewProjection>;
  readonly onOpenPullRequest?: () => void;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  const [event, setEvent] = useState<Event>("COMMENT");
  const [submitting, setSubmitting] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>();
  const [writeAnother, setWriteAnother] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const locked = busy || submitting || recovering;
  const effectiveState = writeAnother ? "idle" : state;
  const recovery =
    state === "recovery_required" && !writeAnother
      ? (recoveryResolution ?? "check_required")
      : undefined;

  useEffect(() => {
    if (open && effectiveState === "idle")
      window.setTimeout(() => bodyRef.current?.focus(), 0);
  }, [effectiveState, open]);

  const submit = async (): Promise<void> => {
    if (
      locked ||
      body.trim().length === 0 ||
      (event === "APPROVE" && approvalCapability === "blocked_author")
    )
      return;
    setSubmitting(true);
    setLocalError(undefined);
    try {
      const result = await onSubmit(event, body.trim());
      if (result.state === "confirmed") setWriteAnother(false);
    } catch {
      setLocalError(
        error ??
          "Patchdesk could not confirm the review. Check GitHub again before trying again.",
      );
    } finally {
      setSubmitting(false);
    }
  };
  const recover = async (): Promise<void> => {
    if (locked) return;
    setRecovering(true);
    setLocalError(undefined);
    try {
      await onRecover();
    } catch {
      setLocalError(
        error ??
          "Patchdesk could not check GitHub. Try again before submitting another review.",
      );
    } finally {
      setRecovering(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!locked) onOpenChange(next);
      }}
    >
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-xl min-w-0"
        aria-label="Write review summary"
      >
        {recovery === undefined ? (
          <DialogHeader>
            <DialogTitle>Write review summary</DialogTitle>
            <DialogDescription>
              This publishes an immediate GitHub review. It does not create a
              pending review.
            </DialogDescription>
          </DialogHeader>
        ) : null}
        {effectiveState === "confirmed" ? (
          <div className="space-y-4">
            <p role="status" className="text-sm">
              Review summary{" "}
              {receipt?.reviewId === undefined ? "" : `#${receipt.reviewId} `}
              was published to GitHub.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  setBody("");
                  setEvent("COMMENT");
                  setLocalError(undefined);
                  setWriteAnother(true);
                }}
              >
                Write another review
              </Button>
            </div>
          </div>
        ) : recovery !== undefined ? (
          <div className="space-y-4 rounded-md border border-amber-500/50 bg-amber-500/10 p-4 text-amber-950 dark:text-amber-100">
            <div className="space-y-1">
              <h2 className="font-semibold">
                Review submission needs confirmation
              </h2>
              <p role="alert" className="text-sm">
                {recovery === "manual_resolution_required"
                  ? "Patchdesk found ambiguous review evidence. Submit is paused until you resolve the outcome on GitHub."
                  : "Patchdesk did not receive confirmation from GitHub. Your review may already have been published. To avoid posting a duplicate review, submission is paused until GitHub is checked."}
              </p>
              <p className="text-sm">
                Checking either confirms the review, restores a safe submit
                state, or identifies manual resolution.
              </p>
            </div>
            {localError === undefined ? null : (
              <p role="alert" className="text-sm">
                {localError}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={locked}
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
              {onOpenPullRequest === undefined ? null : (
                <Button
                  variant="outline"
                  disabled={locked}
                  onClick={onOpenPullRequest}
                >
                  Open pull request on GitHub
                </Button>
              )}
              <Button disabled={locked} onClick={() => void recover()}>
                {recovering ? "Checking GitHub…" : "Check GitHub status"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label
                className="text-sm font-medium"
                htmlFor="summary-review-body"
              >
                Summary
              </label>
              <Textarea
                id="summary-review-body"
                ref={bodyRef}
                className="mt-1 min-h-28"
                value={body}
                onChange={(change) => setBody(change.target.value)}
                aria-label="Review summary"
                placeholder="Write the review summary that GitHub will publish"
              />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <label
                className="text-sm font-medium"
                htmlFor="summary-review-decision"
              >
                Decision
              </label>
              <Select
                value={event}
                items={Object.entries(labels).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onValueChange={(value) => {
                  // SAFETY: The catalog contains only Event keys.
                  setEvent(value as Event);
                }}
              >
                <SelectTrigger
                  id="summary-review-decision"
                  aria-label="Review decision"
                  className="w-48 min-w-0"
                >
                  <SelectValue>
                    {(value) =>
                      labels[
                        // SAFETY: SelectValue receives a catalogued Event or null.
                        (value ?? "COMMENT") as Event
                      ]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="COMMENT">Comment</SelectItem>
                    <SelectItem
                      value="APPROVE"
                      disabled={approvalCapability === "blocked_author"}
                    >
                      Approve
                    </SelectItem>
                    <SelectItem value="REQUEST_CHANGES">
                      Request changes
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              {approvalCapability !== "blocked_author" ? null : (
                <p className="text-sm text-muted-foreground">
                  You can’t approve your own pull request. Choose Comment or ask
                  another reviewer to approve it.
                </p>
              )}
            </div>
            {localError === undefined && error === undefined ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error ?? localError}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={locked}
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
              <Button
                disabled={
                  locked ||
                  body.trim().length === 0 ||
                  (event === "APPROVE" &&
                    approvalCapability === "blocked_author")
                }
                onClick={() => void submit()}
              >
                {submitting ? "Submitting…" : "Submit review"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Remounts ephemeral direct-summary state for each dialog-open lifecycle. */
export function SummaryReviewDialog(
  props: Parameters<typeof SummaryReviewDialogContent>[0],
): React.JSX.Element {
  return (
    <SummaryReviewDialogContent
      key={`${props.open}:${props.receipt?.reviewId ?? ""}:${props.state}`}
      {...props}
    />
  );
}
