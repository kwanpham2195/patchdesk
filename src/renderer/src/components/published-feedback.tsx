import { useState } from "react";

import type { WorkbenchResponse } from "../renderer-contracts";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Textarea } from "./ui/textarea";

type PublishedFeedback = WorkbenchResponse["publishedFeedback"];
type Comment = PublishedFeedback["comments"][number];
type Review = PublishedFeedback["reviews"][number];

export type PublishedFeedbackActions = {
  readonly editComment: (commentId: string, body: string) => Promise<void>;
  readonly deleteComment: (commentId: string) => Promise<void>;
  readonly dismissReview: (reviewId: string, message: string) => Promise<void>;
};

export function PublishedFeedbackPanel({
  feedback,
  freshness,
  actions,
}: {
  readonly feedback: PublishedFeedback;
  readonly freshness: WorkbenchResponse["revision"]["freshness"];
  readonly actions: PublishedFeedbackActions;
}): React.JSX.Element | null {
  const [editing, setEditing] = useState<Comment>();
  const [editBody, setEditBody] = useState("");
  const [deleting, setDeleting] = useState<Comment>();
  const [dismissing, setDismissing] = useState<Review>();
  const [dismissMessage, setDismissMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const disabled = freshness !== "fresh";
  const count = feedback.reviews.length + feedback.comments.length;
  if (count === 0) return null;
  const run = async (operation: () => Promise<void>, close: () => void): Promise<void> => {
    setBusy(true);
    setError(false);
    try { await operation(); close(); } catch { setError(true); } finally { setBusy(false); }
  };
  return (
    <section className="border-t px-4 py-4" aria-label="Published feedback">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div><h2 className="font-semibold">Published feedback</h2><p className="text-xs text-muted-foreground">Remote GitHub reviews and inline comments.</p></div>
        <Badge variant="secondary">{count}</Badge>
      </div>
      {feedback.complete === false ? <p className="mb-3 text-xs text-muted-foreground">Showing a partial result. Refresh GitHub state to load more feedback.</p> : null}
      {error ? <p role="alert" className="mb-3 text-xs text-destructive">The Published feedback action failed. Refresh GitHub state and try again.</p> : null}
      <div className="flex flex-col gap-3">
        {feedback.reviews.map((review) => <article key={review.id} className="rounded-md border p-3"><div className="flex items-center justify-between gap-2"><p className="text-xs font-medium">{review.author} · {review.event}</p>{review.canDismiss ? <Button size="xs" variant="outline" disabled={disabled || busy} onClick={() => { setDismissing(review); setDismissMessage(""); }}>Dismiss</Button> : null}</div><p className="mt-2 whitespace-pre-wrap text-sm">{review.body || "No review body."}</p><p className="mt-2 text-[11px] text-muted-foreground">{review.submittedAt}</p></article>)}
        {feedback.comments.map((comment) => <article key={comment.id} className="rounded-md border p-3"><p className="text-xs font-medium">{comment.author} · {comment.createdAt}</p><p className="mt-2 whitespace-pre-wrap text-sm">{comment.body}</p>{comment.location === undefined ? null : <p className="mt-2 text-[11px] text-muted-foreground">{comment.location.path}:{comment.location.line ?? "?"}</p>}<div className="mt-3 flex gap-2">{comment.canEdit ? <Button size="xs" variant="outline" disabled={disabled || busy} onClick={() => { setEditing(comment); setEditBody(comment.body); }}>Edit</Button> : null}{comment.canDelete ? <Button size="xs" variant="outline" disabled={disabled || busy} onClick={() => setDeleting(comment)}>Delete</Button> : null}</div></article>)}
      </div>
      <Dialog open={editing !== undefined} onOpenChange={(open) => { if (!open) setEditing(undefined); }}>
        <DialogContent><DialogHeader><DialogTitle>Edit published comment</DialogTitle></DialogHeader><Textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} aria-label="Published comment body" /><DialogFooter><Button variant="outline" onClick={() => setEditing(undefined)}>Cancel</Button><Button disabled={busy || editBody.trim().length === 0} onClick={() => { if (editing !== undefined) void run(() => actions.editComment(editing.id, editBody), () => setEditing(undefined)); }}>Save</Button></DialogFooter></DialogContent>
      </Dialog>
      <AlertDialog open={deleting !== undefined} onOpenChange={(open) => { if (!open) setDeleting(undefined); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete published comment?</AlertDialogTitle><AlertDialogDescription>This removes the comment from GitHub and cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { if (deleting !== undefined) void run(() => actions.deleteComment(deleting.id), () => setDeleting(undefined)); }}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <Dialog open={dismissing !== undefined} onOpenChange={(open) => { if (!open) setDismissing(undefined); }}>
        <DialogContent><DialogHeader><DialogTitle>Dismiss published review</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">GitHub requires a non-empty dismissal message.</p><Textarea value={dismissMessage} onChange={(event) => setDismissMessage(event.target.value)} aria-label="Dismissal message" /><DialogFooter><Button variant="outline" onClick={() => setDismissing(undefined)}>Cancel</Button><Button disabled={busy || dismissMessage.trim().length === 0} onClick={() => { if (dismissing !== undefined) void run(() => actions.dismissReview(dismissing.id, dismissMessage), () => setDismissing(undefined)); }}>Dismiss</Button></DialogFooter></DialogContent>
      </Dialog>
    </section>
  );
}
