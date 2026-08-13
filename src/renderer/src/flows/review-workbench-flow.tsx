import { useCallback, useEffect, useRef, useState } from "react";

import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitHubThreadId,
  parsePullRequestNumber,
  parseRepoRelativePath,
  type GitHubThreadId,
} from "../../../domain/ids";
import type { RecentReviewWrite } from "../../../services/review-refresh-service";
import { renderAnalysisReviewSummary } from "../../../services/analysis-review-body";
import {
  parseReviewBatch,
  type ReviewAnchor,
} from "../../../domain/review-batch";
import { PatchdeskApiError, requestJson } from "../api-client";
import { AnalysisReader } from "../components/analysis-reader";
import { NarrativeWalkthrough } from "../components/narrative-walkthrough";
import {
  InsightRunDialog,
  type InsightRunDialogType,
} from "../components/insight-run-dialog";
import type {
  InsightProvider,
  InsightReasoning,
} from "../../../domain/insight-provider";
import {
  loadInsightRunPreference,
  saveInsightRunPreference,
  type InsightRunPreference,
} from "../insight-run-preferences";
import {
  ReviewWorkbench,
  type ReviewWorkbenchInitialState,
  usePublishedFeedbackNavigation,
  useReviewWorkbenchNavigation,
} from "../components/review-workbench";
import type { ReviewNavigatorSection } from "../components/review-navigator";
import type { PullRequestOverviewMerge } from "../components/pr-overview-sheet";
import type { LocalCommentAuthoring } from "../components/review-diff-view";
import type { PendingReviewComposerActions } from "../components/review-diff-view";
import type { ReviewBatchPanelActions } from "../components/review-batch-panel";
import { ReviewDraftDock } from "../components/review-draft-dock";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import type { InsightFailureCategory } from "../../../domain/insight-record";
import type { PullRequestRef } from "../../../domain/pull-request";
import {
  parseCommitDiffResponse,
  parseDirectSummaryReviewResponse,
  parseInsightProviderCatalog,
  parsePendingReviewProjection,
  parsePublicationPreview,
  parseReviewBatchProjection,
  parseWorkbenchResponse,
  type CommitDiffResponse,
  type DirectSummaryReviewProjection,
  type PendingReviewProjection,
} from "../renderer-contracts";
import { useInsightRun } from "../hooks/use-insight-run";
import {
  openPullRequestExternalUrl,
  pullRequestPageUrl,
} from "../external-links";
import { projectReadOnlyConversationAnnotations } from "../inline-conversation-mapping";

function boundedPendingReviewError(cause: unknown): string {
  if (cause instanceof PatchdeskApiError) {
    if (
      cause.kind === "outcome_unknown" ||
      cause.kind === "ambiguous_write" ||
      cause.kind === "timeout"
    )
      return "GitHub could not confirm the submission. Check GitHub again before trying again.";
    if (cause.kind === "pending_review")
      return "A pending review already exists. Refresh, then finish or discard that review before submitting a summary.";
    if (cause.kind === "stale_head")
      return "The pull request changed. Refresh, then finish the review.";
    if (cause.kind === "rejected" || cause.kind === "github_rejected")
      return "GitHub rejected the submission.";
    if (
      cause.kind === "no_pending_review" ||
      cause.kind === "pending_review_locked"
    )
      return "The pending review changed. Check GitHub again or refresh.";
  }
  return "Patchdesk could not finish this review. Check GitHub again or refresh.";
}

function boundedPendingReviewRecoveryError(cause: unknown): string {
  if (cause instanceof PatchdeskApiError) {
    if (cause.kind === "review_write_in_progress") {
      return "Another Review operation is still finishing. Check GitHub again in a moment.";
    }
    if (
      cause.kind === "timeout" ||
      cause.kind === "unavailable" ||
      cause.kind === "outcome_unknown"
    ) {
      return "Patchdesk could not check GitHub right now. Try again.";
    }
  }
  return "Patchdesk could not reconcile this pending review. Try again or refresh.";
}

function boundedDirectSummaryError(cause: unknown): string {
  if (cause instanceof PatchdeskApiError) {
    if (
      cause.kind === "outcome_unknown" ||
      cause.kind === "ambiguous_write" ||
      cause.kind === "timeout"
    )
      return "GitHub could not confirm the submission. Check GitHub again before trying again.";
    if (cause.kind === "pending_review")
      return "A pending review already exists. Refresh, then finish or discard that review before submitting a summary.";
    if (cause.kind === "self_approval_not_allowed")
      return "You can’t approve your own pull request. Choose Comment or ask another reviewer to approve it.";
    if (cause.kind === "stale_head")
      return "The pull request changed. Refresh before submitting a review summary.";
    if (cause.kind === "rejected" || cause.kind === "github_rejected")
      return "GitHub rejected the review summary.";
  }
  return "Patchdesk could not submit this review summary. Check GitHub again or refresh.";
}

/**
 * The exact pending-review thread ids a projection confirms. Only ids that
 * parse as GitHub thread ids are journaled: detection matches real remote
 * threads, and an unparseable id would silently break the detector request.
 */
function threadIdsOf(
  projection: PendingReviewProjection | undefined,
): ReadonlyArray<GitHubThreadId> {
  if (projection === undefined || projection.state !== "pending") return [];
  return projection.review.comments.flatMap((comment) => {
    const parsed = parseGitHubThreadId(comment.threadId);
    return parsed._tag === "ok" ? [parsed.value] : [];
  });
}

function pullRequestExternalRef(
  model: WorkbenchResponse,
): PullRequestRef | undefined {
  const host = parseGitHubHost(model.session.key.host);
  const owner = parseGitHubOwner(model.session.key.owner);
  const repo = parseGitHubRepoName(model.session.key.repo);
  const number = parsePullRequestNumber(model.session.key.prNumber);
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

export type ReviewWorkbenchPatch = Omit<
  Partial<WorkbenchResponse>,
  "insights"
> & {
  readonly insights?: Partial<WorkbenchResponse["insights"]>;
};

export type ReviewWorkbenchFlowProps = {
  readonly workbench: WorkbenchResponse;
  readonly initialSection?: "diff" | "checks";
  readonly initialUiState?: ReviewWorkbenchInitialState;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
  readonly onNavigationStateChange: (
    state: "clear" | "dirty_draft" | "write_pending",
  ) => void;
  readonly onNavigate: (section: "diff" | "checks") => void;
  /** Reports in-screen position changes so a reload can restore them. */
  readonly onUiStateChange?: (state: {
    readonly activeTab: "conversation" | "diff" | "insights";
    readonly section: ReviewNavigatorSection;
    readonly selectedPath?: string;
  }) => void;
};

/** Owns loopback calls and replacement of the one canonical Review projection. */
export function ReviewWorkbenchFlow({
  workbench,
  initialSection,
  initialUiState,
  onWorkbenchReplace,
  onWorkbenchPatch,
  onNavigationStateChange,
  onNavigate,
  onUiStateChange,
}: ReviewWorkbenchFlowProps): React.JSX.Element {
  void initialSection;
  void onNavigate;
  // Detector cadence: one initial check when an open Review becomes visible,
  // then at most every 90 seconds while visible and idle, plus one debounced
  // check after the app regains focus. Direct conversation receipts only
  // append their typed journal; they never trigger or reset a detection pass.
  const DETECT_INTERVAL_MS = 90_000;
  const FOCUS_DETECT_DEBOUNCE_MS = 1_500;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [autoOpenPublication, setAutoOpenPublication] = useState(false);
  const [selectedRepairAnchor, setSelectedRepairAnchor] = useState<
    ReviewAnchor | undefined
  >();
  // Typed comment/thread-state writes made by this window since the last
  // projection replace. The detector excludes them so own writes never read as
  // remote updates; cleared once a refresh/reload re-baselines the snapshot.
  const [recentWrites, setRecentWrites] = useState<
    ReadonlyArray<RecentReviewWrite>
  >([]);
  const replaceWorkbench = useCallback(
    (next: WorkbenchResponse): void => {
      setRecentWrites([]);
      onWorkbenchReplace(next);
    },
    [onWorkbenchReplace],
  );
  // Freshness value the projection had before detection patched it stale, so a
  // later cleared flag can restore writes instead of leaving them blocked.
  const [detectedStaleFreshness, setDetectedStaleFreshness] = useState<
    "fresh" | "not_refreshed" | "unavailable" | undefined
  >(undefined);
  // Latest values live in refs so scheduled detector work uses the current
  // journal and projection without recreating the interval on every write.
  const workbenchRef = useRef(workbench);
  workbenchRef.current = workbench;
  const recentWritesRef = useRef(recentWrites);
  recentWritesRef.current = recentWrites;
  const detectedStaleFreshnessRef = useRef(detectedStaleFreshness);
  detectedStaleFreshnessRef.current = detectedStaleFreshness;
  const refreshingRef = useRef(refreshing);
  refreshingRef.current = refreshing;
  const snapshotKeyRef = useRef(snapshotKey(workbench));
  const generationRef = useRef(0);
  const detectInFlightRef = useRef(false);
  // Direct commands may legitimately overlap; detection pauses only while the
  // count is non-zero, so one completion cannot resume it mid-command.
  const commandInFlightCountRef = useRef(0);
  const focusTimerRef = useRef<number | undefined>(undefined);
  // App passes onWorkbenchPatch as an inline function, so its identity changes
  // on every parent render. Detector work must read the latest callback through
  // a ref instead of depending on the prop, or any parent render would restart
  // the scheduling effect and immediately send another request.
  const onWorkbenchPatchRef = useRef(onWorkbenchPatch);
  onWorkbenchPatchRef.current = onWorkbenchPatch;
  // Synchronous count of explicit refreshes whose network request is still
  // pending. Detection must not start while any refresh (toolbar or
  // post-publication) is in flight; the toolbar-only React state cannot be the
  // protocol guard because publication refresh never sets it.
  const refreshInFlightCountRef = useRef(0);
  // Each replaced projection gets a new observation generation; a detector
  // response that began under an older generation can never write stale
  // freshness into the newly refreshed Review.
  useEffect(() => {
    const key = snapshotKey(workbench);
    if (key !== snapshotKeyRef.current) {
      snapshotKeyRef.current = key;
      generationRef.current += 1;
    }
  }, [workbench]);
  const runDetect = useCallback(async (): Promise<void> => {
    const wb = workbenchRef.current;
    if (wb.review.status !== "open") return;
    if (document.visibilityState !== "visible") return;
    if (
      detectInFlightRef.current ||
      commandInFlightCountRef.current > 0 ||
      refreshInFlightCountRef.current > 0
    )
      return;
    detectInFlightRef.current = true;
    const generation = generationRef.current;
    const key = snapshotKey(wb);
    try {
      const journal = recentWritesRef.current;
      const value = await requestJson("/v1/reviews/detect-updates", {
        method: "POST",
        body: {
          profileId: wb.session.key.profileId,
          reviewId: wb.review.id,
          ...(journal.length === 0 ? {} : { recentWrites: journal }),
        },
      });
      // A detector that began before an explicit refresh replaced the
      // projection must not reapply its result to the new snapshot.
      const current = workbenchRef.current;
      if (generationRef.current !== generation || snapshotKey(current) !== key)
        return;
      const observation = isReviewObservation(value);
      if (observation !== undefined) {
        if (observation._tag === "Reconciled") {
          const next = parseWorkbenchResponse(observation.projection);
          if (
            next !== undefined &&
            next.review.id === current.review.id &&
            next.session.id === current.session.id &&
            next.revision.reviewedHeadSha === current.revision.reviewedHeadSha
          ) {
            replaceWorkbench(next);
            setDetectedStaleFreshness(undefined);
          }
        } else if (observation._tag === "RevisionChanged") {
          onWorkbenchPatchRef.current({
            revision: { ...current.revision, freshness: "updates_available" },
          });
        } else if (observation._tag === "Unavailable") {
          onWorkbenchPatchRef.current({
            revision: { ...current.revision, freshness: "unavailable" },
          });
        } else if (observation._tag === "Terminal") {
          onWorkbenchPatchRef.current({
            review: { ...current.review, status: observation.status },
          });
        }
        return;
      }
      if (isDetection(value) && value.updatesAvailable) {
        // A stale value is written only on the transition into updates_available:
        // re-writing the identical freshness on an already-stale projection is
        // what turned an App render into another detector request.
        if (current.revision.freshness !== "updates_available") {
          if (detectedStaleFreshnessRef.current === undefined)
            setDetectedStaleFreshness(current.revision.freshness);
          onWorkbenchPatchRef.current({
            revision: { ...current.revision, freshness: "updates_available" },
          });
        }
      } else if (
        isDetection(value) &&
        !value.updatesAvailable &&
        current.revision.freshness === "updates_available"
      ) {
        // Detection is authoritative: a cleared flag means the stale patch was
        // a phantom (or the remote caught up), so restore writes.
        onWorkbenchPatchRef.current({
          revision: {
            ...current.revision,
            freshness: detectedStaleFreshnessRef.current ?? "fresh",
          },
        });
        setDetectedStaleFreshness(undefined);
      }
    } catch {
      // Detection is advisory and never replaces the represented snapshot.
    } finally {
      detectInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void runDetect();
    if (workbench.review.status !== "open") return undefined;
    const timer = window.setInterval(() => {
      // If the interval fires first, the pending focus check is dropped so
      // only one request runs; the in-flight guard covers the reverse order.
      if (focusTimerRef.current !== undefined) {
        window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = undefined;
      }
      void runDetect();
    }, DETECT_INTERVAL_MS);
    // One shared debounced scheduler: an app return commonly emits both
    // visibilitychange and focus, and the product contract is a single
    // delayed observation, not one per browser event.
    const scheduleFocusDetect = (): void => {
      if (document.visibilityState !== "visible") return;
      if (focusTimerRef.current !== undefined)
        window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = window.setTimeout(() => {
        focusTimerRef.current = undefined;
        void runDetect();
      }, FOCUS_DETECT_DEBOUNCE_MS);
    };
    const onFocus = (): void => scheduleFocusDetect();
    const onVisibility = (): void => scheduleFocusDetect();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (focusTimerRef.current !== undefined)
        window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = undefined;
    };
  }, [runDetect, workbench.review.status]);

  // Every explicit refresh invalidates in-flight detector work before the
  // network request begins: a stale detector response must never reapply
  // freshness into the newly replaced projection.
  const requestRefresh = useCallback(async (): Promise<WorkbenchResponse> => {
    const wb = workbenchRef.current;
    generationRef.current += 1;
    // Generation rejects detector responses that began before refresh; the
    // in-flight count additionally stops NEW detector work for the whole
    // network lifetime, including the post-publication path that never sets
    // the toolbar refreshing state.
    refreshInFlightCountRef.current += 1;
    try {
      const value = await requestJson("/v1/reviews/refresh", {
        method: "POST",
        body: {
          profileId: wb.session.key.profileId,
          reviewId: wb.review.id,
        },
      });
      const parsed = parseWorkbenchResponse(value);
      if (parsed === undefined)
        throw new Error("Invalid Review refresh response");
      setDetectedStaleFreshness(undefined);
      replaceWorkbench(parsed);
      return parsed;
    } finally {
      refreshInFlightCountRef.current -= 1;
    }
  }, [replaceWorkbench]);

  const refresh = useCallback(async (): Promise<void> => {
    const wb = workbenchRef.current;
    if (wb.review.status !== "open" || refreshingRef.current) return;
    setRefreshing(true);
    setRefreshError(false);
    try {
      await requestRefresh();
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  }, [requestRefresh]);

  const refreshConfirmedPublication = useCallback(async (): Promise<void> => {
    if (workbench.review.status !== "open") return;
    // The shared helper invalidates in-flight detectors before its request;
    // the caller keeps its own bounded error presentation.
    await requestRefresh();
  }, [requestRefresh, workbench.review.status]);

  const runDirectCommand = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T> => {
      commandInFlightCountRef.current += 1;
      try {
        return await operation();
      } finally {
        commandInFlightCountRef.current -= 1;
      }
    },
    [],
  );
  const observeConfirmedDirectSummary = useCallback(
    async (reviewId: string): Promise<void> => {
      const current = workbenchRef.current;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const key = snapshotKey(current);
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/detect-updates", {
          method: "POST",
          body: {
            profileId: current.session.key.profileId,
            reviewId: current.review.id,
            recentWrites: [{ _tag: "DirectSummaryReview", reviewId }],
          },
        }),
      );
      const latest = workbenchRef.current;
      if (generationRef.current !== generation || snapshotKey(latest) !== key)
        return;
      const observation = isReviewObservation(value);
      if (observation?._tag === "Reconciled") {
        const next = parseWorkbenchResponse(observation.projection);
        if (
          next !== undefined &&
          next.review.id === latest.review.id &&
          next.session.id === latest.session.id &&
          next.revision.reviewedHeadSha === latest.revision.reviewedHeadSha
        ) {
          replaceWorkbench(next);
          setDetectedStaleFreshness(undefined);
        }
        return;
      }
      if (observation?._tag === "RevisionChanged") {
        onWorkbenchPatchRef.current({
          revision: { ...latest.revision, freshness: "updates_available" },
        });
      } else if (observation?._tag === "Unavailable") {
        onWorkbenchPatchRef.current({
          revision: { ...latest.revision, freshness: "unavailable" },
        });
      } else if (observation?._tag === "Terminal") {
        onWorkbenchPatchRef.current({
          review: { ...latest.review, status: observation.status },
        });
      }
    },
    [replaceWorkbench, runDirectCommand],
  );
  const saveInlineComment = useCallback(
    async (
      input: Parameters<NonNullable<LocalCommentAuthoring["onSave"]>>[0],
    ): Promise<{ readonly commentId: string } | void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot accept comments.");
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/inline-conversations/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: {
              _tag: "CreateComment",
              expected: {
                sessionId: workbench.session.id,
                headSha: workbench.revision.reviewedHeadSha,
                patchHash,
              },
              anchor: {
                path: input.path,
                startLine: input.startLine,
                line: input.line,
                side: input.side,
              },
              body: input.body,
            },
          },
        }),
      );
      const receipt = parseDirectConversationReceipt(value);
      if (receipt?._tag === "CommentCreated") {
        setRecentWrites((current) => [
          ...current,
          {
            _tag: "Comment",
            commentId: receipt.commentId,
            ...(receipt.reviewId === undefined
              ? {}
              : { reviewId: receipt.reviewId }),
          },
        ]);
        return { commentId: receipt.commentId };
      }
      // A malformed success envelope is a bounded command failure: it must not
      // confirm a local mutation or journal a write that never verified.
      return undefined;
    },
    [workbench, runDirectCommand],
  );

  const setThreadState = useCallback(
    async (threadId: string, state: "open" | "resolved"): Promise<void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot update this thread.");
      const parsedThreadId = parseGitHubThreadId(threadId);
      if (parsedThreadId._tag === "err")
        throw new Error("The thread id is not valid for this Review.");
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/inline-conversations/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: {
              _tag: "SetThreadState",
              expected: {
                sessionId: workbench.session.id,
                headSha: workbench.revision.reviewedHeadSha,
                patchHash,
              },
              threadId,
              state,
            },
          },
        }),
      );
      const receipt = parseDirectConversationReceipt(value);
      if (receipt?._tag === "ThreadStateChanged") {
        setRecentWrites((current) => [
          ...current,
          { _tag: "ThreadState", threadId: parsedThreadId.value, state },
        ]);
      }
    },
    [workbench, runDirectCommand],
  );

  const replyToThread = useCallback(
    async (threadId: string, body: string): Promise<string | void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot accept replies.");
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/inline-conversations/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: {
              _tag: "Reply",
              expected: {
                sessionId: workbench.session.id,
                headSha: workbench.revision.reviewedHeadSha,
                patchHash,
              },
              threadId,
              body,
            },
          },
        }),
      );
      const receipt = parseDirectConversationReceipt(value);
      if (receipt?._tag === "ReplyCreated") {
        setRecentWrites((current) => [
          ...current,
          {
            _tag: "Comment",
            commentId: receipt.commentId,
            ...(receipt.reviewId === undefined
              ? {}
              : { reviewId: receipt.reviewId }),
          },
        ]);
        return receipt.commentId;
      }
      return undefined;
    },
    [workbench, runDirectCommand],
  );

  const editComment = useCallback(
    async (commentId: string, body: string): Promise<void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot edit comments.");
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/inline-conversations/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: {
              _tag: "EditComment",
              expected: {
                sessionId: workbench.session.id,
                headSha: workbench.revision.reviewedHeadSha,
                patchHash,
              },
              commentId,
              body,
            },
          },
        }),
      );
      if (parseDirectConversationReceipt(value)?._tag === "CommentEdited") {
        setRecentWrites((current) => [
          ...current,
          { _tag: "Comment", commentId },
        ]);
      }
    },
    [workbench, runDirectCommand],
  );

  const deleteComment = useCallback(
    async (commentId: string): Promise<void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot delete comments.");
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/inline-conversations/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: {
              _tag: "DeleteComment",
              expected: {
                sessionId: workbench.session.id,
                headSha: workbench.revision.reviewedHeadSha,
                patchHash,
              },
              commentId,
              confirmation: true,
            },
          },
        }),
      );
      if (parseDirectConversationReceipt(value)?._tag === "CommentDeleted") {
        setRecentWrites((current) => [
          ...current,
          { _tag: "Comment", commentId },
        ]);
      }
    },
    [workbench, runDirectCommand],
  );
  const parsedDraft =
    workbench.draft === undefined
      ? undefined
      : parseReviewBatch(workbench.draft);
  const localBatch =
    parsedDraft?._tag === "ok" && parsedDraft.value.state._tag === "Local";
  const canEditDraft = workbench.review.status === "open" && localBatch;
  const hasNeedsAttention =
    parsedDraft?._tag === "ok" &&
    parsedDraft.value.items.some(
      (item) =>
        item._tag === "InlineComment" && item.postability === "needs_attention",
    );
  const hasActivePublication =
    parsedDraft?._tag === "ok" &&
    (parsedDraft.value.state._tag === "Applying" ||
      parsedDraft.value.state._tag === "PendingReview" ||
      parsedDraft.value.state._tag === "Submitted" ||
      parsedDraft.value.state._tag === "PartialFailure");
  const canWriteGitHub =
    workbench.review.status === "open" &&
    workbench.revision.freshness === "fresh" &&
    localBatch &&
    !hasNeedsAttention &&
    !hasActivePublication;
  const canWriteDirectConversation =
    workbench.review.status === "open" &&
    workbench.revision.freshness === "fresh" &&
    workbench.revision.patchHash !== undefined;
  // GitHub pending-review actions: the header action, composer split, Finish
  // review modal, and explicit Check GitHub again recovery all own their
  // requests here; the renderer never calls GitHub directly.
  const [pendingReviewBusy, setPendingReviewBusy] = useState(false);
  const [finishDialogOpen, setFinishDialogOpen] = useState(false);
  const [finishDialogInitialSummary, setFinishDialogInitialSummary] = useState<
    string | undefined
  >(undefined);
  const [finishDialogError, setFinishDialogError] = useState<
    string | undefined
  >(undefined);
  const applyPendingReviewProjection = useCallback(
    (value: unknown): PendingReviewProjection | undefined => {
      const projection = parsePendingReviewProjection(
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)["pendingReview"]
          : undefined,
      );
      if (projection !== undefined)
        onWorkbenchPatch({ pendingReview: projection });
      return projection;
    },
    [onWorkbenchPatch],
  );
  const runPendingReviewCommand = useCallback(
    async (
      command:
        | {
            readonly _tag: "Start" | "AddThread";
            readonly pendingReviewNodeId?: string;
            readonly anchor: {
              readonly path: string;
              readonly startLine: number;
              readonly line: number;
              readonly side: "new" | "old";
            };
            readonly body: string;
          }
        | {
            readonly _tag: "Submit";
            readonly event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
            readonly summaryBody: string;
          }
        | {
            readonly _tag: "Discard";
            readonly confirmation: true;
          },
    ): Promise<void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot accept review comments.");
      // The prior projection's thread ids are the baseline for journaling: only
      // the exact ids this command adds (Start/AddThread) or confirms absent
      // (Discard) may be excluded from detection.
      const priorThreadIds =
        command._tag === "Start" ||
        command._tag === "AddThread" ||
        command._tag === "Discard"
          ? threadIdsOf(workbench.pendingReview)
          : [];
      setPendingReviewBusy(true);
      try {
        const expected = {
          sessionId: workbench.session.id,
          headSha: workbench.revision.reviewedHeadSha,
          patchHash,
        };
        const value =
          command._tag === "Discard"
            ? await requestJson("/v1/reviews/pending-review/command", {
                method: "POST",
                body: {
                  profileId: workbench.session.key.profileId,
                  reviewId: workbench.review.id,
                  command: {
                    _tag: "Discard",
                    expected,
                    confirmation: command.confirmation,
                  },
                },
              })
            : command._tag === "Submit"
              ? await requestJson("/v1/reviews/pending-review/command", {
                  method: "POST",
                  body: {
                    profileId: workbench.session.key.profileId,
                    reviewId: workbench.review.id,
                    command: {
                      _tag: "Submit",
                      expected,
                      event: command.event,
                      summaryBody: command.summaryBody,
                    },
                  },
                })
              : await requestJson("/v1/reviews/pending-review/command", {
                  method: "POST",
                  body: {
                    profileId: workbench.session.key.profileId,
                    reviewId: workbench.review.id,
                    command: {
                      _tag: command._tag,
                      expected,
                      ...(command._tag === "AddThread"
                        ? { pendingReviewNodeId: command.pendingReviewNodeId }
                        : {}),
                      anchor: command.anchor,
                      body: command.body,
                    },
                  },
                });
        const projection = applyPendingReviewProjection(value);
        setFinishDialogError(undefined);
        // Journal the exact pending-thread mutations so the detector never reads
        // this window's own Start/AddThread/Discard as a remote update. Entries
        // survive until an explicit refresh/reload replaces the represented
        // snapshot; a Submit keeps them because the threads persist remotely.
        if (command._tag === "Start" || command._tag === "AddThread") {
          const added = threadIdsOf(projection).filter(
            (id) => !priorThreadIds.includes(id),
          );
          if (added.length > 0) {
            setRecentWrites((current) => [
              ...current,
              ...added.map((threadId) => ({
                _tag: "PendingThread" as const,
                threadId,
              })),
            ]);
          }
        } else if (command._tag === "Discard" && projection?.state === "none") {
          // Confirmed absence: the threads the prior projection owned are gone
          // from the candidate snapshot, so they must be masked on both sides.
          if (priorThreadIds.length > 0) {
            setRecentWrites((current) => [
              ...current,
              ...priorThreadIds.map((threadId) => ({
                _tag: "PendingThread" as const,
                threadId,
              })),
            ]);
          }
        }
      } catch (cause) {
        if (
          cause instanceof PatchdeskApiError &&
          (cause.kind === "outcome_unknown" ||
            cause.kind === "ambiguous_write" ||
            cause.kind === "timeout")
        ) {
          const projected = applyPendingReviewProjection(cause.responseBody);
          if (projected === undefined) {
            const action =
              command._tag === "Start"
                ? "start"
                : command._tag === "AddThread"
                  ? "add_thread"
                  : command._tag === "Submit"
                    ? "submit"
                    : "discard";
            onWorkbenchPatch({
              pendingReview: { state: "recovery_required", action },
            });
          }
        }
        throw cause;
      } finally {
        setPendingReviewBusy(false);
      }
    },
    [applyPendingReviewProjection, workbench],
  );
  const checkGitHubAgain = useCallback(async (): Promise<void> => {
    setPendingReviewBusy(true);
    setFinishDialogError(undefined);
    try {
      const value = await requestJson("/v1/reviews/pending-review/recover", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          reviewId: workbench.review.id,
        },
      });
      const projection = applyPendingReviewProjection(value);
      if (projection?.state === "recovery_required") {
        setFinishDialogError(
          "Patchdesk found the pending review, but it cannot identify the exact Finding comment. Inspect or discard the pending review on GitHub, then check again.",
        );
      } else {
        const loaded = await requestJson("/v1/reviews/load", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
          },
        });
        const next = parseWorkbenchResponse(loaded);
        if (next === undefined)
          throw new Error("Invalid Review projection response");
        replaceWorkbench(next);
        setFinishDialogError(undefined);
      }
    } catch (cause) {
      setFinishDialogError(boundedPendingReviewRecoveryError(cause));
    } finally {
      setPendingReviewBusy(false);
    }
  }, [applyPendingReviewProjection, replaceWorkbench, workbench]);
  const [directSummaryBusy, setDirectSummaryBusy] = useState(false);
  const [directSummaryError, setDirectSummaryError] = useState<
    string | undefined
  >(undefined);
  const [directSummaryState, setDirectSummaryState] =
    useState<DirectSummaryReviewProjection>(
      workbench.directSummary ?? { state: "idle" },
    );
  useEffect(() => {
    setDirectSummaryState(workbench.directSummary ?? { state: "idle" });
  }, [workbench.directSummary]);
  const observedDirectSummaryRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (directSummaryState.state !== "confirmed") return;
    const reviewId = directSummaryState.receipt.reviewId;
    if (observedDirectSummaryRef.current === reviewId) return;
    observedDirectSummaryRef.current = reviewId;
    void observeConfirmedDirectSummary(reviewId).catch(() => {
      // The confirmed receipt stays durable. The scheduled observer retains
      // the receipt journal and retries metadata adoption without replaying
      // the GitHub write.
    });
  }, [directSummaryState, observeConfirmedDirectSummary]);
  const submitDirectSummary = useCallback(
    async (
      event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
      body: string,
    ): Promise<DirectSummaryReviewProjection> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined)
        throw new Error("The current Diff cannot accept a review summary.");
      setDirectSummaryBusy(true);
      try {
        const value = await runDirectCommand(() =>
          requestJson("/v1/reviews/direct-summary/submit", {
            method: "POST",
            body: {
              profileId: workbench.session.key.profileId,
              reviewId: workbench.review.id,
              expected: {
                sessionId: workbench.session.id,
                headSha: workbench.revision.reviewedHeadSha,
                patchHash,
              },
              event,
              body,
            },
          }),
        );
        const result = parseDirectSummaryReviewResponse(value);
        if (result === undefined)
          throw new Error("Invalid direct summary review response");
        setDirectSummaryState(result);
        if (result.state === "confirmed") {
          const write = {
            _tag: "DirectSummaryReview" as const,
            reviewId: result.receipt.reviewId,
          };
          setRecentWrites((current) => [...current, write]);
        }
        setDirectSummaryError(undefined);
        return result;
      } catch (cause) {
        // The renderer is the protocol boundary for API failures: retain only
        // stable failure kinds and lock submission until explicit reconciliation.
        if (
          cause instanceof PatchdeskApiError &&
          (cause.kind === "outcome_unknown" ||
            cause.kind === "ambiguous_write" ||
            cause.kind === "timeout")
        )
          setDirectSummaryState({
            state: "recovery_required",
            resolution: "check_required",
          });
        setDirectSummaryError(boundedDirectSummaryError(cause));
        throw cause;
      } finally {
        setDirectSummaryBusy(false);
      }
    },
    [runDirectCommand, workbench],
  );
  const recoverDirectSummary =
    useCallback(async (): Promise<DirectSummaryReviewProjection> => {
      setDirectSummaryBusy(true);
      try {
        const value = await runDirectCommand(() =>
          requestJson("/v1/reviews/direct-summary/recover", {
            method: "POST",
            body: {
              profileId: workbench.session.key.profileId,
              reviewId: workbench.review.id,
            },
          }),
        );
        const result = parseDirectSummaryReviewResponse(value);
        if (result === undefined)
          throw new Error("Invalid direct summary recovery response");
        setDirectSummaryState(result);
        if (result.state === "confirmed") {
          setRecentWrites((current) => [
            ...current,
            { _tag: "DirectSummaryReview", reviewId: result.receipt.reviewId },
          ]);
        }
        setDirectSummaryError(undefined);
        return result;
      } catch (cause) {
        // Reconciliation failures leave the state locked; only an explicit
        // successful GitHub read may return it to the submit form.
        setDirectSummaryError(boundedDirectSummaryError(cause));
        throw cause;
      } finally {
        setDirectSummaryBusy(false);
      }
    }, [runDirectCommand, workbench]);
  const pendingReviewComposer: PendingReviewComposerActions | undefined =
    workbench.pendingReview === undefined
      ? undefined
      : {
          state:
            workbench.pendingReview.state === "pending"
              ? {
                  state: "pending" as const,
                  nodeId: workbench.pendingReview.review.nodeId,
                }
              : {
                  state: workbench.pendingReview.state as
                    "none" | "unavailable" | "recovery_required",
                },
          busy: pendingReviewBusy,
          onStartReview: async (anchor, body) => {
            await runPendingReviewCommand({ _tag: "Start", anchor, body });
          },
          onAddReviewComment: async (nodeId, anchor, body) => {
            await runPendingReviewCommand({
              _tag: "AddThread",
              pendingReviewNodeId: nodeId,
              anchor,
              body,
            });
          },
        };
  const localCommentAuthoring: LocalCommentAuthoring | undefined =
    canWriteDirectConversation
      ? {
          enabled: true,
          onSave: saveInlineComment,
          onSelectionChange: (location) => {
            const path = parseRepoRelativePath(location.path);
            if (path._tag === "ok")
              setSelectedRepairAnchor({ ...location, path: path.value });
          },
        }
      : undefined;
  const externalPullRequest = pullRequestExternalRef(workbench);
  const mergeAction: PullRequestOverviewMerge | undefined =
    workbench.review.status === "open" &&
    workbench.revision.freshness === "fresh" &&
    workbench.revision.patchHash !== undefined
      ? {
          readiness: workbench.mergeReadiness as MergeReadiness,
          ...(workbench.mergeReasons === undefined
            ? {}
            : { mergeReasons: workbench.mergeReasons }),
          ...(externalPullRequest === undefined
            ? {}
            : { pullRequest: externalPullRequest }),
          context: {
            repo: `${workbench.session.key.owner}/${workbench.session.key.repo}`,
            prNumber: workbench.session.key.prNumber,
            title:
              workbench.pullRequest?.title ??
              `Pull request #${workbench.session.key.prNumber}`,
            base: workbench.pullRequest?.baseBranch ?? "unknown",
            head: workbench.pullRequest?.headBranch ?? "unknown",
            headSha: workbench.revision.reviewedHeadSha,
          },
          methods: ["squash", "merge", "rebase"] as const,
          onMerge: async (
            method: "merge" | "squash" | "rebase",
            warningCodes: ReadonlyArray<string>,
          ) => {
            await requestJson("/v1/reviews/merge", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                reviewId: workbench.review.id,
                sessionId: workbench.session.id,
                expectedHeadSha: workbench.revision.reviewedHeadSha,
                expectedBaseSha: workbench.pullRequest?.baseSha ?? "",
                expectedPatchHash: workbench.revision.patchHash,
                expectedRevision:
                  workbench.draft?.updatedAt ?? workbench.revision.refreshedAt,
                method,
                acknowledgedWarnings: {
                  revision: {
                    headSha: workbench.revision.reviewedHeadSha,
                    baseSha: workbench.pullRequest?.baseSha ?? "",
                    patchHash: workbench.revision.patchHash,
                  },
                  warningCodes,
                },
              },
            });
            const refreshed = await requestJson("/v1/reviews/load", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                reviewId: workbench.review.id,
              },
            });
            const next = parseWorkbenchResponse(refreshed);
            if (next === undefined)
              throw new Error("Invalid terminal Review projection");
            replaceWorkbench(next);
            return {};
          },
        }
      : undefined;
  const addFindingToPendingReview = useCallback(
    async (finding: AnalysisFinding): Promise<void> => {
      const runId = workbench.insights.analysis.retained?.runId;
      const patchHash = workbench.revision.patchHash;
      const status =
        workbench.analysisReviewActions?.findings[finding.id]?.state;
      if (
        runId === undefined ||
        patchHash === undefined ||
        status !== "actionable" ||
        finding.mappingStatus !== "mapped" ||
        finding.file === undefined ||
        finding.lineStart === undefined ||
        workbench.fullPatch === undefined
      )
        throw new Error(
          "This Finding is not actionable on the current Review.",
        );
      const mapped = mapFindingLocation(
        parseUnifiedPatch(workbench.fullPatch),
        {
          file: finding.file,
          lineStart: finding.lineStart,
          ...(finding.lineEnd === undefined
            ? {}
            : { lineEnd: finding.lineEnd }),
          ...(finding.diffSide === undefined
            ? {}
            : { diffSide: finding.diffSide }),
        },
      );
      const path =
        mapped.path === undefined
          ? undefined
          : parseRepoRelativePath(mapped.path);
      if (
        path?._tag !== "ok" ||
        mapped.line === undefined ||
        mapped.side === undefined
      )
        throw new Error(
          "Patchdesk could not verify this Finding's diff anchor.",
        );
      const anchor = {
        path: path.value,
        startLine: mapped.startLine ?? mapped.line,
        line: mapped.line,
        side: mapped.side,
      };
      const expected = {
        sessionId: workbench.session.id,
        headSha: workbench.revision.reviewedHeadSha,
        patchHash,
      };
      const pending = workbench.pendingReview;
      const command =
        pending?.state === "none"
          ? {
              _tag: "Start" as const,
              expected,
              anchor,
              body: finding.suggestedComment ?? finding.explanation,
              finding: {
                analysisRunId: runId,
                findingId: finding.id,
                ...expected,
              },
            }
          : pending?.state === "pending"
            ? {
                _tag: "AddThread" as const,
                expected,
                pendingReviewNodeId: pending.review.nodeId,
                anchor,
                body: finding.suggestedComment ?? finding.explanation,
                finding: {
                  analysisRunId: runId,
                  findingId: finding.id,
                  ...expected,
                },
              }
            : undefined;
      if (command === undefined)
        throw new Error("Check GitHub again before changing this Finding.");
      await requestJson("/v1/reviews/pending-review/command", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          reviewId: workbench.review.id,
          command,
        },
      });
      const value = await requestJson("/v1/reviews/load", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          reviewId: workbench.review.id,
        },
      });
      const next = parseWorkbenchResponse(value);
      if (next === undefined)
        throw new Error("Invalid Review projection response");
      replaceWorkbench(next);
    },
    [replaceWorkbench, workbench],
  );

  return (
    <>
      <ReviewWorkbench
        model={workbench}
        {...(initialUiState === undefined
          ? {}
          : { initialState: initialUiState })}
        {...(onUiStateChange === undefined
          ? {}
          : { onStateChange: onUiStateChange })}
        actions={{
          detectUpdates: runDetect,
          refresh,
          ...(refreshing === true ? { refreshing: true } : {}),
          ...(refreshError === true ? { refreshError: true } : {}),
          ...(mergeAction === undefined ? {} : { merge: mergeAction }),
          loadCommitDiff: async (
            commitSha: string,
          ): Promise<CommitDiffResponse> => {
            const value = await requestJson("/v1/reviews/commit-diff", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                reviewId: workbench.review.id,
                commitSha,
              },
            });
            const parsed = parseCommitDiffResponse(value);
            if (parsed === undefined)
              throw new Error("Invalid commit diff response");
            return parsed;
          },
          ...(localCommentAuthoring === undefined
            ? {}
            : { localCommentAuthoring }),
          ...(pendingReviewComposer === undefined
            ? {}
            : { pendingReviewComposer }),
          ...(pendingReviewComposer === undefined
            ? {}
            : {
                pendingReview: {
                  projection: workbench.pendingReview,
                  busy: pendingReviewBusy,
                  finishDialogOpen,
                  ...(finishDialogInitialSummary === undefined
                    ? {}
                    : { finishDialogInitialSummary }),
                  onOpenFinishDialog: () => {
                    setFinishDialogInitialSummary(undefined);
                    setFinishDialogOpen(true);
                  },
                  onCloseFinishDialog: () => {
                    setFinishDialogOpen(false);
                    setFinishDialogInitialSummary(undefined);
                  },
                  onSubmit: async (event, summaryBody) => {
                    try {
                      await runPendingReviewCommand({
                        _tag: "Submit",
                        event,
                        summaryBody,
                      });
                      setFinishDialogOpen(false);
                    } catch (cause) {
                      setFinishDialogError(boundedPendingReviewError(cause));
                    }
                  },
                  onDiscard: async () => {
                    try {
                      await runPendingReviewCommand({
                        _tag: "Discard",
                        confirmation: true,
                      });
                      setFinishDialogOpen(false);
                    } catch (cause) {
                      setFinishDialogError(boundedPendingReviewError(cause));
                    }
                  },
                  onCheckGitHubAgain: checkGitHubAgain,
                  ...(finishDialogError === undefined
                    ? {}
                    : { recoveryError: finishDialogError }),
                  ...(finishDialogError === undefined
                    ? {}
                    : { finishDialogError }),
                },
              }),
          ...(workbench.pendingReview?.state === "none"
            ? {
                directSummary: {
                  busy: directSummaryBusy,
                  state: directSummaryState.state,
                  approvalCapability:
                    workbench.directSummaryDecision ?? "unknown",
                  ...(directSummaryState.state === "confirmed"
                    ? { receipt: directSummaryState.receipt }
                    : {}),
                  ...(directSummaryState.state === "recovery_required"
                    ? { recoveryResolution: directSummaryState.resolution }
                    : {}),
                  onSubmit: submitDirectSummary,
                  onRecover: recoverDirectSummary,
                  ...(directSummaryError === undefined
                    ? {}
                    : { error: directSummaryError }),
                },
              }
            : {}),
          ...(canWriteDirectConversation
            ? { setThreadState, replyToThread, editComment, deleteComment }
            : {}),
          reportNavigationState: onNavigationStateChange,
        }}
        slots={{
          insights: (
            <InsightsSlot
              workbench={workbench}
              {...(initialUiState?.insightDetail === undefined
                ? {}
                : { initialDetail: initialUiState.insightDetail })}
              onWorkbenchReplace={replaceWorkbench}
              onWorkbenchPatch={onWorkbenchPatch}
              onAddFinding={addFindingToPendingReview}
              onFinishWithAnalysisSummary={(summary) => {
                setFinishDialogInitialSummary(summary);
                setFinishDialogOpen(true);
              }}
            />
          ),
          conversation: null,
          mergeAction: null,
          draftDock: (
            <DraftSlot
              workbench={workbench}
              onWorkbenchPatch={onWorkbenchPatch}
              onWorkbenchReplace={replaceWorkbench}
              onRefreshAfterPublication={refreshConfirmedPublication}
              canEditDraft={canEditDraft}
              canWriteGitHub={canWriteGitHub}
              {...(selectedRepairAnchor === undefined
                ? {}
                : { selectedRepairAnchor })}
              {...(initialUiState?.draftExpanded === undefined
                ? {}
                : { initialExpanded: initialUiState.draftExpanded })}
              autoOpenPublication={autoOpenPublication}
              onAutoOpenPublicationConsumed={() =>
                setAutoOpenPublication(false)
              }
            />
          ),
        }}
      />
      {refreshError ? (
        <p role="alert" className="border-t px-4 py-2 text-sm text-destructive">
          GitHub state could not be refreshed. The represented Review remains
          readable.
        </p>
      ) : null}
      {refreshing ? (
        <span className="sr-only" role="status">
          Refreshing Review state
        </span>
      ) : null}
    </>
  );
}

type AnalysisFinding = NonNullable<
  WorkbenchResponse["insights"]["analysis"]["retained"]
>["value"]["findings"][number];
function InsightsSlot({
  workbench,
  initialDetail,
  onWorkbenchReplace,
  onWorkbenchPatch,
  onAddFinding,
  onFinishWithAnalysisSummary,
}: {
  readonly workbench: WorkbenchResponse;
  readonly initialDetail?: "analysis" | "walkthrough";
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
  readonly onAddFinding: (finding: AnalysisFinding) => Promise<void>;
  readonly onFinishWithAnalysisSummary: (summary: string) => void;
}): React.JSX.Element {
  const navigateToFiles = useReviewWorkbenchNavigation();
  const [catalog, setCatalog] =
    useState<ReturnType<typeof parseInsightProviderCatalog>>();
  const [provider, setProvider] = useState<InsightProvider>("pi");
  const [models, setModels] = useState<
    ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly reasoning?: ReadonlyArray<InsightReasoning>;
    }>
  >([]);
  const [preferences, setPreferences] = useState<
    Partial<Record<"analysis" | "walkthrough", InsightRunPreference>>
  >({});
  const [model, setModel] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<InsightReasoning>("medium");
  const [runDialogType, setRunDialogType] =
    useState<InsightRunDialogType | null>(null);
  const [runDialogAction, setRunDialogAction] = useState<
    "run" | "retry" | "regenerate"
  >("run");
  const [catalogError, setCatalogError] = useState(false);
  const [codexActivationPending, setCodexActivationPending] = useState(false);
  const [codexActivationError, setCodexActivationError] = useState(false);
  const [selectedInsight, setSelectedInsight] = useState<
    "overview" | "analysis" | "walkthrough"
  >(initialDetail ?? "analysis");
  const [reviewedWalkthroughSections, setReviewedWalkthroughSections] =
    useState<ReadonlyArray<string>>(
      workbench.insights.walkthrough.progress?.reviewedSectionIds ?? [],
    );
  const [supportReviewed, setSupportReviewed] = useState(
    workbench.insights.walkthrough.progress?.supportReviewed ?? false,
  );
  const [currentWalkthroughSection, setCurrentWalkthroughSection] = useState<
    string | undefined
  >(workbench.insights.walkthrough.progress?.currentSectionId);
  const [walkthroughFocused, setWalkthroughFocused] = useState(false);
  const [progressError, setProgressError] = useState(false);
  const profileId = workbench.session.key.profileId;
  const reviewId = workbench.review.id;
  const onInsightPatch = useCallback(
    (
      type: "analysis" | "walkthrough",
      projection:
        | WorkbenchResponse["insights"]["analysis"]
        | WorkbenchResponse["insights"]["walkthrough"],
    ): void => {
      onWorkbenchPatch({ insights: { [type]: projection } });
    },
    [onWorkbenchPatch],
  );
  const analysisRun = useInsightRun({
    profileId,
    reviewId,
    type: "analysis",
    activeRun: workbench.insights.analysis.activeRun,
    onWorkbenchReplace,
    onInsightPatch,
  });
  const walkthroughRun = useInsightRun({
    profileId,
    reviewId,
    type: "walkthrough",
    activeRun: workbench.insights.walkthrough.activeRun,
    onWorkbenchReplace,
    onInsightPatch,
  });

  useEffect(() => {
    let active = true;
    const loadedPreferences: Partial<
      Record<"analysis" | "walkthrough", InsightRunPreference>
    > = {};
    const analysisPreference = loadInsightRunPreference(profileId, "analysis");
    const walkthroughPreference = loadInsightRunPreference(
      profileId,
      "walkthrough",
    );
    if (analysisPreference !== undefined)
      loadedPreferences.analysis = analysisPreference;
    if (walkthroughPreference !== undefined)
      loadedPreferences.walkthrough = walkthroughPreference;
    setPreferences(loadedPreferences);
    const initialPreference = loadedPreferences[initialDetail ?? "analysis"];
    if (initialPreference !== undefined) {
      setProvider(initialPreference.provider);
      setReasoning(initialPreference.reasoning);
      setModel(initialPreference.model);
    }
    void requestJson("/v1/insight-providers")
      .then((value) => {
        if (!active) return;
        const parsed = parseInsightProviderCatalog(value);
        if (parsed === undefined) {
          setCatalog(undefined);
          setModels([]);
          setModel(null);
          setCatalogError(true);
          return;
        }
        setCatalog(parsed);
        const piModels = parsed.models.filter(
          (candidate) => candidate.provider === "pi",
        );
        setModels(piModels);
        const selectedModel =
          initialPreference?.provider === "pi" &&
          piModels.some((candidate) => candidate.id === initialPreference.model)
            ? initialPreference.model
            : (piModels[0]?.id ?? null);
        setModel(selectedModel);
        setCatalogError(false);
      })
      .catch(() => {
        if (!active) return;
        setCatalog(undefined);
        setModels([]);
        setModel(null);
        setCatalogError(true);
      });
    return () => {
      active = false;
    };
  }, [profileId, initialDetail]);

  const hasAvailableProvider =
    catalog?.providers.some((candidate) => candidate.available) ?? false;
  const runEnabled =
    !catalogError && hasAvailableProvider && workbench.review.status === "open";

  const activePreferenceType =
    runDialogType ??
    (selectedInsight === "walkthrough" ? "walkthrough" : "analysis");
  const changeProvider = (nextProvider: InsightProvider): void => {
    setProvider(nextProvider);
    const nextModels =
      catalog?.models.filter(
        (candidate) => candidate.provider === nextProvider,
      ) ?? [];
    setModels(nextModels);
    const preference = preferences[activePreferenceType];
    setModel(
      preference?.provider === nextProvider &&
        nextModels.some((candidate) => candidate.id === preference.model)
        ? preference.model
        : (nextModels[0]?.id ?? null),
    );
    const first = nextModels[0];
    setReasoning(
      preference?.provider === nextProvider
        ? preference.reasoning
        : (first?.defaultReasoning ?? first?.reasoning[0] ?? "medium"),
    );
  };
  const activateCodex = (): void => {
    setCodexActivationPending(true);
    setCodexActivationError(false);
    void requestJson("/v1/insight-providers/codex/models", {
      method: "POST",
      body: {},
    })
      .then((value) => {
        const parsed = parseInsightProviderCatalog(value);
        if (parsed === undefined) throw new Error("Invalid Codex catalog");
        setCatalog((current) =>
          current === undefined
            ? parsed
            : {
                ...current,
                providers: [
                  ...current.providers.filter(
                    (candidate) => candidate.id !== "codex-cli-account",
                  ),
                  ...parsed.providers,
                ],
                models: [
                  ...current.models.filter(
                    (candidate) => candidate.provider !== "codex-cli-account",
                  ),
                  ...parsed.models,
                ],
              },
        );
        const codexModels = parsed.models.filter(
          (candidate) => candidate.provider === "codex-cli-account",
        );
        setModels(codexModels);
        setModel(codexModels[0]?.id ?? null);
        setReasoning(
          codexModels[0]?.defaultReasoning ??
            codexModels[0]?.reasoning[0] ??
            "medium",
        );
      })
      .catch(() => setCodexActivationError(true))
      .finally(() => setCodexActivationPending(false));
  };
  const walkthroughRunId = workbench.insights.walkthrough.retained?.runId;
  useEffect(() => {
    setProgressError(false);
  }, [walkthroughRunId]);
  const saveWalkthroughProgress = (progress: {
    readonly reviewedSectionIds: ReadonlyArray<string>;
    readonly supportReviewed: boolean;
    readonly currentSectionId?: string;
  }): void => {
    if (walkthroughRunId === undefined) return;
    void requestJson("/v1/reviews/insights/walkthrough/progress", {
      method: "POST",
      body: { profileId, reviewId, runId: walkthroughRunId, ...progress },
    })
      .then(() => setProgressError(false))
      .catch(() => setProgressError(true));
  };
  const reloadWorkbench = async (): Promise<void> => {
    const value = await requestJson("/v1/reviews/load", {
      method: "POST",
      body: { profileId, reviewId },
    });
    const next = parseWorkbenchResponse(value);
    if (next === undefined)
      throw new Error("Invalid Review projection response");
    onWorkbenchReplace(next);
  };
  const dismissFinding = async (
    finding: AnalysisFinding,
    reason: string,
  ): Promise<void> => {
    const runId = workbench.insights.analysis.retained?.runId;
    if (runId === undefined) throw new Error("Analysis run is unavailable");
    await requestJson(
      `/v1/reviews/insights/analysis/findings/${encodeURIComponent(finding.id)}/dismiss`,
      { method: "POST", body: { profileId, reviewId, runId, reason } },
    );
    await reloadWorkbench();
  };
  const addFinding = onAddFinding;
  const selectedProjection =
    selectedInsight === "analysis"
      ? workbench.insights.analysis
      : selectedInsight === "walkthrough"
        ? workbench.insights.walkthrough
        : undefined;
  const selectedRunning =
    selectedInsight === "analysis"
      ? analysisRun
      : selectedInsight === "walkthrough"
        ? walkthroughRun
        : undefined;
  const selectedRetained = selectedProjection?.retained;
  const selectedIsOutdated = selectedProjection?.status === "outdated";
  const analysisFirstRunActive =
    selectedInsight === "analysis" &&
    selectedProjection?.status === "running" &&
    selectedProjection.retained === undefined;
  const runSelected = (onAccepted?: () => void): void => {
    if (model === null || selectedInsight === "overview") return;
    if (selectedInsight === "analysis") {
      analysisRun.run(provider, model, reasoning, undefined, onAccepted);
    } else {
      walkthroughRun.run(provider, model, reasoning, undefined, onAccepted);
    }
  };
  const openRunDialog = (action: "run" | "retry" | "regenerate"): void => {
    if (selectedInsight === "overview" || catalogError) return;
    const preference = preferences[selectedInsight];
    setProvider(preference?.provider ?? "pi");
    setReasoning(preference?.reasoning ?? "medium");
    const nextModels =
      catalog?.models.filter(
        (candidate) => candidate.provider === (preference?.provider ?? "pi"),
      ) ?? [];
    setModels(nextModels);
    setModel(
      preference !== undefined &&
        nextModels.some((candidate) => candidate.id === preference.model)
        ? preference.model
        : (nextModels[0]?.id ?? null),
    );
    setRunDialogType(selectedInsight);
    setRunDialogAction(action);
  };
  const closeRunDialog = (): void => setRunDialogType(null);
  const confirmRun = (): void => {
    if (model === null || selectedInsight === "overview") return;
    closeRunDialog();
    runSelected(() => {
      saveInsightRunPreference(profileId, selectedInsight, {
        provider,
        model,
        reasoning,
      });
      setPreferences((current) => ({
        ...current,
        [selectedInsight]: { provider, model, reasoning },
      }));
    });
  };
  const retainedDescription =
    selectedInsight === "analysis"
      ? workbench.insights.analysis.retained?.value.summary
      : selectedInsight === "walkthrough"
        ? workbench.insights.walkthrough.retained?.value.focus
        : undefined;
  const currentRevision =
    workbench.revision.currentHeadSha ?? workbench.revision.reviewedHeadSha;
  const analysisSummaryScope = {
    baseShort: (workbench.pullRequest?.baseSha ?? "unknown").slice(0, 7),
    headShort: workbench.session.key.headSha.slice(0, 7),
    commitCount: workbench.commits.length,
    fileCount:
      workbench.pullRequest?.changedFileCount ??
      (workbench.fullPatch === undefined
        ? 0
        : parseUnifiedPatch(workbench.fullPatch).length),
    additions: workbench.pullRequest?.additions ?? 0,
    deletions: workbench.pullRequest?.deletions ?? 0,
    changedFiles:
      workbench.fullPatch === undefined
        ? []
        : parseUnifiedPatch(workbench.fullPatch).map((file) => ({
            path: file.newPath,
            additions: file.additions,
            deletions: file.deletions,
          })),
  };
  const analysisResult = workbench.insights.analysis.retained?.value;

  const retainedAnalysis =
    selectedInsight === "analysis" &&
    workbench.insights.analysis.retained !== undefined ? (
      <AnalysisReader
        result={workbench.insights.analysis.retained.value}
        checkStatus={workbench.checks.overall}
        findingStatuses={Object.fromEntries(
          Object.entries(workbench.analysisReviewActions?.findings ?? {}).map(
            ([id, status]) => [id, status.state],
          ),
        )}
        {...(workbench.insights.analysis.status === "current" &&
        workbench.fullPatch !== undefined
          ? { evidencePatch: workbench.fullPatch }
          : {})}
        canFinishWithAnalysisSummary={
          workbench.analysisReviewActions?.canFinishWithAnalysisSummary ?? false
        }
        {...(workbench.analysisReviewActions?.canFinishWithAnalysisSummary ===
          true && analysisResult !== undefined
          ? {
              onFinishWithAnalysisSummary: () =>
                onFinishWithAnalysisSummary(
                  renderAnalysisReviewSummary({
                    result: analysisResult,
                    scope: analysisSummaryScope,
                  }),
                ),
            }
          : {})}
        {...(workbench.insights.analysis.status === "current"
          ? { onAddFinding: addFinding, onDismissFinding: dismissFinding }
          : {})}
      />
    ) : null;
  const walkthroughRetained = workbench.insights.walkthrough.retained;
  const walkthroughDiscussionAvailable =
    walkthroughRetained !== undefined &&
    workbench.insights.walkthrough.status === "current" &&
    workbench.insights.walkthrough.artifactStatus === "verified" &&
    workbench.revision.freshness === "fresh" &&
    workbench.fullPatch !== undefined &&
    workbench.revision.patchHash !== undefined &&
    workbench.conversation.inline?.complete === true &&
    walkthroughRetained.value.snapshot.profileId ===
      workbench.session.key.profileId &&
    walkthroughRetained.value.snapshot.sessionId === workbench.session.id &&
    walkthroughRetained.value.snapshot.headSha ===
      workbench.revision.reviewedHeadSha &&
    walkthroughRetained.value.snapshot.patchHash ===
      workbench.revision.patchHash;
  const walkthroughAnnotations =
    walkthroughDiscussionAvailable && workbench.fullPatch !== undefined
      ? projectReadOnlyConversationAnnotations(
          parseUnifiedPatch(workbench.fullPatch),
          workbench.conversation.inline?.threads ?? [],
        )
      : undefined;
  const retainedWalkthrough =
    selectedInsight === "walkthrough" &&
    workbench.insights.walkthrough.retained !== undefined ? (
      <NarrativeWalkthrough
        walkthrough={workbench.insights.walkthrough.retained.value}
        reviewedSectionIds={reviewedWalkthroughSections}
        supportReviewed={supportReviewed}
        {...(currentWalkthroughSection === undefined
          ? {}
          : { currentSectionId: currentWalkthroughSection })}
        {...(workbench.insights.walkthrough.status === "current" &&
        workbench.fullPatch !== undefined
          ? { rawPatch: workbench.fullPatch }
          : {})}
        {...(walkthroughAnnotations === undefined
          ? {}
          : { annotations: walkthroughAnnotations })}
        {...(walkthroughDiscussionAvailable
          ? {}
          : { discussionUnavailable: true })}
        focused={walkthroughFocused}
        onFocusedChange={setWalkthroughFocused}
        actions={{
          onMarkSectionReviewed: (sectionId) => {
            const next = reviewedWalkthroughSections.includes(sectionId)
              ? reviewedWalkthroughSections
              : [...reviewedWalkthroughSections, sectionId];
            setReviewedWalkthroughSections(next);
            saveWalkthroughProgress({
              reviewedSectionIds: next,
              supportReviewed,
              ...(currentWalkthroughSection === undefined
                ? {}
                : { currentSectionId: currentWalkthroughSection }),
            });
          },
          onMarkSupportReviewed: () => {
            setSupportReviewed(true);
            saveWalkthroughProgress({
              reviewedSectionIds: reviewedWalkthroughSections,
              supportReviewed: true,
              ...(currentWalkthroughSection === undefined
                ? {}
                : { currentSectionId: currentWalkthroughSection }),
            });
          },
          onSelectSection: (sectionId) => {
            setCurrentWalkthroughSection(sectionId);
            saveWalkthroughProgress({
              reviewedSectionIds: reviewedWalkthroughSections,
              supportReviewed,
              currentSectionId: sectionId,
            });
          },
        }}
      />
    ) : null;
  const retainedReader = retainedAnalysis ?? retainedWalkthrough;
  const walkthroughFocusActive =
    selectedInsight === "walkthrough" && walkthroughFocused;
  return (
    <section
      aria-label="Review insights"
      className="flex h-full min-h-0 w-full flex-col gap-2"
    >
      <div className="flex h-full min-h-0 flex-1 flex-col gap-2">
        {walkthroughFocusActive ? null : (
          <nav
            aria-label="Insight navigation"
            className="flex shrink-0 items-center gap-2 overflow-x-auto border-b pb-2"
          >
            <Button
              variant="outline"
              size="sm"
              disabled={navigateToFiles === undefined}
              onClick={navigateToFiles}
            >
              Files
            </Button>
            <InsightRailButton
              selected={selectedInsight === "overview"}
              onClick={() => setSelectedInsight("overview")}
              title="Overview"
              status="Current"
            />
            <InsightRailButton
              selected={selectedInsight === "analysis"}
              onClick={() => setSelectedInsight("analysis")}
              title="Analysis"
              status={insightStatusLabel(workbench.insights.analysis.status)}
              {...(workbench.insights.analysis.retained === undefined
                ? {}
                : { revision: workbench.insights.analysis.retained.headSha })}
            />
            <InsightRailButton
              selected={selectedInsight === "walkthrough"}
              onClick={() => setSelectedInsight("walkthrough")}
              title="Walkthrough"
              status={insightStatusLabel(workbench.insights.walkthrough.status)}
              {...(workbench.insights.walkthrough.retained === undefined
                ? {}
                : {
                    revision: workbench.insights.walkthrough.retained.headSha,
                  })}
            />
          </nav>
        )}
        <article
          aria-label={
            selectedInsight === "overview"
              ? "Insight overview"
              : `${selectedInsight} document`
          }
          data-review-insight-document={selectedInsight}
          className={`flex h-full min-h-0 min-w-0 flex-1 flex-col ${selectedInsight === "walkthrough" ? "overflow-hidden" : "overflow-auto"}`}
        >
          {selectedInsight === "overview" ? (
            <InsightOverview
              analysis={workbench.insights.analysis}
              walkthrough={workbench.insights.walkthrough}
              onSelect={setSelectedInsight}
            />
          ) : (
            <>
              {walkthroughFocusActive ? null : (
                <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b pb-2">
                  <div className="min-w-0">
                    {selectedInsight === "analysis" ? null : (
                      <>
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {selectedInsight}
                        </p>
                        <h2 className="truncate text-lg font-semibold">
                          {selectedInsight === "walkthrough" &&
                          workbench.insights.walkthrough.retained !== undefined
                            ? workbench.insights.walkthrough.retained.value
                                .title
                            : "Walkthrough document"}
                        </h2>
                      </>
                    )}
                    <p className="truncate text-sm text-muted-foreground">
                      {selectedRetained === undefined
                        ? "No retained result for this revision."
                        : selectedIsOutdated
                          ? `Retained revision ${selectedRetained.headSha.slice(0, 8)} · current revision ${currentRevision.slice(0, 8)} · ${formatInsightTimestamp(selectedRetained.generatedAt)}`
                          : `Retained from ${selectedRetained.headSha.slice(0, 8)} · ${formatInsightTimestamp(selectedRetained.generatedAt)}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {selectedRunning?.busy ||
                    selectedProjection?.status === "running" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={selectedRunning?.cancel}
                      >
                        Cancel
                      </Button>
                    ) : analysisFirstRunActive ||
                      selectedIsOutdated ||
                      selectedProjection?.status === "failed" ||
                      selectedProjection?.retained === undefined ? null : (
                      <Button
                        size="sm"
                        onClick={() => openRunDialog("regenerate")}
                        disabled={!runEnabled}
                      >
                        Regenerate
                      </Button>
                    )}
                  </div>
                </header>
              )}
              {catalogError ||
              !hasAvailableProvider ||
              (provider === "pi" && models.length === 0) ? (
                <p role="alert" className="py-2 text-sm text-destructive">
                  {catalogError || !hasAvailableProvider
                    ? "No eligible model configured. Set an API key or ambient provider credentials in the Electron process, then reload."
                    : "No Pi model is configured. Open a run and select Codex CLI account to load its models."}
                </p>
              ) : null}
              {progressError ? (
                <p role="alert" className="py-2 text-sm text-destructive">
                  Walkthrough progress could not be saved.
                </p>
              ) : null}
              {selectedProjection?.artifactStatus === "mismatch" ? (
                <InsightArtifactMismatch type={selectedInsight} />
              ) : null}
              <div
                data-review-insight-content
                className={`flex min-h-0 flex-col gap-4 ${selectedInsight === "walkthrough" ? "flex-1 overflow-hidden" : ""}`}
              >
                {selectedRunning?.busy ||
                selectedProjection?.status === "running" ? (
                  <InsightRunning
                    type={selectedInsight}
                    projection={selectedProjection}
                  />
                ) : selectedProjection?.status === "failed" ? (
                  <InsightFailed
                    projection={selectedProjection}
                    onRetry={() => openRunDialog("retry")}
                    {...(retainedDescription === undefined
                      ? {}
                      : { retainedDescription })}
                  />
                ) : selectedIsOutdated ? (
                  <InsightOutdated
                    type={selectedInsight}
                    onRetry={() => openRunDialog("retry")}
                    {...(selectedRetained === undefined
                      ? {}
                      : { retainedRevision: selectedRetained.headSha })}
                    currentRevision={currentRevision}
                  />
                ) : retainedReader === null ? (
                  <InsightEmpty
                    type={selectedInsight}
                    onRun={() => openRunDialog("run")}
                    disabled={!runEnabled}
                  />
                ) : null}
                {retainedReader === null ? null : (
                  <div
                    className={
                      selectedInsight === "walkthrough"
                        ? "min-h-0 flex-1 overflow-hidden"
                        : ""
                    }
                  >
                    {retainedReader}
                  </div>
                )}
              </div>
            </>
          )}
        </article>
      </div>
      <p className="sr-only" aria-live="polite">
        {insightLiveStatus(analysisRun.status, walkthroughRun.status)}
      </p>
      {runDialogType === null ? null : (
        <InsightRunDialog
          open
          type={runDialogType}
          action={runDialogAction}
          models={models}
          model={model}
          provider={provider}
          codexActivationPending={codexActivationPending}
          codexActivationError={codexActivationError}
          reasoning={reasoning}
          onOpenChange={(open) => {
            if (!open) closeRunDialog();
          }}
          onModelChange={(nextModel) => {
            setModel(nextModel);
            const selected = models.find(
              (candidate) => candidate.id === nextModel,
            );
            if (
              selected !== undefined &&
              selected.reasoning !== undefined &&
              !selected.reasoning.includes(reasoning)
            ) {
              setReasoning(selected.reasoning[0] ?? "medium");
            }
          }}
          onProviderChange={changeProvider}
          onActivateCodex={activateCodex}
          onReasoningChange={setReasoning}
          onConfirm={confirmRun}
        />
      )}
    </section>
  );
}

function formatInsightTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function InsightRailButton({
  selected,
  onClick,
  title,
  status,
  revision,
}: {
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly title: string;
  readonly status: string;
  readonly revision?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      className={`inline-flex shrink-0 items-baseline gap-1.5 rounded-md border px-3 py-1.5 text-left text-sm ${selected ? "border-primary bg-accent" : "hover:bg-accent"}`}
      onClick={onClick}
    >
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">
        {status}
        {revision === undefined ? "" : ` · ${revision.slice(0, 8)}`}
      </span>
    </button>
  );
}

function InsightOverview({
  analysis,
  walkthrough,
  onSelect,
}: {
  readonly analysis: InsightProjection;
  readonly walkthrough: InsightProjection;
  readonly onSelect: (value: "analysis" | "walkthrough") => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Insights overview</h2>
        <p className="text-sm text-muted-foreground">
          Choose one retained document. Analysis and Walkthrough run
          independently.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          className="rounded-md border p-4 text-left hover:bg-accent"
          onClick={() => onSelect("analysis")}
        >
          <p className="font-medium">Analysis</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {insightStatusLabel(analysis.status)} ·{" "}
            {analysis.retained === undefined
              ? "No retained result"
              : "Retained result available"}
          </p>
        </button>
        <button
          type="button"
          className="rounded-md border p-4 text-left hover:bg-accent"
          onClick={() => onSelect("walkthrough")}
        >
          <p className="font-medium">Walkthrough</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {insightStatusLabel(walkthrough.status)} ·{" "}
            {walkthrough.retained === undefined
              ? "No retained result"
              : "Retained result available"}
          </p>
        </button>
      </div>
    </div>
  );
}

function InsightRunning({
  type,
  projection,
}: {
  readonly type: "analysis" | "walkthrough";
  readonly projection: InsightProjection | undefined;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 py-6">
      <h3 className="font-medium">
        {type === "analysis" ? "Analysis" : "Walkthrough"} is running
      </h3>
      <p className="text-sm text-muted-foreground">
        {projection?.activeRun === undefined
          ? "Preparing a bounded run…"
          : `Started ${projection.activeRun.startedAt}. Partial results are not shown.`}
      </p>
      <Spinner />
    </div>
  );
}

function InsightFailed({
  projection,
  onRetry,
  retainedDescription,
}: {
  readonly projection: InsightProjection;
  readonly onRetry: () => void;
  readonly retainedDescription?: string;
}): React.JSX.Element {
  const failure = projection.replacementFailure;
  const message =
    failure?.category === undefined
      ? projection.retained === undefined
        ? "This Insight run failed. No retained result is available."
        : "This Insight run failed. The previous retained result remains available below."
      : failureMessage(failure.category);
  return (
    <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 border border-amber-500/50 bg-amber-500/10 px-3 py-4">
      <p role="alert" className="text-sm text-amber-900 dark:text-amber-100">
        {message}
      </p>
      {projection.retained === undefined ? (
        <p className="text-sm text-muted-foreground">
          No retained result is available.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Retained evidence from {projection.retained.headSha.slice(0, 8)} is
          still readable: {retainedDescription ?? "retained document"}
        </p>
      )}
      <Button size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function failureMessage(category: InsightFailureCategory | undefined): string {
  switch (category) {
    case "authentication_required":
      return "Authentication is required. Sign in to the provider, then run this Insight again.";
    case "rate_limited":
      return "The provider rate limit was reached. Wait a moment, then run this Insight again.";
    case "runtime_unavailable":
      return "The Insight runtime is unavailable. Check the local runtime, then try again.";
    case "timed_out":
      return "The Insight run timed out. Try again or choose a smaller scope.";
    case "execution_failed":
      return "The Insight could not complete. Check the run options and try again.";
    case "invalid_result":
      return "The Insight returned an invalid result. Try again.";
    case "unexpected_failure":
      return "The Insight failed unexpectedly. Try again.";
    default:
      return "This Insight run failed.";
  }
}

function InsightOutdated({
  type,
  onRetry,
  retainedRevision,
  currentRevision,
}: {
  readonly type: "analysis" | "walkthrough";
  readonly onRetry: () => void;
  readonly retainedRevision?: string;
  readonly currentRevision: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 py-6">
      <h3 className="font-medium">
        {type === "analysis" ? "Analysis" : "Walkthrough"} is outdated
      </h3>
      <p className="text-sm text-muted-foreground">
        Retained revision {retainedRevision?.slice(0, 8) ?? "unknown"} differs
        from current revision {currentRevision.slice(0, 8)}. This evidence
        remains readable, but it cannot navigate current code or change the
        Review draft.
      </p>
      <Button size="sm" onClick={onRetry}>
        Run for latest revision
      </Button>
    </div>
  );
}

function InsightArtifactMismatch({
  type,
}: {
  readonly type: "analysis" | "walkthrough" | "overview";
}): React.JSX.Element {
  return (
    <p
      role="alert"
      className="border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      Stored {type === "overview" ? "Insight" : type} source bytes do not match
      the retained revision. Source scope and hunk navigation are unavailable;
      the bounded document remains readable.
    </p>
  );
}

function InsightEmpty({
  type,
  onRun,
  disabled,
}: {
  readonly type: "analysis" | "walkthrough";
  readonly onRun: () => void;
  readonly disabled: boolean;
}): React.JSX.Element {
  return (
    <div className="flex max-w-2xl flex-col items-start gap-3 py-6">
      <h3 className="font-medium">No {type} has been generated</h3>
      <p className="text-sm text-muted-foreground">
        Run this optional Insight for the represented Review snapshot.
      </p>
      <Button
        size="sm"
        className="self-start"
        onClick={onRun}
        disabled={disabled}
      >
        {type === "analysis" ? "Generate analysis" : "Generate Walkthrough"}
      </Button>
    </div>
  );
}

type InsightProjection =
  | WorkbenchResponse["insights"]["analysis"]
  | WorkbenchResponse["insights"]["walkthrough"];
function InsightCard({
  title,
  description,
  projection,
  runStatus,
  failureReason,
  busy,
  onRun,
  onCancel,
  disabled,
  findings,
  onAddFinding,
  onOpen,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly projection: InsightProjection;
  readonly runStatus: string;
  readonly failureReason?:
    "cancelled" | "failed" | "invalid_result" | "superseded";
  readonly busy: boolean;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly disabled: boolean;
  readonly findings?: ReadonlyArray<AnalysisFinding>;
  readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void>;
  readonly onOpen?: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const [actionError, setActionError] = useState(false);
  const status = busy && runStatus !== "idle" ? runStatus : projection.status;
  const addFinding = async (finding: AnalysisFinding): Promise<void> => {
    if (onAddFinding === undefined) return;
    setActionError(false);
    try {
      await onAddFinding(finding);
    } catch {
      setActionError(true);
    }
  };
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          <Badge
            variant={
              status === "failed" || status === "error"
                ? "destructive"
                : "secondary"
            }
          >
            {insightStatusLabel(status)}
          </Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-20 flex-col gap-2">
        {actionError ? (
          <p role="alert" className="text-xs text-destructive">
            The Finding action could not be saved. Try again.
          </p>
        ) : null}
        {failureReason === "failed" ? (
          <p role="alert" className="text-xs text-destructive">
            The provider could not complete this run. Check model access,
            credentials, or usage limits, then try again.
          </p>
        ) : null}
        {failureReason === "invalid_result" ? (
          <p role="alert" className="text-xs text-destructive">
            The provider returned an invalid result. Try again with a different
            model.
          </p>
        ) : null}
        {failureReason === "superseded" ? (
          <p role="alert" className="text-xs text-destructive">
            This run became outdated after the Review changed. Refresh before
            trying again.
          </p>
        ) : null}
        {busy ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Generating a bounded result…
          </div>
        ) : null}
        {children !== undefined ? (
          <p className="line-clamp-4 text-sm text-muted-foreground">
            {children}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No retained result for this revision.
          </p>
        )}
        {findings === undefined ||
        findings.length === 0 ||
        onAddFinding === undefined ? null : (
          <ul className="flex flex-col gap-2 border-t pt-2">
            {findings.slice(0, 5).map((finding) => (
              <li
                key={finding.id}
                className="flex items-start justify-between gap-2 text-xs"
              >
                <span className="min-w-0 truncate">{finding.title}</span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => addFinding(finding)}
                >
                  Add
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <CardFooter className="flex gap-2">
        {onOpen !== undefined ? (
          <Button
            variant="outline"
            onClick={onOpen}
            aria-label={`Open ${title}`}
          >
            Open
          </Button>
        ) : null}
        {busy ? (
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button onClick={onRun} disabled={disabled}>
            {projection.retained === undefined ? "Run" : "Regenerate"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

void InsightCard;

function insightLiveStatus(analysis: string, walkthrough: string): string {
  const active = [analysis, walkthrough].filter((status) => status !== "idle");
  return active.length === 0
    ? ""
    : `Analysis ${analysis}; Walkthrough ${walkthrough}`;
}

function DraftSlot({
  workbench,
  onWorkbenchPatch,
  onWorkbenchReplace,
  onRefreshAfterPublication,
  canEditDraft,
  canWriteGitHub,
  selectedRepairAnchor,
  initialExpanded,
  autoOpenPublication,
  onAutoOpenPublicationConsumed,
}: {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onRefreshAfterPublication: () => Promise<void>;
  readonly canEditDraft: boolean;
  readonly canWriteGitHub: boolean;
  readonly selectedRepairAnchor?: ReviewAnchor;
  readonly initialExpanded?: boolean;
  readonly autoOpenPublication: boolean;
  readonly onAutoOpenPublicationConsumed: () => void;
}): React.JSX.Element | null {
  const focusPublishedFeedback = usePublishedFeedbackNavigation();
  const draftProjection = workbench.draft ?? emptyDraftForWorkbench(workbench);
  const batch = parseReviewBatch(draftProjection);
  if (batch._tag === "err") return null;
  const postCommand = async (command: unknown): Promise<void> => {
    const value = await requestJson("/v1/reviews/batch", {
      method: "POST",
      body: {
        profileId: workbench.session.key.profileId,
        sessionId: workbench.session.id,
        expectedRevision: draftProjection.updatedAt,
        command,
      },
    });
    const next = parseBatchResponse(value);
    if (next === undefined) throw new Error("Invalid Review batch response");
    onWorkbenchPatch({ draft: next });
  };
  const writeIdentity = {
    reviewId: workbench.review.id,
    expectedHeadSha: workbench.revision.reviewedHeadSha,
    ...(workbench.revision.patchHash === undefined
      ? {}
      : { expectedPatchHash: workbench.revision.patchHash }),
  };
  const actions: ReviewBatchPanelActions = {
    addInlineComment: async (input) =>
      postCommand({
        _tag: "AddInlineComment",
        anchor: {
          path: input.path,
          startLine: input.startLine,
          line: input.line,
          side: input.side,
        },
        ...(input.fingerprint === undefined
          ? {}
          : { fingerprint: input.fingerprint }),
        body: input.body,
      }),
    removeItem: async (itemId) => postCommand({ _tag: "RemoveItem", itemId }),
    addThreadReply: async (threadId, body) =>
      postCommand({ _tag: "AddThreadReply", threadId, body }),
    setThreadState: async (threadId, action) =>
      postCommand({ _tag: "SetThreadState", threadId, action }),
    updateBody: async (body) => postCommand({ _tag: "UpdateBody", body }),
    setSuggestedEvent: async (event) =>
      postCommand({ _tag: "SetSuggestedEvent", event }),
    setItemIncluded: async (itemId, include) =>
      postCommand({ _tag: "SetItemIncluded", itemId, include }),
    editItem: async (itemId, body) =>
      postCommand({ _tag: "EditItem", itemId, body }),
    repairInlineAnchor: async (itemId, anchor, fingerprint) =>
      postCommand({ _tag: "RepairInlineAnchor", itemId, anchor, fingerprint }),
    convertInlineToGeneral: async (itemId) =>
      postCommand({ _tag: "ConvertInlineToGeneral", itemId }),
    apply: async () => {
      const value = await requestJson("/v1/reviews/apply-batch", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          sessionId: workbench.session.id,
          ...writeIdentity,
          expectedRevision: draftProjection.updatedAt,
          acknowledgement: true,
        },
      });
      const next = parseBatchResponse(value);
      if (next !== undefined) onWorkbenchPatch({ draft: next });
    },
    submit: async (event) => {
      const value = await requestJson("/v1/reviews/submit-batch", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          sessionId: workbench.session.id,
          ...writeIdentity,
          expectedRevision: draftProjection.updatedAt,
          acknowledgement: true,
          event,
        },
      });
      const next = parseBatchResponse(value);
      if (next !== undefined) onWorkbenchPatch({ draft: next });
    },
  };
  const recoveryEvidence =
    batch.value.state._tag === "Applying" ||
    (batch.value.state._tag === "PartialFailure" &&
      (batch.value.state.failure.category === "outcome_unknown" ||
        batch.value.state.failure.category === "unavailable"))
      ? {
          confirmed: batch.value.receipts.map((receipt) =>
            receipt._tag === "PendingReviewCreated"
              ? `Pending review ${receipt.reviewId}`
              : receipt._tag === "ReplyCreated"
                ? `Reply ${receipt.itemId}`
                : `Thread ${receipt.itemId} ${receipt.state}`,
          ),
          notConfirmed: [
            `${batch.value.state.operation._tag.replaceAll(/([A-Z])/g, " $1").trim()} is held for reconciliation`,
          ],
          unableToVerify:
            batch.value.state._tag === "Applying"
              ? "GitHub must be checked before any further action."
              : batch.value.state.failure.message,
        }
      : undefined;
  const publication =
    batch.value.state._tag === "Local" ||
    batch.value.state._tag === "Applying" ||
    batch.value.state._tag === "PartialFailure"
      ? {
          // Applying is durable evidence that the remote boundary may have been
          // crossed. Keep recovery reachable after reload rather than presenting a
          // permanently busy dialog with no safe action.
          state:
            batch.value.state._tag === "Applying" ||
            (batch.value.state._tag === "PartialFailure" &&
              (batch.value.state.failure.category === "outcome_unknown" ||
                batch.value.state.failure.category === "unavailable"))
              ? ("needs_confirmation" as const)
              : ("ready" as const),
          ...(recoveryEvidence === undefined ? {} : { recoveryEvidence }),
          preview: async () => {
            const value = await requestJson("/v1/reviews/publication/preview", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                ...writeIdentity,
                sessionId: workbench.session.id,
                expectedRevision: batch.value.updatedAt,
                event: batch.value.suggestedEvent,
              },
            });
            const parsed = parsePublicationPreview(value);
            if (parsed === undefined)
              throw new Error("Invalid publication preview response");
            return parsed;
          },
          confirm: async () => {
            const value = await requestJson("/v1/reviews/publication/confirm", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                ...writeIdentity,
                sessionId: workbench.session.id,
                expectedRevision: batch.value.updatedAt,
                acknowledgement: true,
                event: batch.value.suggestedEvent,
              },
            });
            const next = parseBatchResponse(value);
            if (next === undefined)
              throw new Error("Invalid publication response");
            // Confirmed publication changes GitHub-owned feedback. Refresh through
            // the canonical read owner before loading the projection used by View
            // feedback, so focus lands on the actual newly published records.
            await onRefreshAfterPublication();
            const projectedValue = await requestJson("/v1/reviews/load", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                reviewId: workbench.review.id,
              },
            });
            const projected = parseWorkbenchResponse(projectedValue);
            if (projected === undefined)
              throw new Error("Invalid publication projection");
            onWorkbenchReplace(projected);
          },
          recover: async () => {
            const value = await requestJson("/v1/reviews/publication/recover", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                reviewId: workbench.review.id,
              },
            });
            const next = parseWorkbenchResponse(value);
            if (next !== undefined) onWorkbenchReplace(next);
          },
          openGitHub: async () => {
            const host = parseGitHubHost(workbench.session.key.host);
            const owner = parseGitHubOwner(workbench.session.key.owner);
            const repo = parseGitHubRepoName(workbench.session.key.repo);
            const number = parsePullRequestNumber(
              workbench.session.key.prNumber,
            );
            if (
              host._tag === "err" ||
              owner._tag === "err" ||
              repo._tag === "err" ||
              number._tag === "err"
            )
              return;
            const pr: PullRequestRef = {
              host: host.value,
              owner: owner.value,
              repo: repo.value,
              number: number.value,
            };
            await openPullRequestExternalUrl(
              pullRequestPageUrl(pr).toString(),
              pr,
            );
          },
          viewFeedback: () => {
            focusPublishedFeedback?.();
          },
        }
      : undefined;
  return (
    <ReviewDraftDock
      batch={batch.value}
      {...(workbench.fullPatch === undefined
        ? {}
        : { patch: workbench.fullPatch })}
      {...(selectedRepairAnchor === undefined ? {} : { selectedRepairAnchor })}
      writeBlocked={!canWriteGitHub}
      draftEditingBlocked={!canEditDraft}
      {...(initialExpanded === undefined
        ? {}
        : { initialOpen: initialExpanded })}
      actions={actions}
      {...(publication === undefined ? {} : { publication })}
      autoOpenPublication={autoOpenPublication}
      onAutoOpenPublicationConsumed={onAutoOpenPublicationConsumed}
    />
  );
}

function emptyDraftForWorkbench(
  workbench: WorkbenchResponse,
): NonNullable<WorkbenchResponse["draft"]> {
  const timestamp = workbench.revision.refreshedAt;
  return {
    sessionId: `${workbench.session.key.host}__${workbench.session.key.owner}__${workbench.session.key.repo}__pr-${workbench.session.key.prNumber}__sha-${workbench.session.key.headSha.slice(0, 8)}__${workbench.session.key.headSha.slice(0, 12)}`,
    state: { _tag: "Local" },
    summaryBody: "",
    suggestedEvent: "COMMENT",
    items: [],
    receipts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Renderer-boundary codec for direct conversation receipts. The main process
 * is trusted to shape its own success envelope, but the renderer must not
 * treat an unknown or malformed success payload as a confirmed mutation: no
 * command callback casts raw JSON to a receipt anymore.
 */
type DirectConversationReceipt =
  | {
      readonly _tag: "CommentCreated";
      readonly commentId: string;
      readonly reviewId?: string;
    }
  | {
      readonly _tag: "ReplyCreated";
      readonly commentId: string;
      readonly reviewId?: string;
    }
  | {
      readonly _tag: "ThreadStateChanged";
      readonly threadId: GitHubThreadId;
      readonly state: "open" | "resolved";
    }
  | { readonly _tag: "CommentEdited"; readonly commentId: string }
  | { readonly _tag: "CommentDeleted"; readonly commentId: string };

function parseDirectConversationReceipt(
  value: unknown,
): DirectConversationReceipt | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const tag = record._tag;
  if (tag === "CommentCreated" || tag === "ReplyCreated") {
    if (typeof record.commentId !== "string" || record.commentId.length === 0)
      return undefined;
    if (
      record.reviewId !== undefined &&
      (typeof record.reviewId !== "string" || record.reviewId.length === 0)
    )
      return undefined;
    return {
      _tag: tag,
      commentId: record.commentId,
      ...(record.reviewId === undefined ? {} : { reviewId: record.reviewId }),
    };
  }
  if (tag === "ThreadStateChanged") {
    if (record.state !== "open" && record.state !== "resolved")
      return undefined;
    const parsedThreadId = parseGitHubThreadId(record.threadId);
    if (parsedThreadId._tag === "err") return undefined;
    return {
      _tag: "ThreadStateChanged",
      threadId: parsedThreadId.value,
      state: record.state,
    };
  }
  if (tag === "CommentEdited" || tag === "CommentDeleted") {
    if (typeof record.commentId !== "string" || record.commentId.length === 0)
      return undefined;
    return { _tag: tag, commentId: record.commentId };
  }
  return undefined;
}

function parseBatchResponse(
  value: unknown,
): WorkbenchResponse["draft"] | undefined {
  if (typeof value !== "object" || value === null || !("batch" in value))
    return undefined;
  return parseReviewBatchProjection(value.batch);
}

function insightStatusLabel(status: string): string {
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
    case "error":
      return "Error";
    case "idle":
      return "Idle";
    default:
      return status;
  }
}

/** Stable identity of one represented Review projection; changes when an explicit refresh replaces it. */
function snapshotKey(workbench: WorkbenchResponse): string {
  return `${workbench.review.id}:${workbench.session.id}:${workbench.revision.reviewedHeadSha}:${workbench.revision.refreshedAt}`;
}

function isDetection(
  value: unknown,
): value is { readonly updatesAvailable: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "updatesAvailable" in value &&
    typeof value.updatesAvailable === "boolean"
  );
}

function isReviewObservation(
  value: unknown,
):
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Reconciled"; readonly projection?: unknown }
  | { readonly _tag: "RevisionChanged" }
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Terminal"; readonly status: "merged" | "closed" }
  | undefined {
  if (typeof value !== "object" || value === null || !("_tag" in value))
    return undefined;
  if (
    value._tag === "Unchanged" ||
    value._tag === "RevisionChanged" ||
    value._tag === "Unavailable"
  )
    return { _tag: value._tag };
  if (value._tag === "Reconciled")
    return {
      _tag: "Reconciled",
      ...("projection" in value ? { projection: value.projection } : {}),
    };
  if (
    value._tag === "Terminal" &&
    "status" in value &&
    (value.status === "merged" || value.status === "closed")
  )
    return { _tag: "Terminal", status: value.status };
  return undefined;
}
