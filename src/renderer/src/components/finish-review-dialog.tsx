import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "./ui/alert";
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
import { refusedWriteMessage } from "../api-client";
import { useReportUnsentReviewText } from "../hooks/use-unsent-review-text";
import type { PendingReviewProjection } from "../renderer-contracts";
import type { GitHubReviewEvent } from "../../../domain/pending-review";

type FinishReviewActions = {
  readonly busy: boolean;
  readonly onSubmit: (
    event: GitHubReviewEvent,
    summaryBody: string,
  ) => Promise<void>;
  readonly onDiscard: () => Promise<void>;
  readonly onCheckGitHubAgain?: () => Promise<void>;
};

/** The Finish review summary and decision a closed dialog keeps until Submit review or Confirm discard. */
export type FinishReviewDraft = {
  readonly summary: string;
  readonly event: GitHubReviewEvent;
};

const DECISION_LABELS = {
  COMMENT: "Comment",
  APPROVE: "Approve",
  REQUEST_CHANGES: "Request changes",
} as const;

function SummaryReplacementPrompt({
  disabled,
  onKeep,
  onReplace,
}: {
  readonly disabled: boolean;
  readonly onKeep: () => void;
  readonly onReplace: () => void;
}): React.JSX.Element {
  return (
    <Alert>
      <AlertDescription>
        You have an unsent summary. Replace it with the Analysis summary?
      </AlertDescription>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={onKeep}
        >
          Keep my summary
        </Button>
        <Button size="sm" disabled={disabled} onClick={onReplace}>
          Replace summary
        </Button>
      </div>
    </Alert>
  );
}

/**
 * GitHub-style Finish review modal. The summary is sent only with Submit and
 * is never written to disk; closing hands it back to the caller to keep in
 * renderer memory. The owner of `actions` closes the dialog once Submit or
 * Discard settles.
 */
function FinishReviewDialogContent({
  open,
  onClose,
  projection,
  actions,
  error,
  draft,
  offeredSummary,
}: {
  readonly open: boolean;
  /** Escape, a click outside, or Close; receives the summary and decision to keep. */
  readonly onClose: (draft: FinishReviewDraft) => void;
  readonly projection: Extract<
    PendingReviewProjection,
    { readonly state: "pending" }
  >;
  readonly actions: FinishReviewActions;
  readonly error?: string;
  /** The summary and decision kept from an earlier close. */
  readonly draft?: FinishReviewDraft;
  /** A generated summary, such as Analysis's; it fills an empty dialog and asks before replacing a kept one. */
  readonly offeredSummary?: string;
}): React.JSX.Element {
  const [summary, setSummary] = useState(
    draft?.summary ?? offeredSummary ?? "",
  );
  const [event, setEvent] = useState<GitHubReviewEvent>(
    draft?.event ?? "COMMENT",
  );
  const [replacementOffered, setReplacementOffered] = useState(
    draft !== undefined &&
      offeredSummary !== undefined &&
      offeredSummary !== draft.summary,
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [discardArmed, setDiscardArmed] = useState(false);
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  useReportUnsentReviewText(open ? summary : "");
  const locked = actions.busy || submitting;

  useEffect(() => {
    if (open) window.setTimeout(() => summaryRef.current?.focus(), 0);
  }, [open]);

  const submit = async (): Promise<void> => {
    if (locked) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      await actions.onSubmit(event, summary);
    } catch (cause) {
      setSubmitError(
        refusedWriteMessage(cause, "submission") ??
          error ??
          "Patchdesk could not finish this review. Check GitHub again or refresh.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Discard is destructive and requires a separate explicit confirmation
  // step inside the modal; it is never a second dialog.
  const discard = async (): Promise<void> => {
    if (locked) return;
    if (!discardArmed) {
      setDiscardArmed(true);
      return;
    }
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      await actions.onDiscard();
    } catch (cause) {
      setSubmitError(
        refusedWriteMessage(cause, "discard") ??
          error ??
          "Patchdesk could not discard this review. Check GitHub again or refresh.",
      );
      setDiscardArmed(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!locked && !next) onClose({ summary, event });
      }}
    >
      <DialogContent className="max-h-[min(85vh,48rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Finish review</DialogTitle>
          <DialogDescription>
            The summary is sent with the review.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {replacementOffered && offeredSummary !== undefined ? (
            <SummaryReplacementPrompt
              disabled={locked}
              onKeep={() => setReplacementOffered(false)}
              onReplace={() => {
                setSummary(offeredSummary);
                setReplacementOffered(false);
              }}
            />
          ) : null}
          <section aria-label="Pending review comments">
            <h3 className="mb-2 text-sm font-medium">
              Pending comments · {projection.count}
            </h3>
            <ul className="flex max-h-56 flex-col gap-2 overflow-y-auto">
              {projection.review.comments.map((comment) => (
                <li
                  key={comment.threadId}
                  className="min-w-0 rounded-md border bg-muted/40 p-2"
                >
                  <p className="min-w-0 break-words font-mono text-xs text-muted-foreground">
                    {comment.path}:{comment.startLine}
                    {comment.line === comment.startLine
                      ? ""
                      : `–${comment.line}`}{" "}
                    ({comment.side})
                  </p>
                  <p className="mt-1 min-w-0 whitespace-pre-wrap break-words text-sm">
                    {comment.body}
                  </p>
                </li>
              ))}
            </ul>
          </section>
          <div>
            <label
              className="text-sm font-medium"
              htmlFor="finish-review-summary"
            >
              Summary (optional)
            </label>
            <Textarea
              id="finish-review-summary"
              ref={summaryRef}
              className="mt-1"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="Summarize your review for the author"
              aria-label="Final review summary"
            />
          </div>
          <div
            className="flex min-w-0 flex-wrap items-center gap-2"
            data-finish-review-decision-row
          >
            <label
              className="text-sm font-medium"
              htmlFor="finish-review-decision"
            >
              Decision
            </label>
            <Select
              value={event}
              items={Object.entries(DECISION_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
              onValueChange={(value) => {
                // SAFETY: The catalog contains only the three review events.
                setEvent(value as GitHubReviewEvent);
              }}
            >
              <SelectTrigger
                id="finish-review-decision"
                aria-label="Review decision"
                className="w-44 min-w-0"
              >
                <SelectValue>
                  {(value) =>
                    DECISION_LABELS[
                      // SAFETY: SelectValue receives a catalogued decision or null.
                      (value ?? "COMMENT") as keyof typeof DECISION_LABELS
                    ]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="COMMENT">Comment</SelectItem>
                  <SelectItem value="APPROVE">Approve</SelectItem>
                  <SelectItem value="REQUEST_CHANGES">
                    Request changes
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {submitError === undefined ? null : (
            <div className="flex flex-col gap-2">
              <Alert variant="destructive">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
              {actions.onCheckGitHubAgain === undefined ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={locked}
                  onClick={() => void actions.onCheckGitHubAgain?.()}
                >
                  Check GitHub again
                </Button>
              )}
            </div>
          )}
          {error === undefined || submitError !== undefined ? null : (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {/* Discard is destructive and stays visually separate from the
              Close/Submit group; both groups wrap independently at narrow
              widths so nothing clips horizontally. */}
          <div
            className="flex flex-wrap items-center justify-between gap-2"
            data-finish-review-actions
          >
            <div
              className="flex flex-wrap items-center gap-2"
              data-finish-review-actions-danger
            >
              {discardArmed ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={locked}
                    onClick={() => setDiscardArmed(false)}
                  >
                    Keep editing
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={locked || submitting}
                    onClick={() => void discard()}
                    data-review-discard-confirm
                  >
                    Confirm discard
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  onClick={() => void discard()}
                  data-review-discard
                >
                  Discard review
                </Button>
              )}
            </div>
            <div
              className="flex flex-wrap items-center gap-2"
              data-finish-review-actions-primary
            >
              <Button
                variant="outline"
                size="sm"
                disabled={locked}
                onClick={() => onClose({ summary, event })}
              >
                Close
              </Button>
              <Button
                size="sm"
                disabled={locked || submitting}
                onClick={() => void submit()}
              >
                {submitting ? "Submitting…" : "Submit review"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Remounts the form on each open, so it starts from the kept draft or offered summary. */
export function FinishReviewDialog(
  props: Parameters<typeof FinishReviewDialogContent>[0],
): React.JSX.Element {
  return <FinishReviewDialogContent key={String(props.open)} {...props} />;
}
