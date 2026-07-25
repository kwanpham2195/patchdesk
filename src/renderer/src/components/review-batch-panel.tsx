import { useState } from "react";

import type { ReviewBatch, ReviewBatchItem } from "../../../domain/review-batch";
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
import { Textarea } from "@/components/ui/textarea";

export type ReviewBatchPanelActions = {
  readonly addInlineComment: (input: {
    readonly path: string;
    readonly startLine: number;
    readonly line: number;
    readonly side: "new" | "old";
    readonly body: string;
  }) => Promise<void>;
  readonly removeItem: (itemId: string) => Promise<void>;
  readonly addThreadReply: (threadId: string, body: string) => Promise<void>;
  readonly setThreadState: (threadId: string, action: "resolve" | "reopen") => Promise<void>;
  readonly apply: () => Promise<void>;
};

export function ReviewBatchPanel({
  batch,
  selectedFinding,
  writeBlocked,
  actions,
}: {
  readonly batch?: ReviewBatch;
  readonly selectedFinding?: ReviewFinding;
  readonly writeBlocked: boolean;
  readonly actions: ReviewBatchPanelActions;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const canAdd = selectedFinding?.mappingStatus === "mapped" && selectedFinding.file !== undefined && selectedFinding.lineStart !== undefined && selectedFinding.lineEnd !== undefined && body.trim().length > 0 && batch?.state._tag === "Local";
  const add = async (): Promise<void> => {
    if (!canAdd || selectedFinding === undefined || selectedFinding.file === undefined || selectedFinding.lineStart === undefined || selectedFinding.lineEnd === undefined) return;
    await actions.addInlineComment({ path: selectedFinding.file, startLine: selectedFinding.lineStart, line: selectedFinding.lineEnd, side: selectedFinding.diffSide ?? "new", body });
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
          <Textarea aria-label="New inline comment" value={body} onChange={(event) => setBody(event.target.value)} placeholder={selectedFinding?.mappingStatus === "mapped" ? "Write a local inline comment" : "Select a mapped finding first"} disabled={batch.state._tag !== "Local" || selectedFinding?.mappingStatus !== "mapped"} />
          <Button size="sm" variant="outline" disabled={!canAdd} onClick={() => void add()}>Add to batch</Button>
        </div>
        <div className="mt-3 border-t pt-3">
          <Button disabled={writeBlocked || batch.state._tag !== "Local"} onClick={() => setConfirmOpen(true)}>Apply review batch</Button>
          {writeBlocked ? <p className="mt-2 text-xs text-muted-foreground">Refresh GitHub state before writing this saved batch.</p> : null}
        </div>
      </>}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply this review batch to GitHub?</AlertDialogTitle>
            <AlertDialogDescription>Patchdesk will use the exact saved batch and create only the included GitHub review actions.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void actions.apply()}>Apply batch</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function BatchItem({ item, editable, onRemove }: { readonly item: ReviewBatchItem; readonly editable: boolean; readonly onRemove: (id: string) => Promise<void> }): React.JSX.Element {
  const detail = item._tag === "InlineComment" ? `${item.anchor.path}:${item.anchor.startLine}–${item.anchor.line}` : item._tag === "ThreadReply" ? `Reply to ${item.threadId}` : `${item.action} ${item.threadId}`;
  const body = item._tag === "InlineComment" || item._tag === "ThreadReply" ? item.body : undefined;
  return <li className="rounded-md border p-2 text-sm"><div className="flex items-start justify-between gap-2"><div><p className="font-medium">{detail}</p>{body === undefined ? null : <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{body}</p>}</div>{editable ? <Button size="xs" variant="ghost" onClick={() => void onRemove(item.id)}>Remove</Button> : null}</div></li>;
}
