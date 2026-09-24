import type { GitHubReviewEvent } from "../../../domain/pending-review";
import type { AssigneesSectionActions } from "./assignee-picker";
import type { LabelPickerActions } from "./label-picker";
import type { PullRequestOverviewMerge } from "./pr-overview-sheet";
import type {
  LocalCommentAuthoring,
  PendingReviewComposerActions,
} from "./review-diff-view";
import type { ReviewerPickerActions } from "./reviewer-picker";
import type { ChangeBaseBranchActions } from "./change-base-branch-dialog";
import type {
  DirectSummaryReviewProjection,
  WorkbenchResponse,
} from "../renderer-contracts";
import type {
  CommitDiffResponse,
  SinceReviewDiffResponse,
} from "../review-diff-contracts";
import type {
  WorkbenchActiveTab,
  WorkbenchSection,
} from "../lib/screen-restore";

export type ReviewWorkbenchActions = {
  readonly detectUpdates: () => Promise<void>;
  readonly merge?: PullRequestOverviewMerge;
  readonly refresh: () => Promise<void>;
  /** True while an explicit refresh request is pending; disables refresh actions. */
  readonly refreshing?: boolean;
  /** True when the last explicit refresh failed; surfaces bounded error copy. */
  readonly refreshError?: boolean;
  readonly loadCommitDiff: (sha: string) => Promise<CommitDiffResponse>;
  readonly loadSinceReviewDiff: () => Promise<SinceReviewDiffResponse>;
  readonly localCommentAuthoring?: LocalCommentAuthoring;
  readonly pendingReviewComposer?: PendingReviewComposerActions;
  readonly directSummary?: {
    readonly busy: boolean;
    readonly state: DirectSummaryReviewProjection["state"];
    readonly receipt?: Extract<
      DirectSummaryReviewProjection,
      { readonly state: "confirmed" }
    >["receipt"];
    readonly recoveryResolution?: Extract<
      DirectSummaryReviewProjection,
      { readonly state: "recovery_required" }
    >["resolution"];
    readonly approvalCapability: "allowed" | "blocked_author" | "unknown";
    readonly error?: string;
    readonly onSubmit: (
      event: GitHubReviewEvent,
      body: string,
    ) => Promise<DirectSummaryReviewProjection>;
    readonly onRecover: () => Promise<DirectSummaryReviewProjection>;
  };
  /** GitHub pending-review header action, Finish modal, and recovery. */
  readonly pendingReview?: {
    readonly projection: WorkbenchResponse["pendingReview"];
    readonly busy: boolean;
    readonly finishDialogOpen: boolean;
    readonly finishDialogInitialSummary?: string;
    readonly onOpenFinishDialog: () => void;
    readonly onCloseFinishDialog: () => void;
    readonly onSubmit: (
      event: GitHubReviewEvent,
      summaryBody: string,
    ) => Promise<void>;
    readonly onDiscard: () => Promise<void>;
    readonly onCheckGitHubAgain: () => Promise<void>;
    readonly finishDialogError?: string;
    readonly recoveryError?: string;
  };
  readonly setThreadState?: (
    threadId: string,
    state: "open" | "resolved",
  ) => Promise<void>;
  readonly replyToThread?: (
    threadId: string,
    body: string,
  ) => Promise<string | void>;
  readonly editComment?: (commentId: string, body: string) => Promise<void>;
  readonly deleteComment?: (commentId: string) => Promise<void>;
  readonly dismissReview?: (
    publishedReviewId: string,
    message: string,
  ) => Promise<void>;
  readonly labels?: LabelPickerActions;
  readonly assignees?: AssigneesSectionActions;
  readonly reviewers?: ReviewerPickerActions;
  /** The author's own draft toggle; `draft: false` publishes for review. Absent unless the viewer authored this pull request. */
  readonly setDraftState?: (draft: boolean) => Promise<void>;
  /** The base-branch change; absent once the Review is terminal or writes are locked. */
  readonly baseBranch?: ChangeBaseBranchActions;
  readonly reportNavigationState: (
    state: "clear" | "dirty_draft" | "write_pending",
  ) => void;
};

export type ReviewWorkbenchSlots = {
  readonly insights: React.ReactNode;
  readonly conversation: React.ReactNode;
  readonly mergeAction: React.ReactNode;
};

export type ReviewWorkbenchInitialState = {
  readonly activeTab?: WorkbenchActiveTab;
  readonly section?: WorkbenchSection;
  readonly selectedPath?: string;
  readonly selectedCommitSha?: string;
  readonly overviewOpen?: boolean;
  readonly draftExpanded?: boolean;
  readonly insightDetail?: "analysis" | "walkthrough";
};
