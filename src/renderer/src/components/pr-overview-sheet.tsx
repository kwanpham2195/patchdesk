import { useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  GitMerge,
  Info,
  Sparkles,
  XCircle,
} from "lucide-react";

import type {
  CheckSummary,
  MergeDisplayReason,
} from "../../../domain/github-context";
import type { PullRequestRef } from "../../../domain/pull-request";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import type { WorkbenchResponse } from "../renderer-contracts";
import {
  openPullRequestExternalUrl,
  pullRequestPageUrl,
} from "../external-links";
import { CompactMergeCommand, type MergeMethod } from "./compact-merge-command";
import { ReviewChecks, presentOverallCheckResult } from "./review-checks";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  readonly onRecoverMerge: () => Promise<void>;
};

export type PullRequestOverviewActions = {
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
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly overview: CanonicalReviewOverview;
  readonly merge?: PullRequestOverviewMerge;
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
      <SheetContent
        side="right"
        className="w-[370px] max-w-[calc(100vw-24px)] gap-0 sm:max-w-[370px]"
      >
        <SheetHeader className="border-b px-5 py-4 pr-12">
          <SheetTitle>PR overview</SheetTitle>
          <p className="truncate text-xs text-muted-foreground">
            {overview.repository}#{overview.prNumber} · {overview.title}
          </p>
        </SheetHeader>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-5 py-2"
          data-pr-overview-scroll
        >
          <OverviewRow
            title="Revision"
            defaultOpen
            trailing={revisionFreshnessLabel(freshness)}
            trailingTone={revisionFreshnessTone(freshness)}
          >
            <RevisionDetails overview={overview} />
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
              {...(checkFreshness === undefined
                ? {}
                : { freshness: checkFreshness })}
              showHeader={false}
              {...(overview.pullRequest === undefined
                ? {}
                : { pullRequest: overview.pullRequest })}
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
            trailing={mergeReadinessLabel(
              overview.mergeReadiness._tag,
              overview.mergeReadiness.blockers,
            )}
            trailingTone={mergeReadinessTone(
              overview.mergeReadiness._tag,
              overview.mergeReadiness.blockers,
            )}
          >
            <MergeReadinessDetail overview={overview} />
            {merge === undefined ||
            terminal ||
            overview.mergeReadiness._tag === "Blocked" ? null : (
              <div className="mt-3 border-t pt-3">
                <CompactMergeCommand
                  readiness={merge.readiness}
                  {...(merge.mergeReasons === undefined
                    ? {}
                    : { mergeReasons: merge.mergeReasons })}
                  {...(merge.pullRequest === undefined
                    ? {}
                    : { pullRequest: merge.pullRequest })}
                  context={merge.context}
                  methods={merge.methods}
                  onMerge={merge.onMerge}
                  onRecoverMerge={merge.onRecoverMerge}
                />
              </div>
            )}
          </OverviewRow>
        </div>
        {terminal ? (
          <SheetFooter className="border-t px-5 py-4">
            <p className="text-sm text-muted-foreground">
              This Review is {overview.terminalState} and remains readable.
            </p>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

type RevisionFreshness = NonNullable<
  CanonicalReviewOverview["revision"]
>["freshness"];

const successTone = "text-status-success";
const warningTone = "text-status-warning";
const destructiveTone = "text-destructive";
const mutedTone = "text-muted-foreground";
const infoTone = "text-status-info";
const destructiveCard =
  "border-destructive/30 bg-destructive/10 text-destructive";
const warningCard =
  "border-status-warning/30 bg-status-warning/10 text-status-warning";
const successCard =
  "border-status-success/30 bg-status-success/10 text-status-success";
// Not-yet-confirmed evidence (a "partial" reason, or the mergeability_unknown
// blocker) is Patchdesk saying it does not fully know, not a confirmed
// blocker. It gets a neutral info treatment rather than the destructive one
// reserved for evidence GitHub or a rule actually confirmed. See ADR 0027,
// "Unknown is not failure."
const infoCard = "border-status-info/30 bg-status-info/10 text-status-info";

function RevisionDetails({
  overview,
}: {
  readonly overview: CanonicalReviewOverview;
}): React.JSX.Element {
  const revision = overview.revision;
  if (revision === undefined)
    return (
      <p className="text-sm text-muted-foreground">
        Revision details unavailable.
      </p>
    );
  const counts: string[] = [];
  if (revision.commitCount !== undefined)
    counts.push(
      `${revision.commitCount} commit${revision.commitCount === 1 ? "" : "s"}`,
    );
  if (revision.fileCount !== undefined)
    counts.push(
      `${revision.fileCount} file${revision.fileCount === 1 ? "" : "s"} changed`,
    );
  return (
    <div className="space-y-2 text-sm">
      {revision.baseBranch === undefined &&
      revision.headBranch === undefined ? null : (
        <p className="truncate">
          {revision.baseBranch ?? "unknown"} ←{" "}
          {revision.headBranch ?? "unknown"}
        </p>
      )}
      <p>
        Reviewed{" "}
        <code className="break-all">
          {revision.reviewedHeadSha.slice(0, 8)}
        </code>
      </p>
      {revision.currentHeadSha === undefined ||
      revision.currentHeadSha === revision.reviewedHeadSha ? null : (
        <p>
          Current{" "}
          <code className="break-all">
            {revision.currentHeadSha.slice(0, 8)}
          </code>
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Refreshed {revision.refreshedAt}
      </p>
      {counts.length === 0 ? null : (
        <p className="text-xs text-muted-foreground">{counts.join(" · ")}</p>
      )}
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
        <span aria-hidden="true" className={cn("shrink-0", tone)}>
          {icon}
        </span>
        <span className="truncate">{title}</span>
      </span>
      <span className={cn("shrink-0 text-xs font-medium", tone)}>{text}</span>
    </div>
  );
}

function MergeReadinessDetail({
  overview,
}: {
  readonly overview: CanonicalReviewOverview;
}): React.JSX.Element {
  const { mergeReadiness, mergeReasons } = overview;
  const pullRequest = overview.pullRequest;
  const showBlockers = mergeReasons.length === 0;
  const isEmpty =
    mergeReasons.length === 0 &&
    mergeReadiness.blockers.length === 0 &&
    mergeReadiness.warnings.length === 0;
  // Every reason links to the same pull request, so only the first
  // GitHub-worthy reason gets the "Open on GitHub" action; repeating it on
  // every stacked card would be noise once several reasons render at once.
  const firstOpenOnGitHubIndex = mergeReasons.findIndex(
    (reason) => reason.openOnGitHub,
  );
  return (
    <div className="flex flex-col gap-2 text-sm">
      {mergeReasons.map((reason, index) => {
        const isConfirmed = reason.availability === "available";
        const cardTone = isConfirmed ? destructiveCard : infoCard;
        const Icon = isConfirmed ? XCircle : Info;
        const showOpenOnGitHub =
          reason.openOnGitHub &&
          index === firstOpenOnGitHubIndex &&
          pullRequest !== undefined;
        const caption = isConfirmed
          ? reasonSourceLabel(reason.source)
          : `Patchdesk could not confirm this rule · ${reasonSourceLabel(reason.source)}`;
        return (
          <div
            key={`${reason.code}-${reason.source}-${reason.message}`}
            data-reason-availability={reason.availability}
            className={cn(
              "flex flex-col gap-1.5 rounded-md border px-3 py-2",
              cardTone,
            )}
          >
            <div className="flex items-start gap-2">
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{reason.message}</span>
            </div>
            <p className="pl-6 text-xs opacity-80">{caption}</p>
            {showOpenOnGitHub ? (
              <div className="pl-6">
                <Button
                  variant="link"
                  size="sm"
                  // `text-inherit` keeps the card's own tone (destructive or
                  // info) instead of the variant's `text-primary`, which would
                  // read as a third colour inside a tinted card. Everything
                  // else is left to the variant: it underlines on hover, and
                  // `size="sm"` supplies the icon gap via `data-icon`.
                  className="h-auto p-0 text-inherit"
                  onClick={() =>
                    void openPullRequestExternalUrl(
                      pullRequestPageUrl(pullRequest).toString(),
                      pullRequest,
                    )
                  }
                >
                  <ExternalLink data-icon="inline-start" /> Open on GitHub
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
      {showBlockers
        ? mergeReadiness.blockers.map((blocker) => {
            const isUnknown = blocker === "mergeability_unknown";
            const cardTone = isUnknown ? infoCard : destructiveCard;
            const Icon = isUnknown ? Info : XCircle;
            return (
              <p
                key={`blocker-${blocker}`}
                data-blocker={blocker}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-3 py-2",
                  cardTone,
                )}
              >
                <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {readinessBlockerLabel(blocker)}
              </p>
            );
          })
        : null}
      {mergeReadiness.warnings.map((warning) => (
        <p
          key={`warning-${warning}`}
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2",
            warningCard,
          )}
        >
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {readinessWarningLabel(warning)}
        </p>
      ))}
      {isEmpty ? (
        <p
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2",
            successCard,
          )}
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          No merge blockers or warnings. This Review is ready to merge.
        </p>
      ) : null}
    </div>
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
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={compact ? "py-2" : "py-3"}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {icon === undefined ? null : (
            <span
              aria-hidden="true"
              className={cn(
                "shrink-0",
                trailingTone ?? "text-muted-foreground",
              )}
            >
              {icon}
            </span>
          )}
          <CollapsibleTrigger className="-ml-2 inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[0.8rem] font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
            {title}
            <ChevronDown
              data-disclosure-motion="chevron"
              className={open ? "size-4" : "size-4 -rotate-90"}
              aria-hidden="true"
            />
          </CollapsibleTrigger>
        </div>
        {trailing === undefined ? null : (
          <span
            className={cn("text-xs", trailingTone ?? "text-muted-foreground")}
          >
            {trailing}
          </span>
        )}
      </div>
      <CollapsibleContent motion="disclosure" className="pt-3 text-sm">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function reasonSourceLabel(source: MergeDisplayReason["source"]): string {
  switch (source) {
    case "github_pr_state":
      return "GitHub PR state";
    case "branch_protection":
      return "Branch protection";
    case "ruleset_configuration":
      return "Ruleset configuration";
    case "checks":
      return "Checks";
  }
}

function readinessBlockerLabel(blocker: string): string {
  switch (blocker) {
    case "stale_head":
      return "Refresh this Review before merging.";
    case "closed":
      return "This pull request is closed.";
    case "draft":
      return "This pull request is a draft.";
    case "conflicting":
      return "Resolve merge conflicts.";
    case "merge_blocked":
      return "GitHub merge requirements are not satisfied.";
    case "mergeability_unknown":
      return "GitHub merge status is unavailable.";
    case "required_check":
      return "Required checks have not passed.";
    case "failing_check":
      return "A check on this pull request did not pass.";
    case "github_review":
      return "Approval required by GitHub.";
    case "analysis_finding":
      return "A high-severity Analysis finding blocks merge under this profile's policy.";
    default:
      return "GitHub merge requirements are not satisfied.";
  }
}

function readinessWarningLabel(warning: string): string {
  switch (warning) {
    case "request_changes":
      return "Changes requested.";
    case "high_severity_finding":
      return "High-severity local findings need acknowledgement.";
    case "analysis_finding":
      return "A current Analysis finding requires acknowledgement before merge.";
    default:
      return "Merge warning requires acknowledgement.";
  }
}

function revisionFreshnessLabel(
  freshness: RevisionFreshness | undefined,
): string {
  switch (freshness) {
    case "updates_available":
      return "Updates available";
    case "unavailable":
      return "Remote state unavailable";
    case "not_refreshed":
      return "Not refreshed";
    case "fresh":
      return "Current";
    default:
      return "Unavailable";
  }
}

function revisionFreshnessTone(
  freshness: RevisionFreshness | undefined,
): string {
  switch (freshness) {
    case "updates_available":
      return warningTone;
    case "unavailable":
      return mutedTone;
    case "not_refreshed":
      return mutedTone;
    case "fresh":
      return successTone;
    default:
      return mutedTone;
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
    case "not_generated":
      return "Not generated";
    case "running":
      return "Running";
    case "current":
      return "Current";
    case "outdated":
      return "Outdated";
    case "failed":
      return "Failed";
  }
}

function insightTone(status: ReviewInsightStatus): string {
  switch (status) {
    case "current":
      return successTone;
    case "running":
      return warningTone;
    case "outdated":
      return warningTone;
    case "failed":
      return destructiveTone;
    case "not_generated":
      return mutedTone;
  }
}

// A "Blocked" tag whose only blocker is mergeability_unknown is not a
// confirmed block — it's Patchdesk saying it does not yet know GitHub's
// merge status. The header must not contradict the neutral info treatment
// the body already gives that case (see the infoCard comment above and
// ADR 0027, "Unknown is not failure"). Any additional blocker alongside it
// is a real, confirmed block, so it keeps the destructive treatment.
function isUnconfirmedBlock(
  tag: WorkbenchResponse["mergeReadiness"]["_tag"],
  blockers: readonly string[],
): boolean {
  return (
    tag === "Blocked" &&
    blockers.length === 1 &&
    blockers[0] === "mergeability_unknown"
  );
}

function mergeReadinessLabel(
  tag: WorkbenchResponse["mergeReadiness"]["_tag"],
  blockers: readonly string[],
): string {
  if (isUnconfirmedBlock(tag, blockers)) return "Unknown";
  switch (tag) {
    case "Ready":
      return "Ready to merge";
    case "NeedsAcknowledgement":
      return "Warnings";
    case "Blocked":
      return "Blocked";
  }
}

function mergeReadinessTone(
  tag: WorkbenchResponse["mergeReadiness"]["_tag"],
  blockers: readonly string[],
): string {
  if (isUnconfirmedBlock(tag, blockers)) return infoTone;
  switch (tag) {
    case "Ready":
      return successTone;
    case "NeedsAcknowledgement":
      return warningTone;
    case "Blocked":
      return destructiveTone;
  }
}
