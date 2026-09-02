import type { PullRequestRef } from "../../../domain/pull-request";
import {
  openPullRequestExternalUrl,
  pullRequestPageUrl,
} from "../external-links";
import { CompactMergeCommand } from "./compact-merge-command";
import { FinishReviewDialog } from "./finish-review-dialog";
import {
  CanonicalReviewOverviewSheet,
  type CanonicalReviewOverview,
  type OverviewFocusSection,
} from "./pr-overview-sheet";
import type { ReviewWorkbenchActions } from "./review-workbench";
import { SummaryReviewDialog } from "./summary-review-dialog";

/** The workbench's overlays: PR overview, Finish review, Summary review, merge. */
export function ReviewWorkbenchDialogs({
  actions,
  overview,
  overviewOpen,
  overviewFocusSection,
  setOverviewOpen,
  onReviewFindings,
  summaryDialogOpen,
  setSummaryDialogOpen,
  externalPullRequest,
}: {
  readonly actions: ReviewWorkbenchActions;
  readonly overview: CanonicalReviewOverview;
  readonly overviewOpen: boolean;
  readonly overviewFocusSection: OverviewFocusSection | undefined;
  readonly setOverviewOpen: (open: boolean) => void;
  readonly onReviewFindings: (findingIds: ReadonlyArray<string>) => void;
  readonly summaryDialogOpen: boolean;
  readonly setSummaryDialogOpen: (open: boolean) => void;
  readonly externalPullRequest: PullRequestRef | undefined;
}): React.JSX.Element {
  return (
    <>
      <CanonicalReviewOverviewSheet
        open={overviewOpen}
        onOpenChange={setOverviewOpen}
        overview={overview}
        {...(overviewFocusSection === undefined
          ? {}
          : { focusSection: overviewFocusSection })}
        onReviewFindings={onReviewFindings}
        {...(actions.merge === undefined ? {} : { merge: actions.merge })}
      />
      {actions.pendingReview === undefined ||
      actions.pendingReview.projection?.state !== "pending" ? null : (
        <FinishReviewDialog
          open={actions.pendingReview.finishDialogOpen}
          onOpenChange={actions.pendingReview.onCloseFinishDialog}
          projection={actions.pendingReview.projection}
          {...(actions.pendingReview.finishDialogInitialSummary === undefined
            ? {}
            : {
                initialSummary:
                  actions.pendingReview.finishDialogInitialSummary,
              })}
          actions={{
            busy: actions.pendingReview.busy,
            onSubmit: actions.pendingReview.onSubmit,
            onDiscard: actions.pendingReview.onDiscard,
            onCheckGitHubAgain: actions.pendingReview.onCheckGitHubAgain,
          }}
          {...(actions.pendingReview.finishDialogError === undefined
            ? {}
            : { error: actions.pendingReview.finishDialogError })}
        />
      )}
      {actions.directSummary === undefined ? null : (
        <SummaryReviewDialog
          open={summaryDialogOpen}
          onOpenChange={setSummaryDialogOpen}
          busy={actions.directSummary.busy}
          state={actions.directSummary.state}
          {...(actions.directSummary.receipt === undefined
            ? {}
            : { receipt: actions.directSummary.receipt })}
          {...(actions.directSummary.recoveryResolution === undefined
            ? {}
            : {
                recoveryResolution: actions.directSummary.recoveryResolution,
              })}
          approvalCapability={actions.directSummary.approvalCapability}
          {...(actions.directSummary.error === undefined
            ? {}
            : { error: actions.directSummary.error })}
          onSubmit={actions.directSummary.onSubmit}
          onRecover={actions.directSummary.onRecover}
          {...(externalPullRequest === undefined
            ? {}
            : {
                onOpenPullRequest: () => {
                  void openPullRequestExternalUrl(
                    pullRequestPageUrl(externalPullRequest).toString(),
                    externalPullRequest,
                  );
                },
              })}
        />
      )}
      {actions.merge === undefined ||
      actions.merge.readiness._tag === "Blocked" ? null : (
        <CompactMergeCommand
          initialMethod="squash"
          readiness={actions.merge.readiness}
          methods={actions.merge.methods}
          {...(actions.merge.mergeReasons === undefined
            ? {}
            : { mergeReasons: actions.merge.mergeReasons })}
          {...(actions.merge.pullRequest === undefined
            ? {}
            : { pullRequest: actions.merge.pullRequest })}
          context={actions.merge.context}
          onMerge={actions.merge.onMerge}
          onRecoverMerge={actions.merge.onRecoverMerge}
        />
      )}
    </>
  );
}
