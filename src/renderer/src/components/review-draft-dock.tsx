import { useState } from "react";

import type { ReviewBatch } from "../../../domain/review-batch";
import type { PublicationPreviewResponse } from "../renderer-contracts";
import { PublicationPreviewDialog } from "./publication-preview-dialog";
import type { ReviewBatchPanelActions } from "./review-batch-panel";
import { ReviewBatchPanel } from "./review-batch-panel";
import { Badge } from "./ui/badge";
import { Collapsible, CollapsibleContent } from "./ui/collapsible";

export function ReviewDraftDock({
  batch,
  patch,
  writeBlocked,
  actions,
  publication,
}: {
  readonly batch: ReviewBatch;
  readonly patch?: string;
  readonly writeBlocked: boolean;
  readonly actions: ReviewBatchPanelActions;
  readonly publication?: { readonly preview: () => Promise<PublicationPreviewResponse>; readonly confirm: () => Promise<void> };
}): React.JSX.Element {
  const attentionCount = batch.items.filter((item) => item._tag === "InlineComment" && item.include && item.postability === "needs_attention").length;
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t bg-background px-4 py-3" aria-label="Review draft dock">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center justify-between gap-3">
          <button type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)} className="-ml-2 inline-flex min-h-8 items-center gap-2 rounded-lg px-2 text-sm font-semibold outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
            Review draft
            <Badge variant="secondary">{batch.items.filter((item) => item.include).length} included</Badge>
            <Badge variant={attentionCount === 0 ? "outline" : "destructive"}>{attentionCount} needs attention</Badge>
          </button>
          <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">Decision · {batch.suggestedEvent}</span>{publication === undefined ? null : <PublicationPreviewDialog disabled={writeBlocked} onPreview={publication.preview} onConfirm={publication.confirm} />}</div>
        </div>
        <CollapsibleContent motion="disclosure" className="pt-3">
          <ReviewBatchPanel batch={batch} {...(patch === undefined ? {} : { patch })} writeBlocked={writeBlocked} actions={actions} showDraftControls showWriteActions={publication === undefined} />
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
