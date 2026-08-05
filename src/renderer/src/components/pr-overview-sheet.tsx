import { useEffect, useRef, useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";

import type {
  CheckSummary,
  GitHubComments,
  MergeDisplayReason,
  PullRequestSummary,
} from "../../../domain/github-context";
import type { PullRequestRef } from "../../../domain/pull-request";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import type { ReviewBatch } from "../../../domain/review-batch";
import type { ReviewFinding } from "../../../domain/review-result";
import type { WorkbenchResponse } from "../renderer-contracts";
import { openPullRequestExternalUrl, pullRequestPageUrl } from "../external-links";
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
  readonly mergeReasons?: ReadonlyArray<MergeDisplayReason>;
  readonly pullRequest?: PullRequestRef;
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

export type CanonicalReviewOverview = {
  readonly repository: string;
  readonly prNumber: number;
  readonly title: string;
  readonly description?: string;
  readonly summary: string;
  readonly checks: {
    readonly overall: string;
    readonly checks: ReadonlyArray<{ readonly name: string; readonly status: string; readonly conclusion?: string }>;
  };
  readonly comments: {
    readonly complete?: boolean;
    readonly threads: ReadonlyArray<{ readonly id: string; readonly state: string; readonly comments: ReadonlyArray<{ readonly author: string; readonly body: string }> }>;
  };
  readonly publishedFeedback: WorkbenchResponse["publishedFeedback"];
  readonly mergeReadiness: { readonly _tag: string; readonly blockers: ReadonlyArray<string>; readonly warnings: ReadonlyArray<string> };
  readonly mergeReasons: ReadonlyArray<MergeDisplayReason>;
  readonly pullRequest?: PullRequestRef;
  readonly revision?: { readonly reviewedHeadSha: string; readonly currentHeadSha?: string; readonly freshness: string; readonly refreshedAt: string };
  readonly analysisStatus?: string;
  readonly walkthroughStatus?: string;
  readonly terminalState?: "merged" | "closed";
};

/** Canonical read-only PR context for the unified Review workbench. */
export function CanonicalReviewOverviewSheet({
  open,
  onOpenChange,
  overview,
  merge,
  onRefresh,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly overview: CanonicalReviewOverview;
  readonly merge?: PullRequestOverviewMerge;
  readonly onRefresh?: () => Promise<void>;
}): React.JSX.Element {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[370px] max-w-[calc(100vw-24px)] gap-0 sm:max-w-[370px]">
        <SheetHeader className="border-b px-5 py-4 pr-12">
          <SheetTitle>PR overview</SheetTitle>
          <p className="truncate text-xs text-muted-foreground">{overview.repository}#{overview.prNumber} · {overview.title}</p>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
          <OverviewRow title="Summary / change context" defaultOpen>
            <p className="whitespace-pre-wrap text-sm">{overview.summary}</p>
          </OverviewRow>
          <Separator />
          <OverviewRow title="Revision and freshness" defaultOpen {...(overview.revision?.freshness === undefined ? {} : { trailing: overview.revision.freshness })}>
            {overview.revision === undefined ? <p className="text-sm text-muted-foreground">Revision details unavailable.</p> : <div className="space-y-2 text-sm"><p>Reviewed head <code className="break-all">{overview.revision.reviewedHeadSha}</code></p>{overview.revision.currentHeadSha === undefined ? null : <p>Current head <code className="break-all">{overview.revision.currentHeadSha}</code></p>}<p className="text-xs text-muted-foreground">Refreshed {overview.revision.refreshedAt}</p>{overview.revision.freshness === "updates_available" || overview.revision.freshness === "not_refreshed" ? <Button size="sm" variant="outline" onClick={() => void onRefresh?.()}>Refresh GitHub state</Button> : null}</div>}
          </OverviewRow>
          <Separator />
          <OverviewRow title="Checks" trailing={overview.checks.overall}>
            <ul className="flex flex-col gap-2 text-sm">{overview.checks.checks.length === 0 ? <li className="text-muted-foreground">No checks reported.</li> : overview.checks.checks.map((check) => <li key={check.name} className="flex items-center justify-between gap-3"><span className="truncate">{check.name}</span><span className="shrink-0 text-xs text-muted-foreground">{check.conclusion ?? check.status}</span></li>)}</ul>
          </OverviewRow>
          <Separator />
          <OverviewRow title="Existing threads" trailing={overview.comments.complete === false ? `${overview.comments.threads.length}+` : String(overview.comments.threads.length)}>
            {overview.comments.threads.length === 0 ? <p className="text-sm text-muted-foreground">No existing review threads.</p> : <ul className="flex flex-col gap-3">{overview.comments.threads.map((thread) => <li key={thread.id} className="rounded-md border p-3"><p className="mb-2 text-xs text-muted-foreground">{thread.state}</p><div className="flex flex-col gap-2">{thread.comments.map((comment) => <div key={`${thread.id}-${comment.author}-${comment.body}`}><p className="font-medium">{comment.author}</p><p className="text-sm text-muted-foreground">{comment.body}</p></div>)}</div></li>)}</ul>}
          </OverviewRow>
          <Separator />
          <OverviewRow title="Published feedback" trailing={overview.publishedFeedback.complete === false ? `${overview.publishedFeedback.reviews.length + overview.publishedFeedback.comments.length}+` : String(overview.publishedFeedback.reviews.length + overview.publishedFeedback.comments.length)}>
            {overview.publishedFeedback.reviews.length === 0 && overview.publishedFeedback.comments.length === 0 ? <p className="text-sm text-muted-foreground">No published GitHub feedback was loaded.</p> : <div className="flex flex-col gap-3">{overview.publishedFeedback.complete === false ? <p className="text-xs text-muted-foreground">This list is incomplete; refresh GitHub state to load more.</p> : null}{overview.publishedFeedback.reviews.map((review) => <article key={review.id} className="rounded-md border p-3"><p className="text-xs font-medium">{review.author} · {review.event}</p><p className="mt-1 whitespace-pre-wrap text-sm">{review.body || "No review body."}</p></article>)}{overview.publishedFeedback.comments.map((comment) => <article key={comment.id} className="rounded-md border p-3"><p className="text-xs font-medium">{comment.author}</p><p className="mt-1 whitespace-pre-wrap text-sm">{comment.body}</p>{comment.location === undefined ? null : <p className="mt-1 text-xs text-muted-foreground">{comment.location.path}:{comment.location.line ?? "?"}</p>}</article>)}</div>}
          </OverviewRow>
          <Separator />
          <OverviewRow title="Analysis and Walkthrough" defaultOpen>
            <div className="space-y-2 text-sm"><p>Analysis · {statusLabel(overview.analysisStatus)}</p><p>Walkthrough · {statusLabel(overview.walkthroughStatus)}</p></div>
          </OverviewRow>
          <Separator />
          <OverviewRow title="Merge readiness" trailing={overview.mergeReadiness._tag}>
            <div className="flex flex-col gap-2 text-sm">{overview.mergeReasons.map((reason) => <p key={reason.code} className="text-destructive"><span>{reason.message}</span><span className="ml-2 text-xs text-muted-foreground">{reasonSourceLabel(reason.source)} · {reason.availability}</span>{reason.openOnGitHub && overview.pullRequest !== undefined ? <Button variant="link" size="sm" className="ml-1 h-auto p-0 align-baseline" onClick={() => void openPullRequestExternalUrl(pullRequestPageUrl(overview.pullRequest as PullRequestRef).toString(), overview.pullRequest)}> <ExternalLink aria-hidden="true" className="size-3" /> Open on GitHub</Button> : null}</p>)}{overview.mergeReasons.length === 0 && overview.mergeReadiness.blockers.length > 0 ? overview.mergeReadiness.blockers.map((blocker) => <p key={`blocker-${blocker}`} className="text-destructive">{readinessBlockerLabel(blocker)}</p>) : null}{overview.mergeReadiness.warnings.map((warning) => <p key={`warning-${warning}`} className="text-muted-foreground">{readinessWarningLabel(warning)}</p>)}{overview.mergeReasons.length === 0 && overview.mergeReadiness.blockers.length === 0 && overview.mergeReadiness.warnings.length === 0 ? <p className="text-muted-foreground">No merge blockers or warnings.</p> : null}</div>
          </OverviewRow>
          {merge === undefined || overview.terminalState !== undefined ? null : <div className="border-t py-4"><MergeConfirmationDialog readiness={merge.readiness} {...(merge.mergeReasons === undefined ? {} : { mergeReasons: merge.mergeReasons })} {...(merge.pullRequest === undefined ? {} : { pullRequest: merge.pullRequest })} context={merge.context} methods={merge.methods} onMerge={merge.onMerge} /></div>}
          <Separator />
          <OverviewRow title="GitHub description" defaultOpen>
            {overview.description?.trim() ? <PullRequestDescriptionPreview markdown={overview.description} /> : <p className="whitespace-pre-wrap text-sm">No description was provided on GitHub.</p>}
          </OverviewRow>
        </div>
        {overview.terminalState === undefined ? null : <SheetFooter className="border-t px-5 py-4"><p className="text-sm text-muted-foreground">This Review is {overview.terminalState} and remains readable.</p></SheetFooter>}
      </SheetContent>
    </Sheet>
  );
}

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
          <OverviewRow title="Existing threads" trailing={threadCountLabel(comments)}>
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
                {...(actions.merge.mergeReasons === undefined ? {} : { mergeReasons: actions.merge.mergeReasons })}
                {...(actions.merge.pullRequest === undefined ? {} : { pullRequest: actions.merge.pullRequest })}
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
        <CollapsibleTrigger className="-ml-2 inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[0.8rem] font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
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
  return <><IncompleteConversationNotice comments={comments} /><ul className="space-y-3">{comments.threads.map((thread) => (
    <li key={thread.id} className="rounded-md border p-3">
      {thread.state === "outdated" ? <div className="mb-2 flex items-center gap-2"><Badge variant="outline">Outdated</Badge></div> : null}
      <div className="space-y-2">{thread.comments.map((comment) => <div key={comment.id}><p className="font-medium">{comment.author}</p><p className="text-muted-foreground">{comment.body}</p></div>)}</div>
      {actions === undefined || batch?.state._tag !== "Local" ? null : <ThreadBatchActions threadId={thread.id} state={thread.state} actions={actions} />}
    </li>
  ))}</ul></>;
}

function threadCountLabel(comments: GitHubComments): string {
  if (comments.threads.length === 0) return "None";
  return comments.complete === false ? `${comments.threads.length}+` : String(comments.threads.length);
}

function IncompleteConversationNotice({ comments }: { readonly comments: GitHubComments }): React.JSX.Element | null {
  return comments.complete === false ? <p className="mb-3 text-sm text-muted-foreground">Some conversation was not loaded.</p> : null;
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

function reasonSourceLabel(source: MergeDisplayReason["source"]): string {
  switch (source) {
    case "github_pr_state": return "GitHub PR state";
    case "branch_protection": return "Branch protection";
    case "ruleset_configuration": return "Ruleset configuration";
    case "checks": return "Checks";
  }
}

function readinessBlockerLabel(blocker: string): string {
  switch (blocker) {
    case "stale_head": return "Refresh this Review before merging.";
    case "closed": return "This pull request is closed.";
    case "draft": return "This pull request is a draft.";
    case "conflicting": return "Resolve merge conflicts.";
    case "merge_blocked": return "GitHub merge requirements are not satisfied.";
    case "mergeability_unknown": return "GitHub merge status is unavailable.";
    case "required_check": return "Required checks have not passed.";
    case "github_review": return "Approval required by GitHub.";
    default: return "GitHub merge requirements are not satisfied.";
  }
}

function readinessWarningLabel(warning: string): string {
  return warning === "request_changes" ? "Changes requested." : warning === "high_severity_finding" ? "High-severity local findings need acknowledgement." : "Merge warning requires acknowledgement.";
}

function statusLabel(status: string | undefined): string {
  return status === undefined ? "Not generated" : status.replaceAll("_", " ");
}

function overallLabel(
  overall: CheckSummary["overall"],
  freshness: "fresh" | "stale" | "unavailable" | "not_refreshed",
): string {
  if (freshness === "not_refreshed") return "Not refreshed";
  if (freshness === "unavailable") return "Unavailable";
  return overall === "passing" ? "Passing" : overall === "failing" ? "Failing" : overall === "pending" ? "In progress" : overall === "skipped" ? "Skipped" : "Unknown";
}
