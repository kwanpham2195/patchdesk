import { useEffect, useRef, useState } from "react";

import type { DirectSummaryReviewProjection } from "../renderer-contracts";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

const labels = { COMMENT: "Comment", APPROVE: "Approve", REQUEST_CHANGES: "Request changes" } as const;
type Event = keyof typeof labels;

/** A direct GitHub write: it never creates or edits a pending review. */
export function SummaryReviewDialog({
  open,
  busy,
  state,
  receipt,
  error,
  onOpenChange,
  onSubmit,
  onRecover,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly state: DirectSummaryReviewProjection["state"];
  readonly receipt?: Extract<DirectSummaryReviewProjection, { readonly state: "confirmed" }>["receipt"];
  readonly error?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (event: Event, body: string) => Promise<DirectSummaryReviewProjection>;
  readonly onRecover: () => Promise<DirectSummaryReviewProjection>;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  const [event, setEvent] = useState<Event>("COMMENT");
  const [submitting, setSubmitting] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const locked = busy || submitting || recovering;
  useEffect(() => {
    if (!open) return;
    setBody(""); setEvent("COMMENT"); setSubmitting(false); setRecovering(false); setLocalError(undefined);
    window.setTimeout(() => bodyRef.current?.focus(), 0);
  }, [open]);
  const submit = async (): Promise<void> => {
    if (locked || body.trim().length === 0) return;
    setSubmitting(true); setLocalError(undefined);
    try {
      await onSubmit(event, body.trim());
      // Keep the confirmed receipt visible until the maintainer closes it.
    } catch {
      // This UI boundary renders only the bounded error supplied by its action,
      // never an exception message that may contain transport diagnostics.
      setLocalError(error ?? "Patchdesk could not confirm the review. Check GitHub again before trying again.");
    } finally {
      setSubmitting(false);
    }
  };
  const recover = async (): Promise<void> => {
    if (locked) return;
    setRecovering(true); setLocalError(undefined);
    try {
      const result = await onRecover();
      if (result.state === "recovery_required")
        setLocalError("GitHub found more than one matching review. Open GitHub to resolve the outcome before continuing.");
      if (result.state === "confirmed") {
        // Keep the confirmed receipt visible until the maintainer closes it.
      }
    } catch {
      // Recovery is an explicit reconciliation boundary; show safe copy and
      // keep submission locked until GitHub can be checked again.
      setLocalError(error ?? "Patchdesk could not check GitHub. Try again before submitting another review.");
    } finally {
      setRecovering(false);
    }
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!locked) onOpenChange(next); }}>
    <DialogContent className="w-[calc(100vw-2rem)] max-w-xl min-w-0" aria-label="Write review summary">
      <DialogHeader>
        <DialogTitle>Write review summary</DialogTitle>
        <DialogDescription>This publishes an immediate GitHub review. It does not create a pending review.</DialogDescription>
      </DialogHeader>
      {state === "confirmed" ? (
        <div className="space-y-4">
          <p role="status" className="text-sm">Review summary {receipt?.reviewId === undefined ? "" : `#${receipt.reviewId} `}was published to GitHub. Refresh GitHub state to update this Review.</p>
          <div className="flex justify-end"><Button onClick={() => onOpenChange(false)}>Close</Button></div>
        </div>
      ) : state === "recovery_required" ? (
        <div className="space-y-4">
          <p role="alert" className="text-sm text-destructive">Patchdesk could not confirm whether GitHub published this review. Check GitHub again before submitting another review.</p>
          {localError === undefined && error === undefined ? null : <p role="alert" className="text-sm text-destructive">{error ?? localError}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={locked} onClick={() => onOpenChange(false)}>Close</Button>
            <Button disabled={locked} onClick={() => void recover()}>{recovering ? "Checking GitHub…" : "Check GitHub again"}</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium" htmlFor="summary-review-body">Summary</label>
            <Textarea id="summary-review-body" ref={bodyRef} className="mt-1 min-h-28" value={body} onChange={(change) => setBody(change.target.value)} aria-label="Review summary" placeholder="Write the review summary that GitHub will publish" />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <label className="text-sm font-medium" htmlFor="summary-review-decision">Decision</label>
            <Select value={event} onValueChange={(value) => setEvent(value as Event)}>
              <SelectTrigger id="summary-review-decision" aria-label="Review decision" className="w-48 min-w-0"><SelectValue>{(value) => labels[(value ?? "COMMENT") as Event]}</SelectValue></SelectTrigger>
              <SelectContent><SelectItem value="COMMENT">Comment</SelectItem><SelectItem value="APPROVE">Approve</SelectItem><SelectItem value="REQUEST_CHANGES">Request changes</SelectItem></SelectContent>
            </Select>
          </div>
          {localError === undefined && error === undefined ? null : <p role="alert" className="text-sm text-destructive">{error ?? localError}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={locked} onClick={() => onOpenChange(false)}>Close</Button>
            <Button disabled={locked || body.trim().length === 0} onClick={() => void submit()}>{submitting ? "Submitting…" : "Submit review"}</Button>
          </div>
        </div>
      )}
    </DialogContent>
  </Dialog>;
}
