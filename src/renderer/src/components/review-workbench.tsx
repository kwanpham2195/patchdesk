import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { PullRequestMetadataRail } from "./pull-request-metadata-rail";

import type { WorkbenchResponse } from "../renderer-contracts";
import {
  reviewSourceTitle,
  workbenchPullRequestNumber,
} from "../review-source";
import { Conversation } from "./conversation";
import { DiffWorkbench } from "./diff-workbench";
import { ReviewDiffPane } from "./review-diff-pane";
import type {
  LocalCommentAuthoring,
  LocalCommentLocation,
  ReviewInlineAnnotation,
} from "./review-diff-view";
import type { ReviewConversationActions } from "./conversation-thread-card";
import type { OverviewFocusSection } from "./pr-overview-sheet";
import {
  ReviewNavigator,
  type ReviewNavigatorSection,
} from "./review-navigator";
import {
  annotationsInPatch,
  buildAnnotations,
  buildConversationAnnotations,
  buildLocalNoteAnnotations,
  buildPendingReviewAnnotations,
  buildReadOnlyConversationAnnotations,
  type MappedFinding,
} from "./review-workbench-annotations";
import type {
  ReviewWorkbenchActions,
  ReviewWorkbenchInitialState,
  ReviewWorkbenchSlots,
} from "./review-workbench-contracts";
import {
  ReviewWorkbenchFindingNavigationContext,
  type FindingFocusRequest,
} from "./review-workbench-finding-navigation";
import type { InsightRunDialogType } from "./insight-run-dialog";
import { countFindingsByPath } from "../review-finding-counts";
import { ReviewWorkbenchDialogs } from "./review-workbench-dialogs";
import { ReviewWorkbenchHeader } from "./review-workbench-header";
import { revisionFreshnessLabel } from "../rail-freshness";
import {
  buildOverview,
  buildOverviewRevision,
  buildRailProps,
} from "./review-workbench-overview";
import { ReviewNavigatorResizeHandle } from "./review-navigator-resize-handle";
import { useCommitDiff } from "../hooks/use-commit-diff";
import { useSinceReviewMode } from "../hooks/use-since-review-mode";
import { useReviewScopeFilter } from "../hooks/use-review-scope-filter";
import type { ViewedFilesControls } from "../hooks/use-viewed-files";
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
import { RelativeTime } from "./relative-time";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import type {
  WorkbenchActiveTab,
  WorkbenchPosition,
} from "../lib/screen-restore";

/** What the Diff tab shows in place of a diff, from both the tab itself and
 * the commit-slice pane below it. */
const NO_PATCH_AVAILABLE = "No patch is available for this Review.";

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
  const prNumber = workbenchPullRequestNumber(model.session.key.source);
  if (prNumber === undefined) return undefined;
  const source = model.pullRequest?.ref ?? {
    host: model.session.key.host,
    owner: model.session.key.owner,
    repo: model.session.key.repo,
    number: prNumber,
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

function createHeadSideCommentAuthoring(
  base: LocalCommentAuthoring | undefined,
  fullPatch: string,
): LocalCommentAuthoring | undefined {
  if (base?.enabled !== true) return undefined;
  const files = parseUnifiedPatch(fullPatch);
  // This diff's new side is the pull request head, so a new-side line the full patch shows is the same GitHub coordinate; its old side is not the base.
  const fullPatchAnchor = (location: LocalCommentLocation) => {
    const path = parseRepoRelativePath(location.path);
    if (location.side !== "new" || path._tag === "err") return undefined;
    const mapped = mapFindingLocation(files, {
      file: location.path,
      lineStart: location.startLine,
      lineEnd: location.line,
      diffSide: "new",
    });
    return mapped.mappingStatus === "mapped" && mapped.path === location.path
      ? {
          path: path.value,
          startLine: location.startLine,
          line: location.line,
          side: location.side,
        }
      : undefined;
  };
  return {
    enabled: true,
    ...definedProps({ kind: base.kind }),
    canAuthor: (location) => fullPatchAnchor(location) !== undefined,
    onSelectionChange: (location) => {
      if (fullPatchAnchor(location) !== undefined)
        base.onSelectionChange?.(location);
    },
    onSave: async (input) => {
      const anchor = fullPatchAnchor(input);
      if (anchor === undefined) return;
      return base.onSave({
        ...input,
        ...definedProps({
          fingerprint: fingerprintPatchAnchor(fullPatch, anchor),
        }),
      });
    },
  };
}

/** The workbench prop contracts, re-exported for this component's callers. */
export type {
  ReviewWorkbenchActions,
  ReviewWorkbenchSlots,
  ReviewWorkbenchInitialState,
} from "./review-workbench-contracts";

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
  viewedFiles,
}: {
  readonly model: WorkbenchResponse;
  readonly actions: ReviewWorkbenchActions;
  /** Saved Viewed marks for the full Review diff; a commit slice keeps its own. */
  readonly viewedFiles?: ViewedFilesControls;
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
  const freshnessLabel = revisionFreshnessLabel(model.revision.freshness);
  const checksLabel =
    model.checks.overall === "passing"
      ? "Passing"
      : model.checks.overall === "failing"
        ? "Failing"
        : model.checks.overall === "pending"
          ? "In progress"
          : model.checks.overall === "skipped"
            ? "Skipped"
            : model.checks.overall === "none"
              ? "No checks"
              : "Unknown";
  const repository = `${model.session.key.owner}/${model.session.key.repo}`;
  const title =
    model.pullRequest?.title ?? reviewSourceTitle(model.session.key.source);
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
  const [overviewFocusSection, setOverviewFocusSection] = useState<
    OverviewFocusSection | undefined
  >(undefined);
  const openOverview = useCallback((section?: OverviewFocusSection): void => {
    setOverviewFocusSection(section);
    setOverviewOpen(true);
  }, []);
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
  const { scopeFilteredPaths, scopeFilter, clearScopeBucket } =
    useReviewScopeFilter({
      fullPatch: model.fullPatch,
      scope: model.scope,
      selectedPath,
      commitSliceActive: selectedCommitSha !== undefined,
      commitWorkbenchPosition,
      selectSection,
      setActivePath,
    });
  // A Scope bucket and a commit slice are mutually exclusive readings of the
  // diff: choosing a bucket already drops the commit, so entering a commit
  // drops the bucket rather than leaving a filtered tree beside a full slice.
  // Both entry points land here because the Commits section auto-selects a
  // commit when it opens with none.
  const selectNavigatorSection = useCallback(
    (next: ReviewNavigatorSection): void => {
      if (next === "commits") clearScopeBucket();
      selectSection(next);
    },
    [clearScopeBucket, selectSection],
  );
  const selectCommitSlice = useCallback(
    (sha: string): void => {
      clearScopeBucket();
      selectCommit(sha);
    },
    [clearScopeBucket, selectCommit],
  );
  const retainedAnalysis = model.insights.analysis.retained;
  const analysisIsCurrent =
    model.insights.analysis.status === "current" &&
    retainedAnalysis?.sessionId === model.session.id &&
    retainedAnalysis.headSha === model.revision.reviewedHeadSha;
  const findings = useMemo(
    () =>
      analysisIsCurrent
        ? retainedAnalysis.value.findings.filter(
            (finding) => finding.mappingStatus === "mapped",
          )
        : [],
    [analysisIsCurrent, retainedAnalysis],
  );
  const findingCountsByPath = useMemo(
    () => countFindingsByPath(findings),
    [findings],
  );
  const [findingFocusRequest, setFindingFocusRequest] = useState<
    FindingFocusRequest | undefined
  >(undefined);
  const findingFocusSequence = useRef(0);
  const openFindingInDiff = useCallback(
    (finding: MappedFinding): void => {
      if (
        finding.file === undefined ||
        finding.lineStart === undefined ||
        finding.diffSide === undefined
      )
        return;
      setSelectedThreadId(undefined);
      setSelectedRange({
        start: finding.lineStart,
        end: finding.lineEnd ?? finding.lineStart,
        side: finding.diffSide,
      });
      commitWorkbenchPosition({
        activeTab: "diff",
        section: "files",
        selectedPath: finding.file,
      });
      setActivePath(finding.file);
    },
    [
      commitWorkbenchPosition,
      setActivePath,
      setSelectedRange,
      setSelectedThreadId,
    ],
  );
  const openFindingInAnalysis = useCallback(
    (findingId: string): void => {
      findingFocusSequence.current += 1;
      setFindingFocusRequest({
        findingId,
        token: findingFocusSequence.current,
      });
      commitWorkbenchPosition({ activeTab: "insights", section: "files" });
    },
    [commitWorkbenchPosition],
  );
  // The readiness card lists every counted finding; the reader lands on the first.
  const reviewFindings = useCallback(
    (findingIds: ReadonlyArray<string>): void => {
      const first = findingIds[0];
      if (first !== undefined) openFindingInAnalysis(first);
    },
    [openFindingInAnalysis],
  );
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
  const sinceReview = useSinceReviewMode({
    model,
    commitSliceActive: selectedCommitSha !== undefined,
    loadSinceReviewDiff: actions.loadSinceReviewDiff,
  });
  const sincePatch =
    sinceReview.state._tag === "Ready" ? sinceReview.state.patch : undefined;
  // A Brief's file stands for the whole represented revision, so every narrower view gives way to the full diff.
  const leaveSinceReview = sinceReview.control?.onChange;
  const openFileInDiff = useCallback(
    (path: string): void => {
      clearScopeBucket();
      leaveSinceReview?.(false);
      selectSection("files");
      setSelectedThreadId(undefined);
      setSelectedRange(undefined);
      commitWorkbenchPosition({
        activeTab: "diff",
        section: "files",
        selectedPath: path,
      });
      setActivePath(path);
    },
    [
      clearScopeBucket,
      commitWorkbenchPosition,
      leaveSinceReview,
      selectSection,
      setActivePath,
      setSelectedRange,
      setSelectedThreadId,
    ],
  );
  // The Insights slot unmounts while the Diff tab shows, so its reader choice lives here, keyed by session.
  const [rememberedInsight, setRememberedInsight] = useState<
    | { readonly sessionId: string; readonly insight: InsightRunDialogType }
    | undefined
  >(undefined);
  const sessionId = model.session.id;
  const rememberInsight = useCallback(
    (insight: InsightRunDialogType): void =>
      setRememberedInsight({ sessionId, insight }),
    [sessionId],
  );
  const lastInsight =
    rememberedInsight?.sessionId === sessionId
      ? rememberedInsight.insight
      : undefined;
  const findingNavigation = useMemo(
    () => ({
      openFindingInDiff,
      openFileInDiff,
      findingFocusRequest,
      lastInsight,
      rememberInsight,
    }),
    [
      findingFocusRequest,
      lastInsight,
      openFileInDiff,
      openFindingInDiff,
      rememberInsight,
    ],
  );
  // A commit slice and the since-review diff both show a narrower patch than the Review, so comments map back onto the full patch.
  const narrowedDiff =
    selectedCommitSha !== undefined || sincePatch !== undefined;
  const commitDiff =
    commitDiffState._tag === "Ready" ? commitDiffState.projection : undefined;
  // Only a diff whose new side is the represented head can anchor comments on GitHub.
  const headSideDiff =
    selectedCommitSha === undefined
      ? sincePatch !== undefined
      : selectedCommitSha === model.revision.reviewedHeadSha;
  const commentsUnavailableInSlice =
    selectedCommitSha !== undefined &&
    !headSideDiff &&
    actions.localCommentAuthoring?.enabled === true;
  const commitCommentAuthoring = useMemo(
    () =>
      !headSideDiff || model.fullPatch === undefined
        ? undefined
        : createHeadSideCommentAuthoring(
            actions.localCommentAuthoring,
            model.fullPatch,
          ),
    [actions.localCommentAuthoring, headSideDiff, model.fullPatch],
  );
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
  // The builder reads only the pending-review projection, so that is the
  // dependency: `model` as a whole would also change for a refreshed check or
  // a new comment, and every new array identity here recomputes
  // `annotationKey` in `use-review-diff-model.ts`.
  const pendingReview = model.pendingReview;
  const pendingReviewAnnotations: ReadonlyArray<ReviewInlineAnnotation> =
    useMemo(
      () => buildPendingReviewAnnotations({ pendingReview }),
      [pendingReview],
    );
  // A pending-review thread is also visible to the thread reader; dedupe
  // lives in `deriveConversationThreadEntries` so the diff and (eventually) a
  // Threads navigator section agree on the same entry list by construction.
  const conversationThreadEntries = useMemo(
    () =>
      deriveConversationThreadEntries(
        conversationAnnotations,
        pendingReviewAnnotations,
      ),
    [conversationAnnotations, pendingReviewAnnotations],
  );
  const { localDrafts, session } = model;
  const annotations: ReadonlyArray<ReviewInlineAnnotation> = useMemo(
    () => [
      ...buildAnnotations(findings, conversationThreadEntries),
      ...buildLocalNoteAnnotations(
        { localDrafts, session },
        actions.localNotes,
      ),
    ],
    [
      actions.localNotes,
      conversationThreadEntries,
      findings,
      localDrafts,
      session,
    ],
  );
  const sinceAnnotations = useMemo(
    () =>
      sincePatch === undefined
        ? undefined
        : annotationsInPatch(annotations, sincePatch),
    [annotations, sincePatch],
  );
  const sincePaths = useMemo(
    () =>
      sincePatch === undefined
        ? undefined
        : new Set(parseUnifiedPatch(sincePatch).map((file) => file.newPath)),
    [sincePatch],
  );
  // The full Review's selection drives the since-review diff only while that file is still in it.
  const diffSelectedPath =
    selectedPath === undefined ||
    selectedCommitSha !== undefined ||
    sincePaths?.has(selectedPath) === false
      ? undefined
      : selectedPath;
  const commitDiffError = commitDiffState._tag === "Failed";
  const displayedPatch = commitDiff?.patch ?? sincePatch ?? model.fullPatch;
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
          subtitle: (
            <>
              {selectedCommit.author} · {selectedCommit.sha.slice(0, 8)} ·{" "}
              <RelativeTime iso={selectedCommit.authoredAt} /> ·{" "}
              {commitDiff.position} of {commitDiff.total} ·{" "}
              {commitDiff.fileCount} files · +{commitDiff.additions}/-
              {commitDiff.deletions}
              {commentsUnavailableInSlice ? (
                <span role="note" className="block">
                  Comments are available on the latest commit or All files.
                </span>
              ) : null}
            </>
          ),
        };

  const { conversationTabProps, diffConversationActions } =
    directConversationActionProps(actions, selectedCommitSha);

  const railProps = buildRailProps({ model, actions, terminal });
  const conversationRail =
    model.pullRequest === undefined ? undefined : (
      <PullRequestMetadataRail {...railProps} />
    );

  return (
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
        openOverview={openOverview}
        setSummaryDialogOpen={setSummaryDialogOpen}
      />

      <div
        className="flex shrink-0 items-center border-b px-4 py-1"
        data-review-workbench-tabs
      >
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            // SAFETY: every TabsTrigger below is keyed by a WorkbenchActiveTab
            // literal, so Base UI's reported value can only ever be one of those.
            const nextTab = value as WorkbenchActiveTab;
            // Insights always opens on files; the other tabs keep the section.
            commitWorkbenchPosition(
              nextTab === "insights"
                ? { activeTab: nextTab, section: "files" }
                : { activeTab: nextTab, section },
            );
          }}
        >
          <TabsList variant="ghost">
            {model.session.key.source.kind === "pull_request" ? (
              <TabsTrigger value="conversation">Conversation</TabsTrigger>
            ) : null}
            <TabsTrigger value="diff">Diff</TabsTrigger>
            <TabsTrigger value="insights">Insights</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div
        className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden"
        data-review-workbench-content
      >
        {activeTab === "conversation" ? (
          <Conversation
            conversation={model.conversation}
            profileId={model.session.key.profileId}
            {...definedProps({
              pullRequest: externalPullRequest,
              lastLooked: model.review.lastLooked,
            })}
            {...conversationTabProps}
            {...(conversationRail === undefined
              ? {}
              : { rail: conversationRail })}
          />
        ) : activeTab === "diff" ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            {model.fullPatch === undefined ? (
              <div className="p-6 text-sm text-muted-foreground">
                {NO_PATCH_AVAILABLE}
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
                    patch={sincePatch ?? model.fullPatch}
                    commits={model.commits}
                    conversationThreadEntries={conversationThreadEntries}
                    findingCountsByPath={findingCountsByPath}
                    section={section}
                    {...definedProps({
                      visiblePaths: scopeFilteredPaths,
                      selectedPath,
                      activePath,
                      selectedCommitSha,
                      selectedThreadId,
                      lastLooked: model.review.lastLooked,
                    })}
                    onSectionChange={selectNavigatorSection}
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
                    onCommitSelect={selectCommitSlice}
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
                <ReviewDiffPane model={model}>
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
                      {NO_PATCH_AVAILABLE}
                    </p>
                  ) : (
                    <>
                      <DiffWorkbench
                        key={
                          selectedCommitSha ??
                          (sincePatch === undefined
                            ? model.revision.reviewedHeadSha
                            : `since-${sinceReview.baseSha}`)
                        }
                        patch={displayedPatch}
                        {...definedProps({ sinceReview: sinceReview.control })}
                        {...(narrowedDiff
                          ? {}
                          : {
                              sourceSession: {
                                profileId: model.session.key.profileId,
                                sessionId: model.session.id,
                              },
                            })}
                        {...(diffSelectedPath === undefined
                          ? {}
                          : {
                              controlledSelectedPath: diffSelectedPath,
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
                          ? {
                              annotations: sinceAnnotations ?? annotations,
                              findingCountsByPath,
                              onOpenFindingInAnalysis: openFindingInAnalysis,
                            }
                          : {})}
                        {...(selectedRange === undefined
                          ? {}
                          : { selectedRange })}
                        {...definedProps({
                          viewedFiles: narrowedDiff ? undefined : viewedFiles,
                        })}
                        {...(scopeFilteredPaths === undefined
                          ? {}
                          : { visiblePaths: scopeFilteredPaths })}
                        {...(scopeFilter === undefined ? {} : { scopeFilter })}
                        {...(!narrowedDiff
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
                        bodyContext={definedProps({
                          pullRequest: externalPullRequest,
                          profileId: model.session.key.profileId,
                        })}
                        hideFileNavigation
                        leadingAction={
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
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
                  {sinceReview.state._tag === "Failed" ? (
                    <InlineError className="border-t px-4 py-2">
                      The diff since your review could not be loaded.
                    </InlineError>
                  ) : null}
                </ReviewDiffPane>
              </div>
            )}
          </div>
        ) : (
          <div
            data-review-workbench-insights
            className="min-h-0 flex-1 overflow-hidden p-4"
          >
            <ReviewWorkbenchFindingNavigationContext.Provider
              value={findingNavigation}
            >
              {slots.insights}
            </ReviewWorkbenchFindingNavigationContext.Provider>
          </div>
        )}
      </div>

      <ReviewWorkbenchDialogs
        actions={actions}
        overview={overview}
        overviewOpen={overviewOpen}
        overviewFocusSection={overviewFocusSection}
        setOverviewOpen={setOverviewOpen}
        onReviewFindings={reviewFindings}
        summaryDialogOpen={summaryDialogOpen}
        setSummaryDialogOpen={setSummaryDialogOpen}
        externalPullRequest={externalPullRequest}
      />
    </section>
  );
}
