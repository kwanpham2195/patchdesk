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
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { definedProps } from "../../../domain/defined-props";
import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import {
  deriveConversationThreadEntries,
  type ConversationThreadRow,
} from "../conversation-thread-entries";
import { fingerprintPatchAnchor } from "../../../domain/diff-anchor";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  parseRepoRelativePath,
} from "../../../domain/ids";
import type { PullRequestRef } from "../../../domain/pull-request";
import type { AssigneesSectionActions } from "./assignee-picker";
import type { LabelPickerActions } from "./label-picker";
import { PullRequestMetadataRail } from "./pull-request-metadata-rail";
import type { ReviewerPickerActions } from "./reviewer-picker";

import type {
  CommitDiffResponse,
  DirectSummaryReviewProjection,
  WorkbenchResponse,
} from "../renderer-contracts";
import { Conversation } from "./conversation";
import { DiffWorkbench } from "./diff-workbench";
import type {
  LocalCommentAuthoring,
  LocalCommentLocation,
  PendingReviewComposerActions,
  ReviewInlineAnnotation,
} from "./review-diff-view";
import type { ReviewConversationActions } from "./conversation-thread-card";
import type { PullRequestOverviewMerge } from "./pr-overview-sheet";
import { ReviewNavigator } from "./review-navigator";
import {
  buildAnnotations,
  buildConversationAnnotations,
  buildPendingReviewAnnotations,
  buildReadOnlyConversationAnnotations,
} from "./review-workbench-annotations";
import { ReviewWorkbenchDialogs } from "./review-workbench-dialogs";
import { ReviewWorkbenchHeader } from "./review-workbench-header";
import {
  buildOverview,
  buildOverviewRevision,
  buildRailProps,
} from "./review-workbench-overview";
import { ReviewNavigatorResizeHandle } from "./review-navigator-resize-handle";
import { useCommitDiff } from "../hooks/use-commit-diff";
import { useReviewWorkbenchPosition } from "../hooks/use-review-workbench-position";
import {
  loadReviewViewPreferences,
  saveReviewViewPreferences,
  type ReviewViewPreferences,
} from "../review-view-preferences";
import {
  loadNavigatorWidthPreferences,
  saveNavigatorWidthPreferences,
} from "../navigator-width-preferences";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import type { GitHubReviewEvent } from "../../../domain/pending-review";
import type {
  WorkbenchActiveTab,
  WorkbenchPosition,
  WorkbenchSection,
} from "../lib/screen-restore";

/** The subset of `Conversation`'s props built conditionally, so the
 * `conversationActions` prop is only added (never spread from a conditional
 * empty object) when at least one direct-conversation action is wired. */
type ConversationTabProps = {
  readonly conversationActions?: ReviewConversationActions;
};

/** Direct conversation actions for both `<Conversation>` (the Conversation
 * tab) and the diff view, derived from the same underlying `actions` so
 * Reply/Resolve/Edit/Delete wiring never drifts between the two surfaces;
 * Dismiss is consumed only by the Conversation tab's review summaries.
 * The diff view additionally only wires them when `selectedCommitSha` is
 * unset (viewing the full Review diff, not one commit's slice); the
 * Conversation tab is independent of that selection. */
type DirectConversationActionProps = {
  readonly conversationTabProps: ConversationTabProps;
  readonly diffConversationActions: ReviewConversationActions | undefined;
};
function directConversationActionProps(
  actions: Pick<
    ReviewWorkbenchActions,
    | "setThreadState"
    | "replyToThread"
    | "editComment"
    | "deleteComment"
    | "dismissReview"
  >,
  selectedCommitSha: string | undefined,
): DirectConversationActionProps {
  const hasAnyAction =
    actions.setThreadState !== undefined ||
    actions.replyToThread !== undefined ||
    actions.editComment !== undefined ||
    actions.deleteComment !== undefined ||
    actions.dismissReview !== undefined;
  const wired: ReviewConversationActions = definedProps({
    setThreadState: actions.setThreadState,
    replyToThread: actions.replyToThread,
    editComment: actions.editComment,
    deleteComment: actions.deleteComment,
    dismissReview: actions.dismissReview,
  });
  return {
    // `exactOptionalPropertyTypes` treats `conversationActions={undefined}` as
    // distinct from omitting the prop, so the prop itself is only added here
    // (never spread from a conditional empty-object).
    conversationTabProps: definedProps({
      conversationActions: hasAnyAction ? wired : undefined,
    }),
    diffConversationActions:
      selectedCommitSha === undefined && hasAnyAction ? wired : undefined,
  };
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

const PublishedFeedbackNavigationContext = createContext<
  (() => void) | undefined
>(undefined);

/** Renders the canonical Review projection. Optional work stays in typed slots. */
// ReviewWorkbench renders the whole review screen: the diff view, the
// conversation, and the insights panel all live in this one component.
// Splitting this component into smaller files is scheduled work, not done yet.
// Until that split lands, the file size ratchet blocks this file from growing.
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
  readonly onPositionCommitted?: (state: WorkbenchPosition) => void;
}): React.JSX.Element {
  const terminal = model.review.status !== "open";
  const mergeStatus = terminal
    ? model.review.status === "merged"
      ? "Merged"
      : "Closed"
    : model.mergeReadiness._tag;
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
    actions.pendingReview?.busy === true ||
    actions.directSummary?.busy === true;
  const reportedWritePending = useRef(writePending);
  const reportNavigationStateRef = useRef(actions.reportNavigationState);
  useEffect(() => {
    reportNavigationStateRef.current = actions.reportNavigationState;
    if (reportedWritePending.current === writePending) return;
    reportedWritePending.current = writePending;
    reportNavigationStateRef.current(writePending ? "write_pending" : "clear");
  });

  const [overviewOpen, setOverviewOpen] = useState(
    initialState?.overviewOpen ?? false,
  );
  const [summaryDialogOpen, setSummaryDialogOpen] = useState(false);
  const [navigatorVisible, setNavigatorVisible] = useState(true);
  const [navigatorWidthRem, setNavigatorWidthRem] = useState(
    () => loadNavigatorWidthPreferences().width,
  );
  const handleNavigatorResize = useCallback((widthRem: number) => {
    setNavigatorWidthRem(widthRem);
  }, []);
  const handleNavigatorResizeEnd = useCallback((widthRem: number) => {
    setNavigatorWidthRem(widthRem);
    saveNavigatorWidthPreferences(widthRem);
  }, []);
  // SAFETY: "--review-navigator-width" is a custom property; CSSProperties
  // doesn't declare custom-property keys, but any `--name: string` entry is
  // valid inline-style CSS. It feeds the diff layout's
  // `grid-cols-[var(--review-navigator-width)_...]` rule below.
  const navigatorGridStyle = {
    "--review-navigator-width": `${navigatorWidthRem}rem`,
  } as React.CSSProperties;
  const [preferences, setPreferences] = useState<ReviewViewPreferences>(() =>
    loadReviewViewPreferences(model.session.key.profileId),
  );
  const {
    section,
    activeTab,
    selectedPath,
    activePath,
    setActivePath,
    selectedCommitSha,
    selectedThreadId,
    setSelectedThreadId,
    selectedRange,
    setSelectedRange,
    commitWorkbenchPosition,
    selectSection,
    selectCommit,
  } = useReviewWorkbenchPosition({
    model,
    ...definedProps({ initialState, onPositionCommitted }),
  });
  const feedbackRegionRef = useRef<HTMLDivElement>(null);
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
  const readOnlyConversationAnnotations = useMemo(
    () =>
      buildReadOnlyConversationAnnotations(
        model.fullPatch,
        model.conversation.inline,
      ),
    [model.conversation.inline, model.fullPatch],
  );
  const conversationAnnotations: ReadonlyArray<ReviewInlineAnnotation> =
    useMemo(
      () =>
        buildConversationAnnotations(readOnlyConversationAnnotations, {
          setThreadState: actions.setThreadState,
          replyToThread: actions.replyToThread,
          editComment: actions.editComment,
          deleteComment: actions.deleteComment,
        }),
      [
        actions.deleteComment,
        actions.editComment,
        actions.replyToThread,
        actions.setThreadState,
        readOnlyConversationAnnotations,
      ],
    );
  const pendingReviewAnnotations: ReadonlyArray<ReviewInlineAnnotation> =
    buildPendingReviewAnnotations(model);
  // A pending-review thread is also visible to the thread reader; dedupe
  // lives in `deriveConversationThreadEntries` so the diff and (eventually) a
  // Threads navigator section agree on the same entry list by construction.
  const conversationThreadEntries = deriveConversationThreadEntries(
    conversationAnnotations,
    pendingReviewAnnotations,
  );
  const annotations: ReadonlyArray<ReviewInlineAnnotation> = buildAnnotations(
    findings,
    conversationThreadEntries,
  );
  const commitDiffError = commitDiffState._tag === "Failed";
  const displayedPatch = commitDiff?.patch ?? model.fullPatch;
  const externalPullRequest = pullRequestExternalRef(model);
  const overviewRevision = buildOverviewRevision(model);
  const overview = buildOverview({
    model,
    repository,
    title,
    retainedAnalysis,
    overviewRevision,
    externalPullRequest,
  });
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

  const railProps = buildRailProps({ model, actions, terminal });
  const conversationRail =
    model.pullRequest === undefined ? undefined : (
      <PullRequestMetadataRail {...railProps} />
    );

  return (
    <PublishedFeedbackNavigationContext.Provider value={focusPublishedFeedback}>
      <section
        className="flex min-h-0 flex-1 flex-col"
        aria-label="Review workbench"
      >
        <ReviewWorkbenchHeader
          model={model}
          actions={actions}
          title={title}
          repository={repository}
          checksLabel={checksLabel}
          freshnessLabel={freshnessLabel}
          mergeStatus={mergeStatus}
          hasUpdates={hasUpdates}
          terminal={terminal}
          externalPullRequest={externalPullRequest}
          setOverviewOpen={setOverviewOpen}
          setSummaryDialogOpen={setSummaryDialogOpen}
        />

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
              {...(conversationRail === undefined
                ? {}
                : { rail: conversationRail })}
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
                    navigatorVisible ? "with-navigator" : "collapsed-navigator"
                  }
                  style={navigatorVisible ? navigatorGridStyle : undefined}
                  className={cn(
                    "grid h-full min-h-0 flex-1",
                    navigatorVisible
                      ? "min-[1100px]:grid-cols-[var(--review-navigator-width)_0.75rem_minmax(0,1fr)]"
                      : "grid-cols-1",
                  )}
                >
                  {navigatorVisible ? (
                    <ReviewNavigator
                      patch={model.fullPatch}
                      commits={model.commits}
                      conversationThreadEntries={conversationThreadEntries}
                      section={section}
                      {...(selectedPath === undefined ? {} : { selectedPath })}
                      {...(activePath === undefined ? {} : { activePath })}
                      {...(selectedCommitSha === undefined
                        ? {}
                        : { selectedCommitSha })}
                      {...(selectedThreadId === undefined
                        ? {}
                        : { selectedThreadId })}
                      onSectionChange={selectSection}
                      onFileSelect={(path) => {
                        commitWorkbenchPosition({
                          activeTab: "diff",
                          section: "files",
                          selectedPath: path,
                        });
                        setActivePath(path);
                        setSelectedThreadId(undefined);
                        setSelectedRange(undefined);
                      }}
                      onCommitSelect={selectCommit}
                      onThreadSelect={(row: ConversationThreadRow) => {
                        setSelectedThreadId(row.id);
                        setSelectedRange({
                          start: row.start,
                          end: row.end,
                          side: row.side,
                        });
                        commitWorkbenchPosition({
                          activeTab: "diff",
                          section: "threads",
                          selectedPath: row.path,
                        });
                        setActivePath(row.path);
                      }}
                    />
                  ) : null}
                  {navigatorVisible ? (
                    <ReviewNavigatorResizeHandle
                      widthRem={navigatorWidthRem}
                      onResize={handleNavigatorResize}
                      onResizeEnd={handleNavigatorResizeEnd}
                    />
                  ) : null}
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
                            selectedCommitSha ?? model.revision.reviewedHeadSha
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
                          {...(selectedRange === undefined
                            ? {}
                            : { selectedRange })}
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
                                  localCommentAuthoring: commitCommentAuthoring,
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
                          leadingAction={
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    size="icon-sm"
                                    variant="outline"
                                    onClick={() =>
                                      setNavigatorVisible((visible) => !visible)
                                    }
                                    aria-label={
                                      navigatorVisible
                                        ? "Hide review navigator"
                                        : "Show review navigator"
                                    }
                                    aria-expanded={navigatorVisible}
                                  />
                                }
                              >
                                {navigatorVisible ? (
                                  <PanelLeftClose />
                                ) : (
                                  <PanelLeftOpen />
                                )}
                              </TooltipTrigger>
                              <TooltipContent>
                                {navigatorVisible
                                  ? "Hide review navigator"
                                  : "Show review navigator"}
                              </TooltipContent>
                            </Tooltip>
                          }
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
                      <InlineError className="border-t px-4 py-2">
                        This commit diff could not be loaded.
                      </InlineError>
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

        <ReviewWorkbenchDialogs
          actions={actions}
          overview={overview}
          overviewOpen={overviewOpen}
          setOverviewOpen={setOverviewOpen}
          summaryDialogOpen={summaryDialogOpen}
          setSummaryDialogOpen={setSummaryDialogOpen}
          externalPullRequest={externalPullRequest}
        />
      </section>
    </PublishedFeedbackNavigationContext.Provider>
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
