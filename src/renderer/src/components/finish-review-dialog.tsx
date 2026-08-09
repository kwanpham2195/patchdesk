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
  readonly onCheckGitHubAgain: () => Promise<void>;
};

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
      <DialogContent className="max-h-[min(85vh,48rem)] overflow-y-auto" aria-label="Finish review">
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
                <li key={comment.threadId} className="rounded-md border bg-muted/40 p-2">
                  <p className="font-mono text-xs text-muted-foreground">
                    {comment.path}:{comment.startLine}
                    {comment.line === comment.startLine ? "" : `–${comment.line}`} ({comment.side})
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{comment.body}</p>
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
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium" htmlFor="finish-review-decision">Decision</label>
            <Select
              value={event}
              onValueChange={(value) => setEvent(value as "COMMENT" | "APPROVE" | "REQUEST_CHANGES")}
            >
              <SelectTrigger aria-label="Review decision" className="w-44">
                <SelectValue />
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
            <p role="alert" className="text-sm text-destructive">{submitError}</p>
          )}
          {error === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">{error}</p>
          )}
          <div className="flex justify-end gap-2">
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
            <Button variant="outline" size="sm" disabled={locked} onClick={() => onOpenChange(false)}>Close</Button>
            <Button
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={() => void actions.onCheckGitHubAgain()}
            >
              Check GitHub again
            </Button>
            <Button size="sm" disabled={locked || submitting} onClick={() => void submit()}>
              {submitting ? "Submitting…" : "Submit review"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
