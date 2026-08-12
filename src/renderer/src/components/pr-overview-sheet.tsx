import { useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpen, CheckCircle2, ChevronDown, GitMerge, RefreshCw, Sparkles, XCircle } from "lucide-react";

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
import { CompactMergeCommand, type MergeMethod } from "./compact-merge-command";
import { PullRequestDescriptionPreview } from "./pull-request-description";
import { ReviewBatchPanel, ReviewBatchWriteActions, type ReviewBatchPanelActions } from "./review-batch-panel";
import { ReviewChecks, presentOverallCheckResult } from "./review-checks";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

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
    warningCodes: ReadonlyArray<string>,
  ) => Promise<{ readonly mergeCommitSha?: string }>;
};

export type PullRequestOverviewActions = {
  readonly batch?: ReviewBatchPanelActions;
  readonly merge?: PullRequestOverviewMerge;
};

export type ReviewInsightStatus =
  | "not_generated"
  | "running"
  | "current"
  | "outdated"
  | "failed";

export type ReviewInsightState = {
  readonly status: ReviewInsightStatus;
};

export type CanonicalReviewOverview = {
  readonly repository: string;
  readonly prNumber: number;
  readonly title: string;
  readonly description?: string;
  readonly summary: string;
  readonly checks: CheckSummary;
  readonly mergeReadiness: WorkbenchResponse["mergeReadiness"];
  readonly mergeReasons: ReadonlyArray<MergeDisplayReason>;
  readonly pullRequest?: PullRequestRef;
  readonly revision?: {
    readonly baseBranch?: string;
    readonly headBranch?: string;
    readonly reviewedHeadSha: string;
    readonly currentHeadSha?: string;
    readonly freshness:
      | "fresh"
      | "updates_available"
      | "unavailable"
      | "not_refreshed";
    readonly refreshedAt: string;
    readonly commitCount?: number;
    readonly fileCount?: number;
  };
  readonly insights: {
    readonly analysis: ReviewInsightState;
    readonly walkthrough: ReviewInsightState;
  };
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
  const terminal = overview.terminalState !== undefined;
  const checks = presentOverallCheckResult(
    overview.checks.overall,
    overview.revision?.freshness,
  );
  const freshness = overview.revision?.freshness;
  const checkFreshness = checksFreshness(freshness);
  const CheckIcon = checks.Icon;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[370px] max-w-[calc(100vw-24px)] gap-0 sm:max-w-[370px]">
        <SheetHeader className="border-b px-5 py-4 pr-12">
          <SheetTitle>PR overview</SheetTitle>
          <p className="truncate text-xs text-muted-foreground">{overview.repository}#{overview.prNumber} · {overview.title}</p>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2" data-pr-overview-scroll>
          <OverviewRow
            title="Revision"
            defaultOpen
            trailing={revisionFreshnessLabel(freshness)}
            trailingTone={revisionFreshnessTone(freshness)}
          >
            <RevisionDetails overview={overview} terminal={terminal} {...(onRefresh === undefined ? {} : { onRefresh })} />
          </OverviewRow>
          <Separator />
          <OverviewRow
            title="Checks"
            icon={<CheckIcon className="size-3.5" />}
            trailing={checks.label}
            trailingTone={checks.treatment}
          >
            <ReviewChecks
              checks={overview.checks}
              {...(checkFreshness === undefined ? {} : { freshness: checkFreshness })}
              showHeader={false}
              {...(overview.pullRequest === undefined ? {} : { pullRequest: overview.pullRequest })}
            />
          </OverviewRow>
          <Separator />
          <OverviewRow title="Review status" defaultOpen>
            <StatusRow
              icon={<Sparkles className="size-3.5" />}
              title="Analysis"
              text={insightStatusLabel(overview.insights.analysis.status)}
              tone={insightTone(overview.insights.analysis.status)}
            />
            <StatusRow
              icon={<BookOpen className="size-3.5" />}
              title="Walkthrough"
              text={insightStatusLabel(overview.insights.walkthrough.status)}
              tone={insightTone(overview.insights.walkthrough.status)}
            />
          </OverviewRow>
          <Separator />
          <OverviewRow
            title="Merge readiness"
            defaultOpen
            icon={<GitMerge className="size-3.5" />}
            trailing={mergeReadinessLabel(overview.mergeReadiness._tag)}
            trailingTone={mergeReadinessTone(overview.mergeReadiness._tag)}
          >
            <MergeReadinessDetail overview={overview} />
            {merge === undefined || terminal || overview.mergeReadiness._tag === "Blocked" ? null : (
              <div className="mt-3 border-t pt-3">
                <CompactMergeCommand
                  readiness={merge.readiness}
                  {...(merge.mergeReasons === undefined ? {} : { mergeReasons: merge.mergeReasons })}
                  {...(merge.pullRequest === undefined ? {} : { pullRequest: merge.pullRequest })}
                  context={merge.context}
                  methods={merge.methods}
                  onMerge={merge.onMerge}
                />
              </div>
            )}
          </OverviewRow>
        </div>
        {terminal ? (
          <SheetFooter className="border-t px-5 py-4">
            <p className="text-sm text-muted-foreground">This Review is {overview.terminalState} and remains readable.</p>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

type RevisionFreshness = NonNullable<CanonicalReviewOverview["revision"]>["freshness"];

const successTone = "text-status-success";
const warningTone = "text-status-warning";
const destructiveTone = "text-destructive";
const mutedTone = "text-muted-foreground";
const destructiveCard = "border-destructive/30 bg-destructive/10 text-destructive";
const warningCard = "border-status-warning/30 bg-status-warning/10 text-status-warning";
const successCard = "border-status-success/30 bg-status-success/10 text-status-success";

function RevisionDetails({
  overview,
  terminal,
  onRefresh,
}: {
  readonly overview: CanonicalReviewOverview;
  readonly terminal: boolean;
  readonly onRefresh?: () => Promise<void>;
}): React.JSX.Element {
  const revision = overview.revision;
  if (revision === undefined) return <p className="text-sm text-muted-foreground">Revision details unavailable.</p>;
  const counts: string[] = [];
  if (revision.commitCount !== undefined) counts.push(`${revision.commitCount} commit${revision.commitCount === 1 ? "" : "s"}`);
  if (revision.fileCount !== undefined) counts.push(`${revision.fileCount} file${revision.fileCount === 1 ? "" : "s"} changed`);
  return (
    <div className="space-y-2 text-sm">
      {revision.baseBranch === undefined && revision.headBranch === undefined ? null : <p className="truncate">{revision.baseBranch ?? "unknown"} ← {revision.headBranch ?? "unknown"}</p>}
      <p>Reviewed <code className="break-all">{revision.reviewedHeadSha.slice(0, 8)}</code></p>
      {revision.currentHeadSha === undefined || revision.currentHeadSha === revision.reviewedHeadSha ? null : <p>Current <code className="break-all">{revision.currentHeadSha.slice(0, 8)}</code></p>}
      <p className="text-xs text-muted-foreground">Refreshed {revision.refreshedAt}</p>
      {counts.length === 0 ? null : <p className="text-xs text-muted-foreground">{counts.join(" · ")}</p>}
      {terminal ? null : <Button size="sm" variant="outline" className="self-start" onClick={() => void onRefresh?.()}><RefreshCw data-icon="inline-start" />Refresh GitHub state</Button>}
    </div>
  );
}

function StatusRow({
  icon,
  title,
  text,
  tone,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly text: string;
  readonly tone: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className={cn("shrink-0", tone)}>{icon}</span>
        <span className="truncate">{title}</span>
      </span>
      <span className={cn("shrink-0 text-xs font-medium", tone)}>{text}</span>
    </div>
  );
}

function MergeReadinessDetail({ overview }: { readonly overview: CanonicalReviewOverview }): React.JSX.Element {
  const { mergeReadiness, mergeReasons } = overview;
  const pullRequest = overview.pullRequest;
  const showBlockers = mergeReasons.length === 0;
  const isEmpty = mergeReasons.length === 0 && mergeReadiness.blockers.length === 0 && mergeReadiness.warnings.length === 0;
  return (
    <div className="flex flex-col gap-2 text-sm">
      {mergeReasons.map((reason) => (
        <p key={reason.code} className={cn("flex items-start gap-2 rounded-md border px-3 py-2", destructiveCard)}>
          <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            {reason.message}
            <span className="ml-1 text-xs opacity-80">{reasonSourceLabel(reason.source)} · {reason.availability}</span>
            {reason.openOnGitHub && pullRequest !== undefined ? (
              <Button variant="link" size="sm" className="ml-1 h-auto p-0 align-baseline" onClick={() => void openPullRequestExternalUrl(pullRequestPageUrl(pullRequest).toString(), pullRequest)}>Open on GitHub</Button>
            ) : null}
          </span>
        </p>
      ))}
      {showBlockers ? mergeReadiness.blockers.map((blocker) => (
        <p key={`blocker-${blocker}`} className={cn("flex items-start gap-2 rounded-md border px-3 py-2", destructiveCard)}>
          <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {readinessBlockerLabel(blocker)}
        </p>
      )) : null}
      {mergeReadiness.warnings.map((warning) => (
        <p key={`warning-${warning}`} className={cn("flex items-start gap-2 rounded-md border px-3 py-2", warningCard)}>
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {readinessWarningLabel(warning)}
        </p>
      ))}
      {isEmpty ? (
        <p className={cn("flex items-start gap-2 rounded-md border px-3 py-2", successCard)}>
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          No merge blockers or warnings. This Review is ready to merge.
        </p>
      ) : null}
    </div>
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
              <CompactMergeCommand
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
  icon,
  trailing,
  trailingTone,
  compact = false,
  children,
}: {
  readonly title: string;
  readonly defaultOpen?: boolean;
  readonly icon?: React.ReactNode;
  readonly trailing?: React.ReactNode;
  readonly trailingTone?: string;
  readonly compact?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={compact ? "py-2" : "py-3"}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {icon === undefined ? null : <span aria-hidden="true" className={cn("shrink-0", trailingTone ?? "text-muted-foreground")}>{icon}</span>}
          <CollapsibleTrigger className="-ml-2 inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[0.8rem] font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
            {title}
            <ChevronDown data-disclosure-motion="chevron" className={open ? "size-4" : "size-4 -rotate-90"} aria-hidden="true" />
          </CollapsibleTrigger>
        </div>
        {trailing === undefined ? null : <span className={cn("text-xs", trailingTone ?? "text-muted-foreground")}>{trailing}</span>}
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
    case "analysis_finding": return "A high-severity Analysis finding blocks merge under this profile's policy.";
    default: return "GitHub merge requirements are not satisfied.";
  }
}

function readinessWarningLabel(warning: string): string {
  switch (warning) {
    case "request_changes": return "Changes requested.";
    case "high_severity_finding": return "High-severity local findings need acknowledgement.";
    case "analysis_finding": return "A current Analysis finding requires acknowledgement before merge.";
    default: return "Merge warning requires acknowledgement.";
  }
}

function revisionFreshnessLabel(freshness: RevisionFreshness | undefined): string {
  switch (freshness) {
    case "updates_available": return "Updates available";
    case "unavailable": return "Remote state unavailable";
    case "not_refreshed": return "Not refreshed";
    case "fresh": return "Current";
    default: return "Unavailable";
  }
}

function revisionFreshnessTone(freshness: RevisionFreshness | undefined): string {
  switch (freshness) {
    case "updates_available": return warningTone;
    case "unavailable": return mutedTone;
    case "not_refreshed": return mutedTone;
    case "fresh": return successTone;
    default: return mutedTone;
  }
}

function checksFreshness(
  freshness: RevisionFreshness | undefined,
): "fresh" | "stale" | "unavailable" | "not_refreshed" | undefined {
  if (freshness === undefined) return undefined;
  return freshness === "updates_available" ? "stale" : freshness;
}

function insightStatusLabel(status: ReviewInsightStatus): string {
  switch (status) {
    case "not_generated": return "Not generated";
    case "running": return "Running";
    case "current": return "Current";
    case "outdated": return "Outdated";
    case "failed": return "Failed";
  }
}

function insightTone(status: ReviewInsightStatus): string {
  switch (status) {
    case "current": return successTone;
    case "running": return warningTone;
    case "outdated": return warningTone;
    case "failed": return destructiveTone;
    case "not_generated": return mutedTone;
  }
}

function mergeReadinessLabel(tag: WorkbenchResponse["mergeReadiness"]["_tag"]): string {
  switch (tag) {
    case "Ready": return "Ready to merge";
    case "NeedsAcknowledgement": return "Warnings";
    case "Blocked": return "Blocked";
  }
}

function mergeReadinessTone(tag: WorkbenchResponse["mergeReadiness"]["_tag"]): string {
  switch (tag) {
    case "Ready": return successTone;
    case "NeedsAcknowledgement": return warningTone;
    case "Blocked": return destructiveTone;
  }
}

function overallLabel(
  overall: CheckSummary["overall"],
  freshness: "fresh" | "stale" | "unavailable" | "not_refreshed",
): string {
  if (freshness === "not_refreshed") return "Not refreshed";
  if (freshness === "unavailable") return "Unavailable";
  return overall === "passing" ? "Passing" : overall === "failing" ? "Failing" : overall === "pending" ? "In progress" : overall === "skipped" ? "Skipped" : "Unknown";
}
