import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import type {
  CheckSummary,
  GitHubComments,
  PullRequestSummary,
} from "../../../domain/github-context";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import type { ReviewBatch } from "../../../domain/review-batch";
import type { ReviewFinding } from "../../../domain/review-result";
import { MergeConfirmationDialog, type MergeMethod } from "./merge-confirmation-dialog";
import { PullRequestDescriptionPreview } from "./pull-request-description";
import { ReviewBatchPanel, ReviewBatchWriteActions, type ReviewBatchPanelActions } from "./review-batch-panel";
import { ReviewChecks } from "./review-checks";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

export type PullRequestOverviewMerge = {
  readonly readiness: MergeReadiness;
  readonly context: {
    readonly repo: string;
    readonly prNumber: number;
    readonly title: string;
    readonly base: string;
    readonly head: string;
    readonly headSha: string;
  };
  readonly methods: ReadonlyArray<MergeMethod>;
  readonly onMerge: (
    method: MergeMethod,
    acknowledgedWarnings: boolean,
  ) => Promise<{ readonly mergeCommitSha?: string }>;
};

export type PullRequestOverviewActions = {
  readonly batch?: ReviewBatchPanelActions;
  readonly merge?: PullRequestOverviewMerge;
};

/** Shared read and confirmation surface for prepared and completed snapshots. */
export function PullRequestOverviewSheet({
  open,
  onOpenChange,
  focus,
  pullRequest,
  patch,
  freshness,
  checks,
  comments,
  batch,
  selectedFinding,
  actions,
  noLocalReview = false,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly focus?: "checks";
  readonly pullRequest?: PullRequestSummary;
  readonly patch?: string;
  readonly freshness: "fresh" | "stale" | "unavailable" | "not_refreshed";
  readonly checks: CheckSummary;
  readonly comments: GitHubComments;
  readonly batch?: ReviewBatch;
  readonly selectedFinding?: ReviewFinding;
  readonly actions: PullRequestOverviewActions;
  readonly noLocalReview?: boolean;
}): React.JSX.Element {
  const checksRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || focus !== "checks") return;
    const frame = window.requestAnimationFrame(() => checksRow.current?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [focus, open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[430px] max-w-[100vw] gap-0 sm:max-w-[430px]">
        <SheetHeader className="border-b px-5 py-4 pr-12">
          <SheetTitle>PR overview</SheetTitle>
          {pullRequest === undefined ? null : (
            <p className="truncate text-xs text-muted-foreground">
              {pullRequest.ref.owner}/{pullRequest.ref.repo}#{pullRequest.ref.number} · {pullRequest.baseBranch} ← {pullRequest.headBranch}
            </p>
          )}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
          <OverviewRow title="Description" defaultOpen>
            {pullRequest?.description === undefined || pullRequest.description.trim().length === 0 ? (
              <p className="text-sm text-muted-foreground">No description was provided on GitHub.</p>
            ) : <PullRequestDescriptionPreview markdown={pullRequest.description} pullRequest={pullRequest.ref} />}
          </OverviewRow>
          <Separator />
          <div ref={checksRow}>
            <OverviewRow title="Checks" defaultOpen trailing={overallLabel(checks.overall, freshness)}>
              <ReviewChecks checks={checks} freshness={freshness} showHeader={false} {...(pullRequest === undefined ? {} : { pullRequest: pullRequest.ref })} />
            </OverviewRow>
          </div>
          <Separator />
          <OverviewRow title="Existing threads" trailing={comments.threads.length === 0 ? "None" : String(comments.threads.length)}>
            <ReviewThreads comments={comments} {...(batch === undefined ? {} : { batch })} {...(actions.batch === undefined ? {} : { actions: actions.batch })} />
          </OverviewRow>
          <Separator />
          <OverviewRow title="Your local review" trailing={batch === undefined ? "Unavailable" : `${batch.items.length} draft${batch.items.length === 1 ? "" : "s"}`}>
            {actions.batch === undefined ? <p className="text-sm text-muted-foreground">Local review actions are unavailable for this snapshot.</p> : (
              <ReviewBatchPanel
                {...(batch === undefined ? {} : { batch })}
                {...(patch === undefined ? {} : { patch })}
                {...(selectedFinding === undefined ? {} : { selectedFinding })}
                writeBlocked={freshness !== "fresh"}
                actions={actions.batch}
                showWriteActions={false}
              />
            )}
          </OverviewRow>
        </div>
        <SheetFooter className="border-t px-5 py-4">
          {noLocalReview ? (
            <Alert>
              <AlertTitle>No local Patchdesk review has run for this snapshot.</AlertTitle>
              <AlertDescription>GitHub’s current head and required checks still control write eligibility.</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-3">
            {actions.batch === undefined ? null : <ReviewBatchWriteActions {...(batch === undefined ? {} : { batch })} writeBlocked={freshness !== "fresh"} actions={actions.batch} />}
            {actions.merge === undefined ? null : freshness !== "fresh" ? <p className="text-sm text-muted-foreground">Merge remains unavailable until GitHub confirms the current head.</p> : (
              <MergeConfirmationDialog
                readiness={actions.merge.readiness}
                context={actions.merge.context}
                methods={actions.merge.methods}
                onMerge={actions.merge.onMerge}
              />
            )}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function OverviewRow({
  title,
  defaultOpen = false,
  trailing,
  children,
}: {
  readonly title: string;
  readonly defaultOpen?: boolean;
  readonly trailing?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="py-3">
      <div className="flex items-center justify-between gap-3">
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="-ml-2 px-2" />}>
          {title}
          <ChevronDown data-disclosure-motion="chevron" className={open ? "size-4" : "size-4 -rotate-90"} aria-hidden="true" />
        </CollapsibleTrigger>
        {trailing === undefined ? null : <span className="text-xs text-muted-foreground">{trailing}</span>}
      </div>
      <CollapsibleContent motion="disclosure" className="pt-3 text-sm">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ReviewThreads({
  comments,
  batch,
  actions,
}: {
  readonly comments: GitHubComments;
  readonly batch?: ReviewBatch;
  readonly actions?: ReviewBatchPanelActions;
}): React.JSX.Element {
  if (comments.threads.length === 0) return <p className="text-sm text-muted-foreground">No existing review threads.</p>;
  return <ul className="space-y-3">{comments.threads.map((thread) => (
    <li key={thread.id} className="rounded-md border p-3">
      {thread.state === "outdated" ? <div className="mb-2 flex items-center gap-2"><Badge variant="outline">Outdated</Badge></div> : null}
      <div className="space-y-2">{thread.comments.map((comment) => <div key={comment.id}><p className="font-medium">{comment.author}</p><p className="text-muted-foreground">{comment.body}</p></div>)}</div>
      {actions === undefined || batch?.state._tag !== "Local" ? null : <ThreadBatchActions threadId={thread.id} state={thread.state} actions={actions} />}
    </li>
  ))}</ul>;
}

function ThreadBatchActions({
  threadId,
  state,
  actions,
}: {
  readonly threadId: string;
  readonly state: "open" | "resolved" | "outdated" | "unknown";
  readonly actions: ReviewBatchPanelActions;
}): React.JSX.Element {
  const [body, setBody] = useState("");
  const saveReply = async (): Promise<void> => {
    if (body.trim().length === 0) return;
    await actions.addThreadReply(threadId, body);
    setBody("");
  };
  return <div className="mt-3 border-t pt-3"><Textarea aria-label={`Reply to thread ${threadId}`} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Reply in the local review batch" /><div className="mt-2 flex flex-wrap gap-2"><Button size="xs" variant="outline" disabled={body.trim().length === 0} onClick={() => void saveReply()}>Add reply</Button><Button size="xs" variant="ghost" onClick={() => void actions.setThreadState(threadId, state === "resolved" ? "reopen" : "resolve")}>{state === "resolved" ? "Reopen thread" : "Resolve thread"}</Button></div></div>;
}

function overallLabel(
  overall: CheckSummary["overall"],
  freshness: "fresh" | "stale" | "unavailable" | "not_refreshed",
): string {
  if (freshness === "not_refreshed") return "Not refreshed";
  if (freshness === "unavailable") return "Unavailable";
  return overall === "passing" ? "Passing" : overall === "failing" ? "Failing" : overall === "pending" ? "In progress" : overall === "skipped" ? "Skipped" : "Unknown";
}
