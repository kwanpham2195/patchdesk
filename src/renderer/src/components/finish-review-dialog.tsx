import { useEffect, useRef, useState } from "react";

import { Badge } from "./ui/badge";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";
import type { PendingReviewProjection } from "../renderer-contracts";

export type FinishReviewActions = {
  readonly busy: boolean;
  readonly onSubmit: (
    event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
    summaryBody: string,
  ) => Promise<void>;
  readonly onDiscard: () => Promise<void>;
  readonly onCheckGitHubAgain?: () => Promise<void>;
};

const DECISION_LABELS = {
  COMMENT: "Comment",
  APPROVE: "Approve",
  REQUEST_CHANGES: "Request changes",
} as const;

/**
 * GitHub-style Finish review modal. The final summary is modal-local: it is
 * sent only with Submit and is never persisted as a second local summary.
 * Discard is not offered: its GitHub semantics are unproven.
 */
export function FinishReviewDialog({
  open,
  onOpenChange,
  projection,
  actions,
  error,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projection: Extract<PendingReviewProjection, { readonly state: "pending" }>;
  readonly actions: FinishReviewActions;
  readonly error?: string;
}): React.JSX.Element {
  const [summary, setSummary] = useState("");
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [discardArmed, setDiscardArmed] = useState(false);
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const locked = actions.busy || submitting;

  // The summary is ephemeral: it belongs to this modal instance only and is
  // never seeded from or written back into the durable projection.
  useEffect(() => {
    if (open) {
      setSummary("");
      setEvent("COMMENT");
      setSubmitting(false);
      setSubmitError(undefined);
      setDiscardArmed(false);
      // Focus the summary input when the modal opens (initial focus behavior).
      window.setTimeout(() => summaryRef.current?.focus(), 0);
    }
  }, [open]);

  const submit = async (): Promise<void> => {
    if (locked) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      await actions.onSubmit(event, summary);
      onOpenChange(false);
    } catch {
      setSubmitError(error ?? "Patchdesk could not finish this review. Check GitHub again or refresh.");
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
      onOpenChange(false);
    } catch {
      setSubmitError(error ?? "Patchdesk could not discard this review. Check GitHub again or refresh.");
      setSubmitting(false);
      setDiscardArmed(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!locked) onOpenChange(next); }}>
      <DialogContent className="max-h-[min(85vh,48rem)] overflow-y-auto sm:max-w-xl" aria-label="Finish review">
        <DialogHeader>
          <DialogTitle>Finish review</DialogTitle>
          <DialogDescription>
            Submit your pending review comments to GitHub. The summary below is sent only when you submit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <section aria-label="Pending review comments">
            <h3 className="mb-2 text-sm font-medium">Pending comments · {projection.count}</h3>
            <ul className="max-h-56 space-y-2 overflow-y-auto">
              {projection.review.comments.map((comment) => (
                <li key={comment.threadId} className="min-w-0 rounded-md border bg-muted/40 p-2">
                  <p className="min-w-0 break-words font-mono text-xs text-muted-foreground">
                    {comment.path}:{comment.startLine}
                    {comment.line === comment.startLine ? "" : `–${comment.line}`} ({comment.side})
                  </p>
                  <p className="mt-1 min-w-0 whitespace-pre-wrap break-words text-sm">{comment.body}</p>
                </li>
              ))}
            </ul>
          </section>
          <div>
            <label className="text-sm font-medium" htmlFor="finish-review-summary">Summary (optional)</label>
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
          <div className="flex min-w-0 flex-wrap items-center gap-2" data-finish-review-decision-row>
            <label className="text-sm font-medium" htmlFor="finish-review-decision">Decision</label>
            <Select
              value={event}
              onValueChange={(value) => setEvent(value as "COMMENT" | "APPROVE" | "REQUEST_CHANGES")}
            >
              <SelectTrigger id="finish-review-decision" aria-label="Review decision" className="w-44 min-w-0">
                <SelectValue>
                  {(value) => DECISION_LABELS[(value ?? "COMMENT") as keyof typeof DECISION_LABELS]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="COMMENT">Comment</SelectItem>
                <SelectItem value="APPROVE">Approve</SelectItem>
                <SelectItem value="REQUEST_CHANGES">Request changes</SelectItem>
              </SelectContent>
            </Select>
            <Badge variant="outline" data-finish-review-count>{projection.count} pending</Badge>
          </div>
          {submitError === undefined ? null : (
            <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{submitError}</p>{actions.onCheckGitHubAgain === undefined ? null : <Button variant="outline" size="sm" disabled={locked} onClick={() => void actions.onCheckGitHubAgain?.()}>Check GitHub again</Button>}</div>
          )}
          {error === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">{error}</p>
          )}
          {/* Discard is destructive and stays visually separate from the
              Close/Submit group; both groups wrap independently at narrow
              widths so nothing clips horizontally. */}
          <div className="flex flex-wrap items-center justify-between gap-2" data-finish-review-actions>
            <div className="flex flex-wrap items-center gap-2" data-finish-review-actions-danger>
              {discardArmed ? (
                <>
                  <Button variant="outline" size="sm" disabled={locked} onClick={() => setDiscardArmed(false)}>Keep editing</Button>
                  <Button variant="destructive" size="sm" disabled={locked || submitting} onClick={() => void discard()} data-review-discard-confirm>
                    Confirm discard
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" disabled={locked} onClick={() => void discard()} data-review-discard>
                  Discard review
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2" data-finish-review-actions-primary>
              <Button variant="outline" size="sm" disabled={locked} onClick={() => onOpenChange(false)}>Close</Button>
              <Button size="sm" disabled={locked || submitting} onClick={() => void submit()}>
                {submitting ? "Submitting…" : "Submit review"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
