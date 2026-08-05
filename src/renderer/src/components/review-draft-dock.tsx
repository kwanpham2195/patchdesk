import { useState } from "react";

import type { ReviewAnchor, ReviewBatch } from "../../../domain/review-batch";
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
  draftEditingBlocked,
  selectedRepairAnchor,
  actions,
  publication,
  autoOpenPublication = false,
  onAutoOpenPublicationConsumed,
  initialOpen = false,
}: {
  readonly batch: ReviewBatch;
  readonly patch?: string;
  readonly writeBlocked: boolean;
  readonly draftEditingBlocked?: boolean;
  readonly selectedRepairAnchor?: ReviewAnchor;
  readonly actions: ReviewBatchPanelActions;
  readonly publication?: { readonly preview: () => Promise<PublicationPreviewResponse>; readonly confirm: () => Promise<void>; readonly state?: "ready" | "publishing" | "confirmed" | "needs_confirmation"; readonly recover?: () => Promise<void>; readonly openGitHub?: () => Promise<void>; readonly viewFeedback?: () => void; readonly recoveryEvidence?: { readonly confirmed: ReadonlyArray<string>; readonly notConfirmed: ReadonlyArray<string>; readonly unableToVerify: string } };
  readonly autoOpenPublication?: boolean;
  readonly onAutoOpenPublicationConsumed?: () => void;
  readonly initialOpen?: boolean;
}): React.JSX.Element {
  const attentionCount = batch.items.filter((item) => item._tag === "InlineComment" && item.postability === "needs_attention").length;
  const [open, setOpen] = useState(initialOpen);
  return (
    <section className="flex min-h-0 max-h-[min(45vh,32rem)] flex-col border-t bg-background px-4 py-3" aria-label="Review draft dock" data-review-draft-state={open ? "expanded" : "collapsed"}>
      <Collapsible open={open} onOpenChange={setOpen} className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3">
          <button type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)} className="-ml-2 inline-flex min-h-8 items-center gap-2 rounded-lg px-2 text-sm font-semibold outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
            Review draft
            <Badge variant="secondary">{batch.items.filter((item) => item.include).length} included</Badge>
            <Badge variant={attentionCount === 0 ? "outline" : "destructive"}>{attentionCount} needs attention</Badge>
          </button>
          <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">Decision · {batch.suggestedEvent}</span>{publication === undefined ? null : <PublicationPreviewDialog disabled={writeBlocked} {...(publication.state === undefined ? {} : { publicationState: publication.state })} {...(publication.recover === undefined ? {} : { onRecover: publication.recover })} {...(publication.openGitHub === undefined ? {} : { onOpenGitHub: publication.openGitHub })} {...(publication.viewFeedback === undefined ? {} : { onViewFeedback: publication.viewFeedback })} {...(publication.recoveryEvidence === undefined ? {} : { recoveryEvidence: publication.recoveryEvidence })} onPreview={publication.preview} onConfirm={publication.confirm} autoOpen={autoOpenPublication} {...(onAutoOpenPublicationConsumed === undefined ? {} : { onAutoOpenConsumed: onAutoOpenPublicationConsumed })} />}</div>
        </div>
        <CollapsibleContent motion="disclosure" className="min-h-0 flex-1 overflow-y-auto pt-3" data-review-draft-scroll>
          <ReviewBatchPanel batch={batch} {...(patch === undefined ? {} : { patch })} {...(selectedRepairAnchor === undefined ? {} : { selectedRepairAnchor })} writeBlocked={writeBlocked} {...(draftEditingBlocked === undefined ? {} : { draftEditingBlocked })} actions={actions} showDraftControls showWriteActions={publication === undefined} />
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
