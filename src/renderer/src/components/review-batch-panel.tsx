import { useState } from "react";

import type { GitHubReviewEvent, ReviewBatch, ReviewBatchItem } from "../../../domain/review-batch";
import type { ReviewAnchorFingerprint } from "../../../domain/review-batch";
import { parseRepoRelativePath } from "../../../domain/ids";
import { fingerprintPatchAnchor } from "../../../domain/review-anchor";
import type { ReviewFinding } from "../../../domain/review-result";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type ReviewBatchPanelActions = {
  readonly addInlineComment: (input: {
    readonly path: string;
    readonly startLine: number;
    readonly line: number;
    readonly side: "new" | "old";
    readonly fingerprint?: ReviewAnchorFingerprint;
    readonly body: string;
  }) => Promise<void>;
  readonly removeItem: (itemId: string) => Promise<void>;
  readonly addThreadReply: (threadId: string, body: string) => Promise<void>;
  readonly setThreadState: (threadId: string, action: "resolve" | "reopen") => Promise<void>;
  readonly apply: () => Promise<void>;
  readonly submit: (event: GitHubReviewEvent) => Promise<void>;
};

export function ReviewBatchPanel({
  batch,
  patch,
  selectedFinding,
  writeBlocked,
  actions,
  showWriteActions = true,
  defaultApplyOpen = false,
}: {
  readonly batch?: ReviewBatch;
  readonly patch?: string;
  readonly selectedFinding?: ReviewFinding;
  readonly writeBlocked: boolean;
  readonly actions: ReviewBatchPanelActions;
  /** Overview sheets keep confirmation-gated GitHub actions in their fixed footer. */
  readonly showWriteActions?: boolean;
  /** Design scenarios can show the confirmation state without performing a write. */
  readonly defaultApplyOpen?: boolean;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  const canAdd = !writeBlocked && selectedFinding?.mappingStatus === "mapped" && selectedFinding.file !== undefined && selectedFinding.lineStart !== undefined && selectedFinding.lineEnd !== undefined && body.trim().length > 0 && batch?.state._tag === "Local";
  const add = async (): Promise<void> => {
    if (!canAdd || selectedFinding === undefined || selectedFinding.file === undefined || selectedFinding.lineStart === undefined || selectedFinding.lineEnd === undefined) return;
    const side = selectedFinding.diffSide ?? "new";
    const anchor = { path: selectedFinding.file, startLine: selectedFinding.lineStart, line: selectedFinding.lineEnd, side };
    const parsedPath = parseRepoRelativePath(anchor.path);
    const fingerprint = patch === undefined || parsedPath._tag === "err"
      ? undefined
      : fingerprintPatchAnchor(patch, { ...anchor, path: parsedPath.value });
    await actions.addInlineComment({
      ...anchor,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      body,
    });
    setBody("");
  };
  return (
    <section aria-label="Review batch">
      <h2 className="font-semibold">Review batch</h2>
      <p className="mt-1 text-xs text-muted-foreground">Review comments stay local until you explicitly confirm the GitHub write.</p>
      {batch === undefined ? <p className="mt-3 text-sm text-muted-foreground">This saved review predates review batches. Re-run it to create a current local batch.</p> : <>
        <p className="mt-3 text-sm">{batch.items.length} planned {batch.items.length === 1 ? "action" : "actions"} · {batch.state._tag.replaceAll(/([A-Z])/g, " $1").trim()}</p>
        <ul className="mt-2 space-y-2">
          {batch.items.map((item) => <BatchItem key={item.id} item={item} editable={batch.state._tag === "Local"} onRemove={actions.removeItem} />)}
        </ul>
        <div className="mt-3 space-y-2 border-t pt-3">
          <p className="text-sm font-medium">Add inline comment</p>
          <p className="text-xs text-muted-foreground">Select a mapped finding to use its exact diff range.</p>
          <Textarea aria-label="New inline comment" value={body} onChange={(event) => setBody(event.target.value)} placeholder={writeBlocked ? "Refresh GitHub state before adding a comment" : selectedFinding?.mappingStatus === "mapped" ? "Write a local inline comment" : "Select a mapped finding first"} disabled={writeBlocked || batch.state._tag !== "Local" || selectedFinding?.mappingStatus !== "mapped"} />
          <Button size="sm" variant="outline" disabled={!canAdd} onClick={() => void add()}>Add to batch</Button>
        </div>
        {showWriteActions ? <ReviewBatchWriteActions batch={batch} writeBlocked={writeBlocked} actions={actions} defaultApplyOpen={defaultApplyOpen} /> : null}
      </>}
    </section>
  );
}

/** The only component that can turn a local batch into a GitHub review. */
export function ReviewBatchWriteActions({
  batch,
  writeBlocked,
  actions,
  defaultApplyOpen = false,
}: {
  readonly batch?: ReviewBatch;
  readonly writeBlocked: boolean;
  readonly actions: Pick<ReviewBatchPanelActions, "apply" | "submit">;
  readonly defaultApplyOpen?: boolean;
}): React.JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(defaultApplyOpen);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitAcknowledged, setSubmitAcknowledged] = useState(false);
  const [event, setEvent] = useState<GitHubReviewEvent>(batch?.suggestedEvent ?? "COMMENT");
  const apply = async (): Promise<void> => {
    await actions.apply();
    setConfirmOpen(false);
  };
  if (batch === undefined) return <p className="text-sm text-muted-foreground">A current review batch is required before creating a GitHub review.</p>;
  return <>
    {batch.state._tag === "Local" ? (
      <div className="space-y-2">
        <Button disabled={writeBlocked} onClick={() => setConfirmOpen(true)}>Create pending review</Button>
        {writeBlocked ? <p className="text-xs text-muted-foreground">Refresh GitHub state before writing this saved batch.</p> : null}
      </div>
    ) : null}
    {batch.state._tag === "PendingReview" ? (
      <div className="space-y-2">
        <p className="text-sm text-primary">Pending review {batch.state.reviewId} created.</p>
        <Button disabled={writeBlocked} onClick={() => setSubmitOpen(true)}>Submit pending review</Button>
      </div>
    ) : null}
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply this review batch to GitHub?</AlertDialogTitle>
            <AlertDialogDescription>Patchdesk will use the exact saved batch and create only the included GitHub review actions.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void apply()}>Create pending review</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={submitOpen} onOpenChange={setSubmitOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit pending review</AlertDialogTitle>
            <AlertDialogDescription>Patchdesk will submit the existing pending review with this saved batch summary.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="review-event">Review event
              <Select value={event} onValueChange={(value) => setEvent(value as GitHubReviewEvent)}>
                <SelectTrigger id="review-event"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="COMMENT">COMMENT</SelectItem>
                  <SelectItem value="APPROVE">APPROVE</SelectItem>
                  <SelectItem value="REQUEST_CHANGES">REQUEST_CHANGES</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={submitAcknowledged} onChange={(input) => setSubmitAcknowledged(input.target.checked)} />I understand this submits the pending review.</label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={!submitAcknowledged} onClick={() => void actions.submit(event)}>Submit review</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
  </>;
}

function BatchItem({ item, editable, onRemove }: { readonly item: ReviewBatchItem; readonly editable: boolean; readonly onRemove: (id: string) => Promise<void> }): React.JSX.Element {
  const detail = item._tag === "InlineComment" ? `${item.anchor.path}:${item.anchor.startLine}–${item.anchor.line}` : item._tag === "ThreadReply" ? `Reply to ${item.threadId}` : `${item.action} ${item.threadId}`;
  const body = item._tag === "InlineComment" || item._tag === "ThreadReply" ? item.body : undefined;
  return <li className="rounded-md border p-2 text-sm"><div className="flex items-start justify-between gap-2"><div><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{detail}</p>{item._tag === "InlineComment" && item.postability === "stale_sha" ? <Badge variant="outline">Old location</Badge> : null}</div>{body === undefined ? null : <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{body}</p>}</div>{editable ? <Button size="xs" variant="ghost" onClick={() => void onRemove(item.id)}>Remove</Button> : null}</div></li>;
}
