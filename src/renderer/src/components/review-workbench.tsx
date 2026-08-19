import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  PanelLeftOpen,
  XCircle,
} from "lucide-react";

import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import { projectReadOnlyConversationAnnotations } from "../inline-conversation-mapping";
import { fingerprintPatchAnchor } from "../../../domain/diff-anchor";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitHubThreadId,
  parsePullRequestNumber,
  parseRepoRelativePath,
} from "../../../domain/ids";
import type { CheckSummary } from "../../../domain/github-context";
import type { PullRequestRef } from "../../../domain/pull-request";
import { LabelChip } from "./label-chip";
import { LabelPicker, type LabelPickerActions } from "./label-picker";
import type {
  CommitDiffResponse,
  DirectSummaryReviewProjection,
  WorkbenchResponse,
} from "../renderer-contracts";
import { Conversation } from "./conversation";
import {
  openPullRequestExternalUrl,
  pullRequestPageUrl,
} from "../external-links";
import { DiffWorkbench } from "./diff-workbench";
import type {
  LocalCommentAuthoring,
  LocalCommentLocation,
  PendingReviewComposerActions,
  ReviewInlineAnnotation,
} from "./review-diff-view";
import type {
  ConversationThreadCardData,
  ReviewConversationActions,
} from "./conversation-thread-card";
import {
  CanonicalReviewOverviewSheet,
  type CanonicalReviewOverview,
  type PullRequestOverviewMerge,
} from "./pr-overview-sheet";
import { CompactMergeCommand } from "./compact-merge-command";
import { FinishReviewDialog } from "./finish-review-dialog";
import { SummaryReviewDialog } from "./summary-review-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  ReviewNavigator,
  type ReviewNavigatorSection,
} from "./review-navigator";
import { useCommitDiff } from "../hooks/use-commit-diff";
import {
  loadReviewViewPreferences,
  saveReviewViewPreferences,
  type ReviewViewPreferences,
} from "../review-view-preferences";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Mutable draft of `ConversationThreadCardData`, built in statements so
 * each optional callback is added only when its action is wired, instead of
 * a conditional empty-object spread. */
type MutableConversationThreadCardData = {
  -readonly [K in keyof ConversationThreadCardData]: ConversationThreadCardData[K];
};
/** Mutable draft of `ReviewConversationActions`. */
type MutableReviewConversationActions = {
  -readonly [K in keyof ReviewConversationActions]: ReviewConversationActions[K];
};
/** The subset of `Conversation`'s props built conditionally, so the
 * `conversationActions` prop is only added (never spread from a conditional
 * empty object) when at least one direct-conversation action is wired. */
type ConversationTabProps = {
  conversationActions?: ReviewConversationActions;
};

/** Mutable draft of `CanonicalReviewOverview`, built in statements so each
 * optional field is added only when it has a value, instead of a
 * conditional empty-object spread. */
type MutableCanonicalReviewOverview = {
  -readonly [K in keyof CanonicalReviewOverview]: CanonicalReviewOverview[K];
};
/** Mutable draft of `CanonicalReviewOverview["revision"]`. */
type MutableCanonicalReviewOverviewRevision = {
  baseBranch?: string;
  headBranch?: string;
  reviewedHeadSha: string;
  currentHeadSha?: string;
  freshness: "fresh" | "updates_available" | "unavailable" | "not_refreshed";
  refreshedAt: string;
  commitCount?: number;
  fileCount?: number;
};

/** Direct conversation actions for both `<Conversation>` (the Conversation
 * tab) and the diff view, derived from the same underlying `actions` so
 * Reply/Resolve/Edit/Delete wiring never drifts between the two surfaces.
 * The diff view additionally only wires them when `selectedCommitSha` is
 * unset (viewing the full Review diff, not one commit's slice); the
 * Conversation tab is independent of that selection. */
type DirectConversationActionProps = {
  readonly conversationTabProps: ConversationTabProps;
  readonly diffConversationActions: MutableReviewConversationActions | undefined;
};
function directConversationActionProps(
  actions: Pick<
    ReviewWorkbenchActions,
    "setThreadState" | "replyToThread" | "editComment" | "deleteComment"
  >,
  selectedCommitSha: string | undefined,
): DirectConversationActionProps {
  const hasAnyAction =
    actions.setThreadState !== undefined ||
    actions.replyToThread !== undefined ||
    actions.editComment !== undefined ||
    actions.deleteComment !== undefined;
  const conversationActionsForTab: MutableReviewConversationActions | undefined =
    hasAnyAction ? {} : undefined;
  if (conversationActionsForTab !== undefined) {
    if (actions.setThreadState !== undefined)
      conversationActionsForTab.setThreadState = actions.setThreadState;
    if (actions.replyToThread !== undefined)
      conversationActionsForTab.replyToThread = actions.replyToThread;
    if (actions.editComment !== undefined)
      conversationActionsForTab.editComment = actions.editComment;
    if (actions.deleteComment !== undefined)
      conversationActionsForTab.deleteComment = actions.deleteComment;
  }
  // `exactOptionalPropertyTypes` treats `conversationActions={undefined}` as
  // distinct from omitting the prop, so the prop itself is only added here
  // (never spread from a conditional empty-object).
  const conversationTabProps: ConversationTabProps = {};
  if (conversationActionsForTab !== undefined)
    conversationTabProps.conversationActions = conversationActionsForTab;

  const diffConversationActions: MutableReviewConversationActions | undefined =
    selectedCommitSha === undefined && hasAnyAction ? {} : undefined;
  if (diffConversationActions !== undefined) {
    if (actions.setThreadState !== undefined)
      diffConversationActions.setThreadState = actions.setThreadState;
    if (actions.replyToThread !== undefined)
      diffConversationActions.replyToThread = actions.replyToThread;
    if (actions.editComment !== undefined)
      diffConversationActions.editComment = actions.editComment;
    if (actions.deleteComment !== undefined)
      diffConversationActions.deleteComment = actions.deleteComment;
  }
  return { conversationTabProps, diffConversationActions };
}

function pullRequestExternalRef(
  model: WorkbenchResponse,
): PullRequestRef | undefined {
  const source = model.pullRequest?.ref ?? {
    host: model.session.key.host,
    owner: model.session.key.owner,
    repo: model.session.key.repo,
    number: model.session.key.prNumber,
  };
  const host = parseGitHubHost(source.host);
  const owner = parseGitHubOwner(source.owner);
  const repo = parseGitHubRepoName(source.repo);
  const number = parsePullRequestNumber(source.number);
  if (
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    number._tag === "err"
  )
    return undefined;
  return {
    host: host.value,
    owner: owner.value,
    repo: repo.value,
    number: number.value,
  };
}

function createCommitCommentAuthoring(
  base: LocalCommentAuthoring | undefined,
  fullPatch: string,
): LocalCommentAuthoring | undefined {
  if (base?.enabled !== true) return undefined;
  const files = parseUnifiedPatch(fullPatch);
  const map = (location: LocalCommentLocation) =>
    mapFindingLocation(files, {
      file: location.path,
      lineStart: location.startLine,
      lineEnd: location.line,
      diffSide: location.side,
    });
  return {
    enabled: true,
    canAuthor: (location) => map(location).mappingStatus === "mapped",
    onSelectionChange: (location) => {
      const mapped = map(location);
      if (
        mapped.mappingStatus !== "mapped" ||
        mapped.path === undefined ||
        mapped.side === undefined ||
        mapped.line === undefined
      )
        return;
      base.onSelectionChange?.({
        path: mapped.path,
        startLine: mapped.startLine ?? mapped.line,
        line: mapped.line,
        side: mapped.side,
      });
    },
    onSave: async (input) => {
      const mapped = map(input);
      if (
        mapped.mappingStatus !== "mapped" ||
        mapped.path === undefined ||
        mapped.side === undefined ||
        mapped.line === undefined
      )
        return;
      const parsedPath = parseRepoRelativePath(mapped.path);
      if (parsedPath._tag === "err") return;
      const startLine = mapped.startLine ?? mapped.line;
      const anchor = {
        path: parsedPath.value,
        startLine,
        line: mapped.line,
        side: mapped.side,
      };
      const fingerprint = fingerprintPatchAnchor(fullPatch, anchor);
      const payload = {
        ...input,
        path: mapped.path,
        startLine,
        line: mapped.line,
        side: mapped.side,
      };
      await base.onSave(
        fingerprint === undefined ? payload : { ...payload, fingerprint },
      );
    },
  };
}

export type ReviewWorkbenchActions = {
  readonly detectUpdates: () => Promise<void>;
  readonly merge?: PullRequestOverviewMerge;
  readonly refresh: () => Promise<void>;
  /** True while an explicit refresh request is pending; disables refresh actions. */
  readonly refreshing?: boolean;
  /** True when the last explicit refresh failed; surfaces bounded error copy. */
  readonly refreshError?: boolean;
  readonly loadCommitDiff: (sha: string) => Promise<CommitDiffResponse>;
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
      event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
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
      event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
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
  readonly labels?: LabelPickerActions;
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
  readonly activeTab?: "conversation" | "diff" | "insights";
  readonly section?: ReviewNavigatorSection | "insights";
  readonly selectedPath?: string;
  readonly selectedCommitSha?: string;
  readonly overviewOpen?: boolean;
  readonly draftExpanded?: boolean;
  readonly insightDetail?: "analysis" | "walkthrough";
};

const PublishedFeedbackNavigationContext = createContext<
  (() => void) | undefined
>(undefined);

/** Renders the canonical Review projection. Optional work stays in typed slots. */
// Pre-existing giant component (~850 lines before this change;
// `react-doctor --scope changed --base main` reports zero new issues here).
// Splitting it is the renderer god-file refactor the project's own plans
// explicitly defer to dedicated, separately-scoped work, not a fix this
// small feature change should take on.
// react-doctor-disable-next-line react-doctor/no-giant-component -- see comment above
export function ReviewWorkbench({
  model,
  actions,
  slots,
  initialState,
  onPositionCommitted,
}: {
  readonly model: WorkbenchResponse;
  readonly actions: ReviewWorkbenchActions;
  readonly slots: ReviewWorkbenchSlots;
  readonly initialState?: ReviewWorkbenchInitialState;
  /** Reports a visible navigation command so reloads can restore it. */
  readonly onPositionCommitted?: (state: {
    readonly activeTab: "conversation" | "diff" | "insights";
    readonly section: ReviewNavigatorSection;
    readonly selectedPath?: string;
  }) => void;
}): React.JSX.Element {
  const terminal = model.review.status !== "open";
  const hasUpdates = model.revision.freshness === "updates_available";
  const freshnessLabel = hasUpdates
    ? "Updates available"
    : model.revision.freshness === "unavailable"
      ? "Remote state unavailable"
      : model.revision.freshness === "not_refreshed"
        ? "Not refreshed"
        : "Current";
  const checksLabel =
    model.checks.overall === "passing"
      ? "Passing"
      : model.checks.overall === "failing"
        ? "Failing"
        : model.checks.overall === "pending"
          ? "In progress"
          : model.checks.overall === "skipped"
            ? "Skipped"
            : "Unknown";
  const repository = `${model.session.key.owner}/${model.session.key.repo}`;
  const title =
    model.pullRequest?.title ?? `Pull request #${model.session.key.prNumber}`;
  // The desktop close guard blocks quitting while a GitHub write is in
  // flight; report write_pending on busy transitions (and clear afterwards).
  const writePending =
    actions.pendingReview?.busy === true || actions.directSummary?.busy === true;
  const reportedWritePending = useRef(writePending);
  const reportNavigationStateRef = useRef(actions.reportNavigationState);
  useEffect(() => {
    reportNavigationStateRef.current = actions.reportNavigationState;
    if (reportedWritePending.current === writePending) return;
    reportedWritePending.current = writePending;
    reportNavigationStateRef.current(
      writePending ? "write_pending" : "clear",
    );
  });

  const [overviewOpen, setOverviewOpen] = useState(
    initialState?.overviewOpen ?? false,
  );
  const [summaryDialogOpen, setSummaryDialogOpen] = useState(false);
  const [navigatorVisible, setNavigatorVisible] = useState(true);
  const [preferences, setPreferences] = useState<ReviewViewPreferences>(() =>
    loadReviewViewPreferences(model.session.key.profileId),
  );
  const [section, setSection] = useState<ReviewNavigatorSection>(
    initialState?.section === "insights"
      ? "files"
      : (initialState?.section ?? "files"),
  );
  const [activeTab, setActiveTab] = useState<
    "conversation" | "diff" | "insights"
  >(
    initialState?.activeTab ??
      (initialState?.section === "insights" ? "insights" : "diff"),
  );
  const [selectedPath, setSelectedPath] = useState<string | undefined>(
    initialState?.selectedPath,
  );
  const [activePath, setActivePath] = useState<string | undefined>(
    initialState?.selectedPath,
  );
  const [selectedCommitSha, setSelectedCommitSha] = useState<
    string | undefined
  >(initialState?.selectedCommitSha);
  const commitWorkbenchPosition = useCallback(
    (next: {
      readonly activeTab: "conversation" | "diff" | "insights";
      readonly section: ReviewNavigatorSection;
      readonly selectedPath?: string;
    }): void => {
      setActiveTab(next.activeTab);
      setSection(next.section);
      setSelectedPath(next.selectedPath);
      const position = { activeTab: next.activeTab, section: next.section };
      onPositionCommitted?.(
        next.selectedPath === undefined || next.selectedPath.endsWith("/")
          ? position
          : { ...position, selectedPath: next.selectedPath },
      );
    },
    [onPositionCommitted],
  );
  const feedbackRegionRef = useRef<HTMLDivElement>(null);
  const [previousRevision, setPreviousRevision] = useState(
    model.revision.reviewedHeadSha,
  );
  const retainedAnalysis = model.insights.analysis.retained;
  const analysisIsCurrent =
    model.insights.analysis.status === "current" &&
    retainedAnalysis?.sessionId === model.session.id &&
    retainedAnalysis.headSha === model.revision.reviewedHeadSha;
  const findings = analysisIsCurrent
    ? retainedAnalysis.value.findings.filter(
        (finding) => finding.mappingStatus === "mapped",
      )
    : [];
  const selectedCommit =
    selectedCommitSha === undefined
      ? undefined
      : model.commits.find((commit) => commit.sha === selectedCommitSha);
  const loadCommit = useCallback(
    (sha: string): void => {
      commitWorkbenchPosition({ activeTab: "diff", section: "commits" });
      setSelectedCommitSha(sha);
    },
    [commitWorkbenchPosition],
  );
  const selectSection = useCallback(
    (next: ReviewNavigatorSection): void => {
      commitWorkbenchPosition({ activeTab: "diff", section: next });
      if (next !== "commits") {
        setSelectedCommitSha(undefined);
      }
      if (
        next === "commits" &&
        selectedCommitSha === undefined &&
        model.commits[0] !== undefined
      )
        loadCommit(model.commits[0].sha);
    },
    [commitWorkbenchPosition, loadCommit, model.commits, selectedCommitSha],
  );
  const selectCommit = useCallback(
    (sha: string): void => {
      loadCommit(sha);
    },
    [loadCommit],
  );
  if (previousRevision !== model.revision.reviewedHeadSha) {
    setPreviousRevision(model.revision.reviewedHeadSha);
    setSelectedCommitSha(undefined);
    setSelectedPath(undefined);
    setActivePath(undefined);
    setSection("files");
    setActiveTab("conversation");
  }
  const updatePreferences = useCallback(
    (update: Partial<ReviewViewPreferences>): void => {
      setPreferences((current) => ({ ...current, ...update }));
      saveReviewViewPreferences(model.session.key.profileId, update);
    },
    [model.session.key.profileId],
  );
  const commitDiffOptions = {
    revisionKey: model.revision.reviewedHeadSha,
    loadCommitDiff: actions.loadCommitDiff,
  };
  const commitDiffState = useCommitDiff(
    selectedCommitSha === undefined
      ? commitDiffOptions
      : { ...commitDiffOptions, selectedSha: selectedCommitSha },
  );
  const commitCommentAuthoring = useMemo(
    () =>
      selectedCommitSha === undefined || model.fullPatch === undefined
        ? undefined
        : createCommitCommentAuthoring(
            actions.localCommentAuthoring,
            model.fullPatch,
          ),
    [actions.localCommentAuthoring, model.fullPatch, selectedCommitSha],
  );
  const commitDiff =
    commitDiffState._tag === "Ready" ? commitDiffState.projection : undefined;
  const readOnlyConversationAnnotations = useMemo(() => {
    if (model.fullPatch === undefined) return [];
    return projectReadOnlyConversationAnnotations(
      parseUnifiedPatch(model.fullPatch),
      model.conversation.inline?.threads ?? [],
    );
  }, [model.conversation.inline, model.fullPatch]);
  const conversationAnnotations: ReadonlyArray<ReviewInlineAnnotation> =
    useMemo(() => {
      return readOnlyConversationAnnotations.flatMap((thread) => {
        // The wire model carries plain string ids; the annotation target needs
        // the verified GitHub thread id so Reply and Resolve are only reachable
        // through an id the mutation layer accepts.
        const parsedThreadId = parseGitHubThreadId(thread.id);
        if (parsedThreadId._tag === "err") return [];
        const conversationThread: MutableConversationThreadCardData = {
          target: { _tag: "thread" as const, id: parsedThreadId.value },
          state: thread.state,
          comments: thread.comments,
        };
        if (thread.complete !== undefined)
          conversationThread.complete = thread.complete;
        if (actions.setThreadState !== undefined)
          conversationThread.onSetState = actions.setThreadState;
        if (actions.replyToThread !== undefined)
          conversationThread.onReply = actions.replyToThread;
        if (actions.editComment !== undefined)
          conversationThread.onEditComment = actions.editComment;
        if (actions.deleteComment !== undefined)
          conversationThread.onDeleteComment = actions.deleteComment;
        return [
          {
            id: `conversation:${thread.id}`,
            path: thread.path,
            start: thread.start,
            end: thread.end,
            side: thread.side,
            severity: "conversation",
            title: "Conversation",
            explanation: "",
            conversationThread,
          },
        ];
      });
    }, [
      actions.deleteComment,
      actions.editComment,
      actions.replyToThread,
      actions.setThreadState,
      readOnlyConversationAnnotations,
    ]);
  const pendingReviewAnnotations: ReadonlyArray<ReviewInlineAnnotation> =
    model.pendingReview?.state !== "pending"
      ? []
      : (() => {
          const pendingReview = model.pendingReview;
          return pendingReview.review.comments.flatMap((comment) => {
            const parsedThreadId = parseGitHubThreadId(comment.threadId);
            if (parsedThreadId._tag === "err") return [];
            return [
              {
                id: `pending-review:${comment.threadId}`,
                path: comment.path,
                start: comment.startLine,
                end: comment.line,
                side: comment.side,
                severity: "conversation",
                title: "Pending review",
                explanation: "",
                pendingReviewThread: {
                  threadId: parsedThreadId.value,
                  body: comment.body,
                  nodeId: pendingReview.review.nodeId,
                },
              },
            ];
          });
        })();
  // A pending-review thread is also visible to the thread reader; the pending
  // card is the authoritative view for the review owner, so the represented
  // conversation must not duplicate the same thread id.
  const pendingThreadIds = new Set(
    pendingReviewAnnotations.flatMap((annotation) =>
      annotation.pendingReviewThread === undefined
        ? []
        : [annotation.pendingReviewThread.threadId],
    ),
  );
  const annotations: ReadonlyArray<ReviewInlineAnnotation> = [
    ...findings.flatMap((finding) =>
      finding.file === undefined ||
      finding.lineStart === undefined ||
      finding.diffSide === undefined
        ? []
        : [
            {
              id: finding.id,
              path: finding.file,
              start: finding.lineStart,
              end: finding.lineEnd ?? finding.lineStart,
              side: finding.diffSide,
              severity: finding.severity,
              title: finding.title,
              explanation: finding.explanation,
            },
          ],
    ),
    ...conversationAnnotations.filter(
      (annotation) =>
        !(
          annotation.conversationThread?.target._tag === "thread" &&
          pendingThreadIds.has(annotation.conversationThread.target.id)
        ),
    ),
    ...pendingReviewAnnotations,
  ];
  const commitDiffError = commitDiffState._tag === "Failed";
  const displayedPatch = commitDiff?.patch ?? model.fullPatch;
  const externalPullRequest = pullRequestExternalRef(model);
  const overviewRevision: MutableCanonicalReviewOverviewRevision = {
    reviewedHeadSha: model.revision.reviewedHeadSha,
    freshness: model.revision.freshness,
    refreshedAt: model.revision.refreshedAt,
    commitCount: model.commits.length,
  };
  if (model.pullRequest !== undefined) {
    overviewRevision.baseBranch = model.pullRequest.baseBranch;
    overviewRevision.headBranch = model.pullRequest.headBranch;
  }
  if (model.revision.currentHeadSha !== undefined)
    overviewRevision.currentHeadSha = model.revision.currentHeadSha;
  if (model.pullRequest?.changedFileCount !== undefined)
    overviewRevision.fileCount = model.pullRequest.changedFileCount;
  const overview: MutableCanonicalReviewOverview = {
    repository,
    prNumber: model.session.key.prNumber,
    title,
    summary:
      retainedAnalysis?.value.summary ??
      "No retained Analysis is available for this snapshot.",
    // SAFETY: the validated projection is structurally identical to the
    // domain shapes; valibot's optional fields carry an explicit undefined
    // that the strict domain types reject, so the overview adopts them at
    // this renderer seam. Runtime validation already ran on `model.checks`.
    checks: model.checks as CheckSummary,
    mergeReadiness: model.mergeReadiness,
    mergeReasons: model.mergeReasons ?? [],
    revision: overviewRevision,
    insights: {
      analysis: { status: model.insights.analysis.status },
      walkthrough: { status: model.insights.walkthrough.status },
    },
  };
  if (model.pullRequest?.description !== undefined)
    overview.description = model.pullRequest.description;
  if (externalPullRequest !== undefined)
    overview.pullRequest = externalPullRequest;
  if (model.review.status !== "open") overview.terminalState = model.review.status;
  const commitHeader =
    selectedCommit === undefined || commitDiff === undefined
      ? undefined
      : {
          sha: selectedCommit.sha,
          title:
            selectedCommit.message.split("\n", 1)[0] ??
            selectedCommit.sha.slice(0, 8),
          subtitle: `${selectedCommit.author} · ${selectedCommit.sha.slice(0, 8)} · ${formatRelativeTime(selectedCommit.authoredAt)} · ${commitDiff.position} of ${commitDiff.total} · ${commitDiff.fileCount} files · +${commitDiff.additions}/-${commitDiff.deletions}`,
        };

  const focusPublishedFeedback = useCallback((): void => {
    const feedbackRegion = feedbackRegionRef.current;
    const region =
      feedbackRegion?.querySelector<HTMLElement>(
        '[aria-label="Published feedback"]',
      ) ?? feedbackRegion;
    if (region === null || region === undefined) return;
    const trigger = region.querySelector<HTMLButtonElement>(
      "[data-published-feedback-trigger]",
    );
    if (trigger?.getAttribute("aria-expanded") === "false") trigger.click();
    region.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    region.focus({ preventScroll: true });
  }, []);

  const { conversationTabProps, diffConversationActions } =
    directConversationActionProps(actions, selectedCommitSha);

  return (
    <PublishedFeedbackNavigationContext.Provider
      value={focusPublishedFeedback}
    >
      <section
        className="flex min-h-0 flex-1 flex-col"
        aria-label="Review workbench"
      >
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
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs",
                  checksPillColor(model.checks.overall),
                )}
              >
                {checksIcon(model.checks.overall)}
                Checks · {checksLabel}
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs",
                  mergePillColor(model.mergeReadiness._tag),
                )}
              >
                {mergeIcon(model.mergeReadiness._tag)}
                Merge · {mergeLabel(model.mergeReadiness._tag)}
              </span>
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
                <ExternalLink /> Open on GitHub
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOverviewOpen(true)}
              >
                PR overview
              </Button>
              {actions.pendingReview === undefined || terminal ? null : (
                <PendingReviewHeaderAction
                  pendingReview={actions.pendingReview}
                  onNavigateToDiff={() =>
                    commitWorkbenchPosition({ activeTab: "diff", section })
                  }
                  onOpenSummary={() => setSummaryDialogOpen(true)}
                  summaryAvailable={
                    actions.directSummary !== undefined &&
                    actions.directSummary.state !== "recovery_required"
                  }
                />
              )}
            </div>
          </div>
          {model.pullRequest === undefined ? null : (
            <div
              className="flex flex-wrap items-center gap-1"
              aria-label="Pull request labels"
            >
              {model.pullRequest.labels.map((label) => (
                <LabelChip key={label.name} label={label} />
              ))}
              <LabelPicker
                attachedLabels={model.pullRequest.labels}
                {...(actions.labels === undefined
                  ? {}
                  : { actions: actions.labels })}
              />
            </div>
          )}
          <PendingReviewNotice pendingReview={actions.pendingReview} />
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
                className="ml-2 inline-flex items-center gap-2 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400"
                role="status"
                data-review-new-version-indicator
              >
                Updates available
                {/* A renderer reload loads the stored projection; only the explicit
                refresh action replaces represented GitHub state. */}
                <button
                  type="button"
                  className="underline decoration-amber-500/60 underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300"
                  disabled={actions.refreshing === true || terminal}
                  onClick={() => void actions.refresh()}
                >
                  {actions.refreshing === true
                    ? "Refreshing…"
                    : "Refresh GitHub state"}
                </button>
              </span>
            ) : null}
          </p>
          <p className="sr-only" aria-live="polite">
            {hasUpdates
              ? "Remote updates are available. Refresh before publishing or merging."
              : "Review state is current."}
          </p>
        </header>

        <div
          className="flex shrink-0 items-center gap-1 border-b px-4 py-1"
          data-review-workbench-tabs
        >
          <TabButton
            active={activeTab === "conversation"}
            onClick={() =>
              commitWorkbenchPosition({ activeTab: "conversation", section })
            }
          >
            Conversation
          </TabButton>
          <TabButton
            active={activeTab === "diff"}
            onClick={() =>
              commitWorkbenchPosition({ activeTab: "diff", section })
            }
          >
            Diff
          </TabButton>
          <TabButton
            active={activeTab === "insights"}
            onClick={() =>
              commitWorkbenchPosition({
                activeTab: "insights",
                section: "files",
              })
            }
          >
            Insights
          </TabButton>
        </div>

        <div
          className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden"
          data-review-workbench-content
        >
          {activeTab === "conversation" ? (
            <Conversation
              conversation={model.conversation}
              {...conversationTabProps}
            />
          ) : activeTab === "diff" ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              {model.fullPatch === undefined ? (
                <div className="p-6 text-sm text-muted-foreground">
                  No patch is available for this Review session.
                </div>
              ) : (
                <div
                  data-review-diff-layout={
                    navigatorVisible
                      ? "with-navigator"
                      : "collapsed-navigator"
                  }
                  className={`grid h-full min-h-0 flex-1 ${navigatorVisible ? "min-[1100px]:grid-cols-[18rem_minmax(0,1fr)]" : "grid-cols-[2.75rem_minmax(0,1fr)]"}`}
                >
                  {navigatorVisible ? (
                    <ReviewNavigator
                      patch={model.fullPatch}
                      commits={model.commits}
                      section={section}
                      {...(selectedPath === undefined
                        ? {}
                        : { selectedPath })}
                      {...(activePath === undefined ? {} : { activePath })}
                      {...(selectedCommitSha === undefined
                        ? {}
                        : { selectedCommitSha })}
                      onSectionChange={selectSection}
                      onFileSelect={(path) => {
                        commitWorkbenchPosition({
                          activeTab: "diff",
                          section: "files",
                          selectedPath: path,
                        });
                        setActivePath(path);
                      }}
                      onCommitSelect={selectCommit}
                      onCollapse={() => setNavigatorVisible(false)}
                    />
                  ) : (
                    <div className="flex items-start justify-center pt-2">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              size="icon-sm"
                              variant="outline"
                              onClick={() => setNavigatorVisible(true)}
                              aria-label="Show review navigator"
                            />
                          }
                        >
                          <PanelLeftOpen />
                        </TooltipTrigger>
                        <TooltipContent>Show review navigator</TooltipContent>
                      </Tooltip>
                    </div>
                  )}
                  <div className="min-h-0 min-w-0">
                    {selectedCommitSha !== undefined &&
                    commitDiffState._tag === "Loading" ? (
                      <p
                        className="p-6 text-sm text-muted-foreground"
                        role="status"
                      >
                        Loading commit diff…
                      </p>
                    ) : displayedPatch === undefined ? (
                      <p className="p-6 text-sm text-muted-foreground">
                        No patch is available for this Review session.
                      </p>
                    ) : (
                      <>
                        <DiffWorkbench
                          key={
                            selectedCommitSha ??
                            model.revision.reviewedHeadSha
                          }
                          patch={displayedPatch}
                          {...(selectedCommitSha === undefined
                            ? {
                                sourceSession: {
                                  profileId: model.session.key.profileId,
                                  sessionId: model.session.id,
                                },
                              }
                            : {})}
                          {...(selectedPath === undefined ||
                          selectedCommitSha !== undefined
                            ? {}
                            : {
                                controlledSelectedPath: selectedPath,
                                onSelectedPathChange: (path: string) => {
                                  commitWorkbenchPosition({
                                    activeTab: "diff",
                                    section,
                                    selectedPath: path,
                                  });
                                  setActivePath(path);
                                },
                              })}
                          {...(selectedCommitSha === undefined
                            ? {
                                onActiveFileChange: (path: string) =>
                                  setActivePath(path),
                              }
                            : {})}
                          {...(selectedCommitSha === undefined
                            ? { annotations }
                            : {})}
                          {...(selectedCommitSha === undefined
                            ? actions.localCommentAuthoring === undefined
                              ? {}
                              : {
                                  localCommentAuthoring:
                                    actions.localCommentAuthoring,
                                }
                            : commitCommentAuthoring === undefined
                              ? {}
                              : {
                                  localCommentAuthoring:
                                    commitCommentAuthoring,
                                })}
                          {...(actions.pendingReviewComposer === undefined
                            ? {}
                            : {
                                pendingReviewComposer:
                                  actions.pendingReviewComposer,
                              })}
                          {...(diffConversationActions === undefined
                            ? {}
                            : { conversationActions: diffConversationActions })}
                          hideFileNavigation
                          surfaceAction={undefined}
                          {...(commitHeader === undefined
                            ? {}
                            : {
                                diffTitle: commitHeader.title,
                                diffSubtitle: commitHeader.subtitle,
                                copyValue: commitHeader.sha,
                              })}
                          className="min-h-0 h-full"
                          fillViewport={false}
                          preferences={preferences}
                          onPreferencesChange={updatePreferences}
                        />
                      </>
                    )}
                    {commitDiffError ? (
                      <p
                        role="alert"
                        className="border-t px-4 py-2 text-sm text-destructive"
                      >
                        This commit diff could not be loaded.
                      </p>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div
              data-review-workbench-insights
              className="min-h-0 flex-1 overflow-hidden p-4"
            >
              {slots.insights}
            </div>
          )}
        </div>

        <div
          ref={feedbackRegionRef}
          tabIndex={-1}
          className="hidden min-h-0 max-h-[min(25vh,16rem)] shrink-0 overflow-y-auto outline-none"
          data-review-workbench-feedback
        >
          {slots.conversation}
          {slots.mergeAction}
        </div>
        <div
          className="hidden min-h-0 shrink-0"
          data-review-workbench-draft-dock
        ></div>

        <CanonicalReviewOverviewSheet
          open={overviewOpen}
          onOpenChange={setOverviewOpen}
          overview={overview}
          {...(actions.merge === undefined ? {} : { merge: actions.merge })}
          onRefresh={actions.refresh}
        />
        {actions.pendingReview === undefined ||
        actions.pendingReview.projection?.state !== "pending" ? null : (
          <FinishReviewDialog
            open={actions.pendingReview.finishDialogOpen}
            onOpenChange={actions.pendingReview.onCloseFinishDialog}
            projection={actions.pendingReview.projection}
            {...(actions.pendingReview.finishDialogInitialSummary ===
            undefined
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
                  recoveryResolution:
                    actions.directSummary.recoveryResolution,
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
      </section>
    </PublishedFeedbackNavigationContext.Provider>
  );
}

function PendingReviewHeaderAction({
  pendingReview,
  onNavigateToDiff,
  onOpenSummary,
  summaryAvailable,
}: {
  readonly pendingReview: NonNullable<ReviewWorkbenchActions["pendingReview"]>;
  readonly onNavigateToDiff: () => void;
  readonly onOpenSummary: () => void;
  readonly summaryAvailable: boolean;
}): React.JSX.Element | null {
  const [startChoiceOpen, setStartChoiceOpen] = useState(false);
  const projection = pendingReview.projection;
  if (projection === undefined || projection.state === "none") {
    // Start a review directs the maintainer to select a valid inline Diff
    // range; it never creates an empty remote review (unproven path).
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setStartChoiceOpen(true)}
          data-review-header-start
        >
          Start a review
        </Button>
        <Dialog open={startChoiceOpen} onOpenChange={setStartChoiceOpen}>
          <DialogContent aria-label="Start review">
            <DialogHeader>
              <DialogTitle>Start review</DialogTitle>
              <DialogDescription>
                Choose how to start. Inline comments begin a GitHub pending
                review only after you select a changed line.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setStartChoiceOpen(false);
                  onNavigateToDiff();
                }}
              >
                Add inline comment
              </Button>
              <Button
                onClick={() => {
                  setStartChoiceOpen(false);
                  onOpenSummary();
                }}
                disabled={!summaryAvailable}
              >
                Write review summary
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
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
      className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
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
        className="underline decoration-amber-600/60 underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100"
        disabled={pendingReview?.busy === true}
        onClick={() => void pendingReview?.onCheckGitHubAgain()}
      >
        Check GitHub again
      </button>
      {pendingReview?.recoveryError === undefined ? null : (
        <span role="alert" className="ml-2 font-medium">
          {pendingReview.recoveryError}
        </span>
      )}
    </div>
  );
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, divisor] of units)
    if (Math.abs(seconds) >= divisor)
      return relativeTimeFormatter.format(Math.round(seconds / divisor), unit);
  return relativeTimeFormatter.format(seconds, "second");
}

function checksPillColor(overall: string): string {
  switch (overall) {
    case "passing":
      return "border-green-300 bg-green-50 text-green-800";
    case "failing":
      return "border-red-300 bg-red-50 text-red-800";
    case "pending":
      return "border-amber-300 bg-amber-50 text-amber-800";
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
    case "Ready":
      return "border-green-300 bg-green-50 text-green-800";
    case "NeedsAcknowledgement":
      return "border-amber-300 bg-amber-50 text-amber-800";
    case "Blocked":
      return "border-red-300 bg-red-50 text-red-800";
    default:
      return "border-muted-foreground/20 bg-muted/30 text-muted-foreground";
  }
}
function mergeIcon(tag: string): React.JSX.Element {
  switch (tag) {
    case "Ready":
      return <CheckCircle2 className="size-3" />;
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

function TabButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-card text-foreground"
          : "text-muted-foreground hover:bg-card/50 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
