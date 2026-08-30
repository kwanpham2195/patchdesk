import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";

import type { PullRequestRef } from "../../../domain/pull-request";
import {
  openPullRequestExternalUrl,
  pullRequestPageUrl,
} from "../external-links";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { ReviewWorkbenchActions } from "./review-workbench";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";

/** The workbench toolbar: title, status pills, external link, review actions. */
export function ReviewWorkbenchHeader({
  model,
  actions,
  title,
  repository,
  checksLabel,
  freshnessLabel,
  mergeStatus,
  hasUpdates,
  terminal,
  externalPullRequest,
  setOverviewOpen,
  setSummaryDialogOpen,
}: {
  readonly model: WorkbenchResponse;
  readonly actions: ReviewWorkbenchActions;
  readonly title: string;
  readonly repository: string;
  readonly checksLabel: string;
  readonly freshnessLabel: string;
  readonly mergeStatus: string;
  readonly hasUpdates: boolean;
  readonly terminal: boolean;
  readonly externalPullRequest: PullRequestRef | undefined;
  readonly setOverviewOpen: (open: boolean) => void;
  readonly setSummaryDialogOpen: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <header
      data-review-workbench-toolbar
      className="flex shrink-0 flex-col gap-1.5 border-b px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1
          className="min-w-0 text-lg font-semibold"
          aria-label={title}
          title={title}
        >
          #{model.session.key.prNumber} {title}
        </h1>
        <div
          className="flex flex-wrap items-center gap-2"
          aria-label="Pull request status and actions"
        >
          <Button
            variant="outline"
            size="xs"
            className={cn(
              "hover:bg-status-success/20 hover:text-status-success",
              checksPillColor(model.checks.overall),
            )}
            onClick={() => setOverviewOpen(true)}
            aria-label={`Open PR overview: checks ${checksLabel.toLowerCase()}`}
          >
            {checksIcon(model.checks.overall)}
            Checks · {checksLabel}
          </Button>
          <Button
            variant="outline"
            size="xs"
            className={cn(
              "hover:bg-destructive/20 hover:text-destructive",
              mergePillColor(mergeStatus),
            )}
            onClick={() => setOverviewOpen(true)}
            aria-label={`Open PR overview: merge ${mergeLabel(mergeStatus).toLowerCase()}`}
          >
            {mergeIcon(mergeStatus)}
            Merge · {mergeLabel(mergeStatus)}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={externalPullRequest === undefined}
            onClick={() => {
              if (externalPullRequest !== undefined)
                void openPullRequestExternalUrl(
                  pullRequestPageUrl(externalPullRequest).toString(),
                  externalPullRequest,
                );
            }}
          >
            <ExternalLink data-icon="inline-start" /> Open on GitHub
          </Button>
          {actions.pendingReview === undefined || terminal ? null : (
            <PendingReviewHeaderAction
              pendingReview={actions.pendingReview}
              onOpenSummary={() => setSummaryDialogOpen(true)}
              summaryAvailable={
                actions.directSummary !== undefined &&
                actions.directSummary.state !== "recovery_required"
              }
            />
          )}
        </div>
      </div>
      {terminal ? (
        <p
          role="status"
          className="border-t border-status-success/30 bg-status-success/10 px-1 py-2 text-sm text-status-success"
        >
          {model.review.status === "merged"
            ? "Pull request merged on GitHub. This Review remains readable."
            : "Pull request closed on GitHub. This Review remains readable."}
        </p>
      ) : (
        <PendingReviewNotice pendingReview={actions.pendingReview} />
      )}
      {model.localCheckout === undefined ? null : (
        <p
          className="border-t border-status-warning/30 bg-status-warning/10 px-1 py-2 text-sm text-status-warning"
          data-review-local-checkout-warning
          role="status"
        >
          {model.localCheckout.message}
        </p>
      )}
      <div className="flex items-center gap-1">
        <p
          className="text-xs text-muted-foreground"
          title={`${repository} · ${model.pullRequest?.baseBranch ?? "unknown"} ← ${model.pullRequest?.headBranch ?? "unknown"}`}
        >
          {repository} · {model.pullRequest?.baseBranch ?? "unknown"} ←{" "}
          {model.pullRequest?.headBranch ?? "unknown"} ·{" "}
          {model.revision.reviewedHeadSha.slice(0, 8)} · {freshnessLabel} ·
          refreshed {model.revision.refreshedAt}
          {hasUpdates ? (
            <span
              className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-status-warning/50 bg-status-warning/10 px-2 py-0.5 font-medium text-status-warning"
              role="status"
              data-review-new-version-indicator
            >
              Updates available
            </span>
          ) : null}
        </p>
        {terminal ? null : (
          // A renderer reload loads the stored projection; only the explicit
          // refresh action replaces represented GitHub state.
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            disabled={actions.refreshing === true}
            onClick={() => void actions.refresh()}
            aria-label={
              actions.refreshing === true
                ? "Refresh GitHub state — refreshing"
                : "Refresh GitHub state"
            }
          >
            {actions.refreshing === true ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
          </Button>
        )}
      </div>
    </header>
  );
}

function PendingReviewHeaderAction({
  pendingReview,
  onOpenSummary,
  summaryAvailable,
}: {
  readonly pendingReview: NonNullable<ReviewWorkbenchActions["pendingReview"]>;
  readonly onOpenSummary: () => void;
  readonly summaryAvailable: boolean;
}): React.JSX.Element | null {
  const projection = pendingReview.projection;
  if (projection === undefined || projection.state === "none") {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={onOpenSummary}
        disabled={!summaryAvailable}
        data-review-header-start
      >
        Start a review
      </Button>
    );
  }
  if (projection.state === "pending") {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={pendingReview.onOpenFinishDialog}
        disabled={pendingReview.busy}
        data-review-header-finish
      >
        Finish review · {projection.count}
      </Button>
    );
  }
  return null;
}

function PendingReviewNotice({
  pendingReview,
}: {
  readonly pendingReview: ReviewWorkbenchActions["pendingReview"];
}): React.JSX.Element | null {
  const projection = pendingReview?.projection;
  if (
    projection === undefined ||
    projection.state === "none" ||
    projection.state === "pending"
  )
    return null;
  const recovery = projection.state === "recovery_required";
  return (
    <div
      role="status"
      data-review-pending-recovery
      className="rounded-md border border-status-warning/50 bg-status-warning/10 px-3 py-1.5 text-xs text-status-warning"
    >
      {recovery ? (
        <>
          A pending review write needs reconciliation (started{" "}
          {projection.action}). GitHub was not changed without your
          confirmation.
        </>
      ) : (
        <>
          The pending review state is unavailable right now. New review comments
          are paused.
        </>
      )}{" "}
      <button
        type="button"
        className="underline decoration-status-warning/60 underline-offset-2 hover:text-status-warning"
        disabled={pendingReview?.busy === true}
        onClick={() => void pendingReview?.onCheckGitHubAgain()}
      >
        Check GitHub again
      </button>
      {pendingReview?.recoveryError === undefined ? null : (
        <InlineError className="ml-2 inline font-medium">
          {pendingReview.recoveryError}
        </InlineError>
      )}
    </div>
  );
}

function checksPillColor(overall: string): string {
  switch (overall) {
    case "passing":
      return "border-status-success/30 bg-status-success/10 text-status-success";
    case "failing":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "pending":
      return "border-status-warning/30 bg-status-warning/10 text-status-warning";
    default:
      return "border-muted-foreground/20 bg-muted/30 text-muted-foreground";
  }
}
function checksIcon(overall: string): React.JSX.Element {
  switch (overall) {
    case "passing":
      return <CheckCircle2 className="size-3" />;
    case "failing":
      return <XCircle className="size-3" />;
    case "pending":
      return <LoaderCircle className="size-3" />;
    default:
      return <AlertTriangle className="size-3" />;
  }
}

function mergePillColor(tag: string): string {
  switch (tag) {
    case "Merged":
    case "Ready":
      return "border-status-success/30 bg-status-success/10 text-status-success";
    case "Closed":
      return "border-muted-foreground/20 bg-muted/30 text-muted-foreground";
    case "NeedsAcknowledgement":
      return "border-status-warning/30 bg-status-warning/10 text-status-warning";
    case "Blocked":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    default:
      return "border-muted-foreground/20 bg-muted/30 text-muted-foreground";
  }
}
function mergeIcon(tag: string): React.JSX.Element {
  switch (tag) {
    case "Merged":
    case "Ready":
      return <CheckCircle2 className="size-3" />;
    case "Closed":
      return <XCircle className="size-3" />;
    case "NeedsAcknowledgement":
      return <AlertTriangle className="size-3" />;
    case "Blocked":
      return <XCircle className="size-3" />;
    default:
      return <AlertTriangle className="size-3" />;
  }
}
function mergeLabel(tag: string): string {
  switch (tag) {
    case "Merged":
      return "Merged";
    case "Closed":
      return "Closed";
    case "Ready":
      return "Ready";
    case "NeedsAcknowledgement":
      return "Warnings";
    case "Blocked":
      return "Blocked";
    default:
      return tag;
  }
}
