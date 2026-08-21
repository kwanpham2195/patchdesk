import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import * as v from "valibot";

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
} from "../components/review-workbench";
import type { AssigneesSectionActions } from "../components/assignee-picker";
import type { LabelPickerActions } from "../components/label-picker";
import type { ReviewNavigatorSection } from "../components/review-navigator";
import type { PullRequestOverviewMerge } from "../components/pr-overview-sheet";
import type { LocalCommentAuthoring } from "../components/review-diff-view";
import type { PendingReviewComposerActions } from "../components/review-diff-view";
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
import {
  parseAssignableUserListResponse,
  parseCommitDiffResponse,
  parseDirectSummaryReviewResponse,
  parseInsightProviderCatalog,
  parsePendingReviewProjection,
  parseRepositoryLabelListResponse,
  parseWorkbenchResponse,
  type AssignableUserListResponse,
  type CommitDiffResponse,
  type DirectSummaryReviewProjection,
  type PendingReviewProjection,
  type RepositoryLabelListResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import type { InsightFailureCategory } from "../../../domain/insight-record";
import type { PullRequestRef } from "../../../domain/pull-request";

import { useInsightRun } from "../hooks/use-insight-run";
import { useLatestCommitted } from "../hooks/use-latest-committed";
import { projectReadOnlyConversationAnnotations } from "../inline-conversation-mapping";

const insightTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Shallow envelope shape for a command response that may carry a pending-review projection; the nested field's own deep validation happens in `parsePendingReviewProjection`. */
const pendingReviewEnvelopeSchema = v.looseObject({
  pendingReview: v.optional(v.unknown()),
});

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
    if (cause.kind === "forbidden")
      return "GitHub blocked this submission: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.";
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
    if (cause.kind === "forbidden")
      return "GitHub blocked this review summary: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.";
  }
  return "Patchdesk could not submit this review summary. Check GitHub again or refresh.";
}

/**
 * A stable value signature for a direct-summary projection, used to detect
 * when the server-sent projection actually changes (as opposed to merely
 * re-rendering with the same value). Distinct from the projection's
 * `state` alone so that two "confirmed" or "recovery_required" projections
 * with different payloads are treated as different values.
 */
function directSummarySignature(
  projection: DirectSummaryReviewProjection,
): string {
  if (projection.state === "confirmed")
    return `confirmed:${projection.receipt.reviewId}:${projection.receipt.event}`;
  if (projection.state === "recovery_required")
    return `recovery_required:${projection.resolution}`;
  return "idle";
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
// Pre-existing giant component (over 1250 lines before this change; verified
// via an isolated `--staged` scan of main's unmodified file, which still
// flags it, and `react-doctor --scope changed` against this plan's full diff,
// which reports zero new issues here). Splitting it is the renderer god-file
// refactor the project's own plans explicitly defer to dedicated,
// separately-scoped work (see the plans' "Findings Considered And Rejected"
// notes on `review-workbench-flow.tsx`), not a fix this plan should take on.
// react-doctor-disable-next-line react-doctor/no-giant-component -- see comment above
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
  const replaceWorkbenchRef = useLatestCommitted(replaceWorkbench);
  // Freshness value the projection had before detection patched it stale, so a
  // later cleared flag can restore writes instead of leaving them blocked.
  const [detectedStaleFreshness, setDetectedStaleFreshness] = useState<
    "fresh" | "not_refreshed" | "unavailable" | undefined
  >(undefined);
  // Latest values live in refs so scheduled detector work uses the current
  // journal and projection without recreating the interval on every write.
  const workbenchRef = useLatestCommitted(workbench);
  const recentWritesRef = useLatestCommitted(recentWrites);
  const detectedStaleFreshnessRef = useLatestCommitted(detectedStaleFreshness);
  const refreshingRef = useLatestCommitted(refreshing);
  const [initialSnapshotKey] = useState(() => snapshotKey(workbench));
  const snapshotKeyRef = useRef(initialSnapshotKey);
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
  const onWorkbenchPatchRef = useLatestCommitted(onWorkbenchPatch);
  // Synchronous count of explicit refreshes whose network request is still
  // pending. Detection must not start while any refresh (toolbar or
  // post-publication) is in flight; the toolbar-only React state cannot be the
  // protocol guard because publication refresh never sets it.
  const refreshInFlightCountRef = useRef(0);
  // Unmount invalidates any detector request that is still awaiting the bridge.
  // The generation check then rejects its late result without touching the
  // callbacks owned by the closed workbench.
  useEffect(() => {
    return () => {
      generationRef.current += 1;
    };
  }, []);
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
      const detectUpdatesBody = {
        profileId: wb.session.key.profileId,
        reviewId: wb.review.id,
      };
      const value = await requestJson("/v1/reviews/detect-updates", {
        method: "POST",
        body:
          journal.length === 0
            ? detectUpdatesBody
            : { ...detectUpdatesBody, recentWrites: journal },
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
            replaceWorkbenchRef.current(next);
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
  }, [
    detectedStaleFreshnessRef,
    onWorkbenchPatchRef,
    recentWritesRef,
    replaceWorkbenchRef,
    workbenchRef,
  ]);

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
  }, [replaceWorkbench, workbenchRef]);

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
  }, [refreshingRef, requestRefresh, workbenchRef]);

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
    [onWorkbenchPatchRef, replaceWorkbench, runDirectCommand, workbenchRef],
  );
  const saveInlineComment = useCallback(
    async (
      input: Parameters<NonNullable<LocalCommentAuthoring["onSave"]>>[0],
    ): Promise<
      { readonly commentId: string; readonly threadId?: string } | void
    > => {
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
        const commentWrite = {
          _tag: "Comment" as const,
          commentId: receipt.commentId,
        };
        setRecentWrites((current) => [
          ...current,
          receipt.reviewId === undefined
            ? commentWrite
            : { ...commentWrite, reviewId: receipt.reviewId },
        ]);
        const created = { commentId: receipt.commentId };
        return receipt.threadId === undefined
          ? created
          : { ...created, threadId: receipt.threadId };
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
        const commentWrite = {
          _tag: "Comment" as const,
          commentId: receipt.commentId,
        };
        setRecentWrites((current) => [
          ...current,
          receipt.reviewId === undefined
            ? commentWrite
            : { ...commentWrite, reviewId: receipt.reviewId },
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
  // Labels are pull-request-level metadata, not diff-anchored (see
  // `LabelService`'s own doc comment), so this gates on the Review still
  // being open rather than `canWriteDirectConversation`'s stricter
  // freshness/patchHash requirements.
  const canWriteLabels = workbench.review.status === "open";
  const fetchLabels = useCallback(async (): Promise<
    RepositoryLabelListResponse | undefined
  > => {
    const value = await requestJson(
      `/v1/reviews/labels?profileId=${encodeURIComponent(workbench.session.key.profileId)}&reviewId=${encodeURIComponent(workbench.review.id)}`,
    );
    return parseRepositoryLabelListResponse(value);
  }, [workbench]);
  const addLabels = useCallback(
    async (
      labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    ): Promise<void> => {
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/labels/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: { _tag: "AddLabels", labels },
          },
        }),
      );
      const receipt = parseLabelReceipt(value);
      if (receipt?._tag === "LabelsAdded") {
        setRecentWrites((current) => [
          ...current,
          { _tag: "LabelChange", added: receipt.added, removed: [] },
        ]);
      }
    },
    [workbench, runDirectCommand],
  );
  const removeLabels = useCallback(
    async (
      labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    ): Promise<void> => {
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/labels/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: { _tag: "RemoveLabels", labels },
          },
        }),
      );
      const receipt = parseLabelReceipt(value);
      if (receipt?._tag === "LabelsRemoved") {
        setRecentWrites((current) => [
          ...current,
          { _tag: "LabelChange", added: [], removed: receipt.removed },
        ]);
      }
    },
    [workbench, runDirectCommand],
  );
  // Assignees are pull-request-level metadata, gated the same way as labels
  // above (see `canWriteLabels`'s comment).
  const canWriteAssignees = workbench.review.status === "open";
  const fetchAssignableUsers = useCallback(
    async (query?: string): Promise<AssignableUserListResponse | undefined> => {
      const queryField =
        query === undefined || query === ""
          ? ""
          : `&query=${encodeURIComponent(query)}`;
      const value = await requestJson(
        `/v1/reviews/assignees?profileId=${encodeURIComponent(workbench.session.key.profileId)}&reviewId=${encodeURIComponent(workbench.review.id)}${queryField}`,
      );
      return parseAssignableUserListResponse(value);
    },
    [workbench],
  );
  const addAssignees = useCallback(
    async (
      assignees: ReadonlyArray<{ readonly id: string; readonly login: string }>,
    ): Promise<void> => {
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/assignees/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: { _tag: "AddAssignees", assignees },
          },
        }),
      );
      const receipt = parseAssigneeReceipt(value);
      if (receipt?._tag === "AssigneesAdded") {
        setRecentWrites((current) => [
          ...current,
          { _tag: "AssigneeChange", added: receipt.added, removed: [] },
        ]);
      }
    },
    [workbench, runDirectCommand],
  );
  const removeAssignees = useCallback(
    async (
      assignees: ReadonlyArray<{ readonly id: string; readonly login: string }>,
    ): Promise<void> => {
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/assignees/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: { _tag: "RemoveAssignees", assignees },
          },
        }),
      );
      const receipt = parseAssigneeReceipt(value);
      if (receipt?._tag === "AssigneesRemoved") {
        setRecentWrites((current) => [
          ...current,
          { _tag: "AssigneeChange", added: [], removed: receipt.removed },
        ]);
      }
    },
    [workbench, runDirectCommand],
  );
  // The authenticated account is resolved server-side (never from anything
  // the renderer believes about who is signed in): the command carries no
  // identity, only the `AssignSelf` tag, and the receipt's `added` logins
  // are the server's own answer for who actually got assigned.
  const assignSelf = useCallback(async (): Promise<ReadonlyArray<string>> => {
    const value = await runDirectCommand(() =>
      requestJson("/v1/reviews/assignees/command", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          reviewId: workbench.review.id,
          command: { _tag: "AssignSelf" },
        },
      }),
    );
    const receipt = parseAssigneeReceipt(value);
    if (receipt?._tag === "AssigneesAdded") {
      setRecentWrites((current) => [
        ...current,
        { _tag: "AssigneeChange", added: receipt.added, removed: [] },
      ]);
      return receipt.added;
    }
    return [];
  }, [workbench, runDirectCommand]);
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
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this callback is itself the JSON I/O boundary parser shared by every command response that may carry a pending-review projection; there is no earlier boundary to run it at.
    (value: unknown): PendingReviewProjection | undefined => {
      const envelope = v.safeParse(pendingReviewEnvelopeSchema, value);
      const projection = parsePendingReviewProjection(
        envelope.success ? envelope.output.pendingReview : undefined,
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
        const requestCommand =
          command._tag === "Discard"
            ? {
                _tag: "Discard" as const,
                expected,
                confirmation: command.confirmation,
              }
            : command._tag === "Submit"
              ? {
                  _tag: "Submit" as const,
                  expected,
                  event: command.event,
                  summaryBody: command.summaryBody,
                }
              : command._tag === "AddThread"
                ? {
                    _tag: "AddThread" as const,
                    expected,
                    anchor: command.anchor,
                    body: command.body,
                    pendingReviewNodeId: command.pendingReviewNodeId,
                  }
                : {
                    _tag: "Start" as const,
                    expected,
                    anchor: command.anchor,
                    body: command.body,
                  };
        const value = await requestJson(
          "/v1/reviews/pending-review/command",
          {
            method: "POST",
            body: {
              profileId: workbench.session.key.profileId,
              reviewId: workbench.review.id,
              command: requestCommand,
            },
          },
        );
        const projection = applyPendingReviewProjection(value);
        setFinishDialogError(undefined);
        // Journal the exact pending-thread mutations so the detector never reads
        // this window's own Start/AddThread/Discard as a remote update. Entries
        // survive until an explicit refresh/reload replaces the represented
        // snapshot; a Submit keeps them because the threads persist remotely.
        if (command._tag === "Start" || command._tag === "AddThread") {
          const priorThreadIdSet = new Set(priorThreadIds);
          const added = threadIdsOf(projection).filter(
            (id) => !priorThreadIdSet.has(id),
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
    [applyPendingReviewProjection, onWorkbenchPatch, workbench],
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
  // The result of a command the renderer just issued (submit/recover) must
  // win over the server-sent projection until a genuinely newer projection
  // value arrives. `directSummaryOverride` holds that command result;
  // `observedDirectSummarySignature` tracks the last projection value seen
  // so a render-time comparison (not a useEffect) can drop the override the
  // moment the projection actually changes underneath it.
  const [directSummaryOverride, setDirectSummaryOverride] = useState<
    DirectSummaryReviewProjection | undefined
  >(undefined);
  const [observedDirectSummarySignature, setObservedDirectSummarySignature] =
    useState<string | undefined>(undefined);
  const projectedDirectSummary: DirectSummaryReviewProjection =
    workbench.directSummary ?? { state: "idle" };
  const projectedDirectSummarySignature = directSummarySignature(
    projectedDirectSummary,
  );
  if (projectedDirectSummarySignature !== observedDirectSummarySignature) {
    setObservedDirectSummarySignature(projectedDirectSummarySignature);
    setDirectSummaryOverride(undefined);
  }
  const observedDirectSummaryRef = useRef<string | undefined>(undefined);
  const visibleDirectSummaryState =
    directSummaryOverride ?? projectedDirectSummary;
  const observeDirectSummaryReceipt = useCallback(
    (reviewId: string): void => {
      if (observedDirectSummaryRef.current === reviewId) return;
      observedDirectSummaryRef.current = reviewId;
      void observeConfirmedDirectSummary(reviewId).catch(() => {
        // This read-only observer never retries the GitHub write.
      });
    },
    [observeConfirmedDirectSummary],
  );
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
        setDirectSummaryOverride(result);
        if (result.state === "confirmed") {
          const write = {
            _tag: "DirectSummaryReview" as const,
            reviewId: result.receipt.reviewId,
          };
          setRecentWrites((current) => [...current, write]);
          observeDirectSummaryReceipt(result.receipt.reviewId);
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
          setDirectSummaryOverride({
            state: "recovery_required",
            resolution: "check_required",
          });
        setDirectSummaryError(boundedDirectSummaryError(cause));
        throw cause;
      } finally {
        setDirectSummaryBusy(false);
      }
    },
    [observeDirectSummaryReceipt, runDirectCommand, workbench],
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
        setDirectSummaryOverride(result);
        if (result.state === "confirmed") {
          setRecentWrites((current) => [
            ...current,
            { _tag: "DirectSummaryReview", reviewId: result.receipt.reviewId },
          ]);
          observeDirectSummaryReceipt(result.receipt.reviewId);
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
    }, [observeDirectSummaryReceipt, runDirectCommand, workbench]);
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
              : { state: workbench.pendingReview.state },
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
            if (path._tag === "ok") void path;
          },
        }
      : undefined;
  const externalPullRequest = pullRequestExternalRef(workbench);
  const mergeActionBase =
    workbench.review.status === "open" &&
    workbench.revision.freshness === "fresh" &&
    workbench.revision.patchHash !== undefined
      ? {
          // SAFETY: the workbench projection's `mergeReadiness` is the wire
          // serialization of a domain `MergeReadiness` value that only ever
          // originates from `evaluateMergeReadiness`; the wire schema widens
          // `blockers`/`warnings` to `string[]` for forward-compatible
          // parsing, but the emitted values are always drawn from
          // `MergeReadiness`'s literal unions.
          readiness: workbench.mergeReadiness as MergeReadiness,
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
          onRecoverMerge: async () => {
            const recovered = await requestJson("/v1/reviews/merge/recover", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                reviewId: workbench.review.id,
              },
            });
            const next = parseWorkbenchResponse(recovered);
            if (next === undefined)
              throw new Error("Invalid recovered Review projection");
            replaceWorkbench(next);
          },
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
                expectedRevision: workbench.revision.refreshedAt,
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
  const mergeActionWithReasons =
    mergeActionBase === undefined || workbench.mergeReasons === undefined
      ? mergeActionBase
      : { ...mergeActionBase, mergeReasons: workbench.mergeReasons };
  const mergeAction: PullRequestOverviewMerge | undefined =
    mergeActionWithReasons === undefined || externalPullRequest === undefined
      ? mergeActionWithReasons
      : { ...mergeActionWithReasons, pullRequest: externalPullRequest };
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
      const findingLocationBase = {
        file: finding.file,
        lineStart: finding.lineStart,
      };
      const findingLocationWithEnd =
        finding.lineEnd === undefined
          ? findingLocationBase
          : { ...findingLocationBase, lineEnd: finding.lineEnd };
      const findingLocation =
        finding.diffSide === undefined
          ? findingLocationWithEnd
          : { ...findingLocationWithEnd, diffSide: finding.diffSide };
      const mapped = mapFindingLocation(
        parseUnifiedPatch(workbench.fullPatch),
        findingLocation,
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

  const pendingReviewPanelBase = {
    projection: workbench.pendingReview,
    busy: pendingReviewBusy,
    finishDialogOpen,
    onOpenFinishDialog: () => {
      setFinishDialogInitialSummary(undefined);
      setFinishDialogOpen(true);
    },
    onCloseFinishDialog: () => {
      setFinishDialogOpen(false);
      setFinishDialogInitialSummary(undefined);
    },
    onSubmit: async (
      event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
      summaryBody: string,
    ): Promise<void> => {
      try {
        await runPendingReviewCommand({ _tag: "Submit", event, summaryBody });
        setFinishDialogOpen(false);
      } catch (cause) {
        setFinishDialogError(boundedPendingReviewError(cause));
      }
    },
    onDiscard: async (): Promise<void> => {
      try {
        await runPendingReviewCommand({ _tag: "Discard", confirmation: true });
        setFinishDialogOpen(false);
      } catch (cause) {
        setFinishDialogError(boundedPendingReviewError(cause));
      }
    },
    onCheckGitHubAgain: checkGitHubAgain,
  };
  const pendingReviewPanelWithSummary =
    finishDialogInitialSummary === undefined
      ? pendingReviewPanelBase
      : { ...pendingReviewPanelBase, finishDialogInitialSummary };
  const pendingReviewPanelWithRecoveryError =
    finishDialogError === undefined
      ? pendingReviewPanelWithSummary
      : {
          ...pendingReviewPanelWithSummary,
          recoveryError: finishDialogError,
          finishDialogError,
        };
  const pendingReviewPanel =
    pendingReviewComposer === undefined
      ? undefined
      : pendingReviewPanelWithRecoveryError;

  const directSummaryPanelBase = {
    busy: directSummaryBusy,
    state: visibleDirectSummaryState.state,
    approvalCapability: workbench.directSummaryDecision ?? "unknown",
    onSubmit: submitDirectSummary,
    onRecover: recoverDirectSummary,
  };
  const directSummaryPanelWithReceipt =
    visibleDirectSummaryState.state === "confirmed"
      ? {
          ...directSummaryPanelBase,
          receipt: visibleDirectSummaryState.receipt,
        }
      : directSummaryPanelBase;
  const directSummaryPanelWithRecovery =
    visibleDirectSummaryState.state === "recovery_required"
      ? {
          ...directSummaryPanelWithReceipt,
          recoveryResolution: visibleDirectSummaryState.resolution,
        }
      : directSummaryPanelWithReceipt;
  const directSummaryPanelWithError =
    directSummaryError === undefined
      ? directSummaryPanelWithRecovery
      : { ...directSummaryPanelWithRecovery, error: directSummaryError };
  const directSummaryPanel =
    workbench.pendingReview?.state === "none"
      ? directSummaryPanelWithError
      : undefined;

  const conversationActions = canWriteDirectConversation
    ? { setThreadState, replyToThread, editComment, deleteComment }
    : undefined;
  const labelActions: LabelPickerActions | undefined = canWriteLabels
    ? { fetchLabels, addLabels, removeLabels }
    : undefined;
  const assigneeActions: AssigneesSectionActions | undefined =
    canWriteAssignees
      ? { fetchAssignableUsers, addAssignees, removeAssignees, assignSelf }
      : undefined;

  const workbenchActionsBase = {
    detectUpdates: runDetect,
    refresh,
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
    reportNavigationState: onNavigationStateChange,
  };
  const workbenchActionsWithRefreshing =
    refreshing === true
      ? { ...workbenchActionsBase, refreshing: true as const }
      : workbenchActionsBase;
  const workbenchActionsWithRefreshError =
    refreshError === true
      ? { ...workbenchActionsWithRefreshing, refreshError: true as const }
      : workbenchActionsWithRefreshing;
  const workbenchActionsWithMerge =
    mergeAction === undefined
      ? workbenchActionsWithRefreshError
      : { ...workbenchActionsWithRefreshError, merge: mergeAction };
  const workbenchActionsWithLocalCommentAuthoring =
    localCommentAuthoring === undefined
      ? workbenchActionsWithMerge
      : { ...workbenchActionsWithMerge, localCommentAuthoring };
  const workbenchActionsWithPendingReviewComposer =
    pendingReviewComposer === undefined
      ? workbenchActionsWithLocalCommentAuthoring
      : {
          ...workbenchActionsWithLocalCommentAuthoring,
          pendingReviewComposer,
        };
  const workbenchActionsWithPendingReviewPanel =
    pendingReviewPanel === undefined
      ? workbenchActionsWithPendingReviewComposer
      : {
          ...workbenchActionsWithPendingReviewComposer,
          pendingReview: pendingReviewPanel,
        };
  const workbenchActionsWithDirectSummaryPanel =
    directSummaryPanel === undefined
      ? workbenchActionsWithPendingReviewPanel
      : {
          ...workbenchActionsWithPendingReviewPanel,
          directSummary: directSummaryPanel,
        };
  const workbenchActionsWithLabels =
    labelActions === undefined
      ? workbenchActionsWithDirectSummaryPanel
      : { ...workbenchActionsWithDirectSummaryPanel, labels: labelActions };
  const workbenchActionsWithAssignees =
    assigneeActions === undefined
      ? workbenchActionsWithLabels
      : { ...workbenchActionsWithLabels, assignees: assigneeActions };
  const workbenchActions =
    conversationActions === undefined
      ? workbenchActionsWithAssignees
      : { ...workbenchActionsWithAssignees, ...conversationActions };

  return (
    <>
      <ReviewWorkbench
        model={workbench}
        {...(initialUiState === undefined
          ? {}
          : { initialState: initialUiState })}
        {...(onUiStateChange === undefined
          ? {}
          : { onPositionCommitted: onUiStateChange })}
        actions={workbenchActions}
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
type InsightModelOption = {
  readonly id: string;
  readonly label: string;
  readonly reasoning?: ReadonlyArray<InsightReasoning>;
};
type InsightRunConfiguration = {
  readonly catalog?: ReturnType<typeof parseInsightProviderCatalog>;
  readonly provider: InsightProvider;
  readonly models: ReadonlyArray<InsightModelOption>;
  readonly model: string | null;
  readonly reasoning: InsightReasoning;
  readonly runDialogType: InsightRunDialogType | null;
  readonly runDialogAction: "run" | "retry" | "regenerate";
  readonly catalogError: boolean;
  readonly codexActivationPending: boolean;
  readonly codexActivationError: boolean;
};
type InsightRunConfigurationAction = {
  readonly type: "updated";
  readonly patch: Partial<InsightRunConfiguration>;
};
const initialInsightRunConfiguration: InsightRunConfiguration = {
  provider: "pi",
  models: [],
  model: null,
  reasoning: "medium",
  runDialogType: null,
  runDialogAction: "run",
  catalogError: false,
  codexActivationPending: false,
  codexActivationError: false,
};
function insightRunConfigurationReducer(
  state: InsightRunConfiguration,
  action: InsightRunConfigurationAction,
): InsightRunConfiguration {
  return { ...state, ...action.patch };
}
// Pre-existing giant component (over 640 lines before this change, unrelated
// to this plan's diff — see the disable comment on `ReviewWorkbenchFlow`
// above for the same verification and rationale).
// react-doctor-disable-next-line react-doctor/no-giant-component -- see comment above
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
  const [configuration, updateConfiguration] = useReducer(
    insightRunConfigurationReducer,
    initialInsightRunConfiguration,
  );
  const {
    catalog,
    provider,
    models,
    model,
    reasoning,
    runDialogType,
    runDialogAction,
    catalogError,
    codexActivationPending,
    codexActivationError,
  } = configuration;
  const setConfiguration = (patch: Partial<InsightRunConfiguration>): void =>
    updateConfiguration({ type: "updated", patch });
  const preferencesRef = useRef<
    Partial<Record<"analysis" | "walkthrough", InsightRunPreference>>
  >({});
  const [selectedInsight, setSelectedInsight] = useState<
    "overview" | "analysis" | "walkthrough"
  >(initialDetail ?? "analysis");
  const [walkthroughFocused, setWalkthroughFocused] = useState(false);
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
    preferencesRef.current = loadedPreferences;
    const initialPreference = loadedPreferences[initialDetail ?? "analysis"];
    if (initialPreference !== undefined) {
      setConfiguration({
        provider: initialPreference.provider,
        reasoning: initialPreference.reasoning,
        model: initialPreference.model,
      });
    }
    void requestJson("/v1/insight-providers")
      .then((value) => {
        if (!active) return;
        const parsed = parseInsightProviderCatalog(value);
        if (parsed === undefined) {
          setConfiguration({
            catalog: undefined,
            models: [],
            model: null,
            catalogError: true,
          });
          return;
        }
        const piModels = parsed.models.filter(
          (candidate) => candidate.provider === "pi",
        );
        const selectedModel =
          initialPreference?.provider === "pi" &&
          piModels.some((candidate) => candidate.id === initialPreference.model)
            ? initialPreference.model
            : (piModels[0]?.id ?? null);
        setConfiguration({
          catalog: parsed,
          models: piModels,
          model: selectedModel,
          catalogError: false,
        });
      })
      .catch(() => {
        if (!active) return;
        setConfiguration({
          catalog: undefined,
          models: [],
          model: null,
          catalogError: true,
        });
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
    const nextModels =
      catalog?.models.filter(
        (candidate) => candidate.provider === nextProvider,
      ) ?? [];
    const preference = preferencesRef.current[activePreferenceType];
    const first = nextModels[0];
    setConfiguration({
      provider: nextProvider,
      models: nextModels,
      model:
        preference?.provider === nextProvider &&
        nextModels.some((candidate) => candidate.id === preference.model)
          ? preference.model
          : (nextModels[0]?.id ?? null),
      reasoning:
        preference?.provider === nextProvider
          ? preference.reasoning
          : (first?.defaultReasoning ?? first?.reasoning[0] ?? "medium"),
    });
  };
  const activateCodex = (): void => {
    setConfiguration({
      codexActivationPending: true,
      codexActivationError: false,
    });
    void requestJson("/v1/insight-providers/codex/models", {
      method: "POST",
      body: {},
    })
      .then((value) => {
        const parsed = parseInsightProviderCatalog(value);
        if (parsed === undefined) throw new Error("Invalid Codex catalog");
        const nextCatalog =
          catalog === undefined
            ? parsed
            : {
                ...catalog,
                providers: [
                  ...catalog.providers.filter(
                    (candidate) => candidate.id !== "codex-cli-account",
                  ),
                  ...parsed.providers,
                ],
                models: [
                  ...catalog.models.filter(
                    (candidate) => candidate.provider !== "codex-cli-account",
                  ),
                  ...parsed.models,
                ],
              };
        const codexModels = parsed.models.filter(
          (candidate) => candidate.provider === "codex-cli-account",
        );
        setConfiguration({
          catalog: nextCatalog,
          models: codexModels,
          model: codexModels[0]?.id ?? null,
          reasoning:
            codexModels[0]?.defaultReasoning ??
            codexModels[0]?.reasoning[0] ??
            "medium",
        });
      })
      .catch(() => setConfiguration({ codexActivationError: true }))
      .finally(() => setConfiguration({ codexActivationPending: false }));
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
      analysisRun.run(provider, model, reasoning, onAccepted);
    } else {
      walkthroughRun.run(provider, model, reasoning, onAccepted);
    }
  };
  const openRunDialog = (action: "run" | "retry" | "regenerate"): void => {
    if (selectedInsight === "overview" || catalogError) return;
    const preference = preferencesRef.current[selectedInsight];
    const nextModels =
      catalog?.models.filter(
        (candidate) => candidate.provider === (preference?.provider ?? "pi"),
      ) ?? [];
    setConfiguration({
      provider: preference?.provider ?? "pi",
      reasoning: preference?.reasoning ?? "medium",
      models: nextModels,
      model:
        preference !== undefined &&
        nextModels.some((candidate) => candidate.id === preference.model)
          ? preference.model
          : (nextModels[0]?.id ?? null),
      runDialogType: selectedInsight,
      runDialogAction: action,
    });
  };
  const closeRunDialog = (): void => setConfiguration({ runDialogType: null });
  const confirmRun = (): void => {
    if (model === null || selectedInsight === "overview") return;
    closeRunDialog();
    runSelected(() => {
      saveInsightRunPreference(profileId, selectedInsight, {
        provider,
        model,
        reasoning,
      });
      preferencesRef.current = {
        ...preferencesRef.current,
        [selectedInsight]: { provider, model, reasoning },
      };
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
      <WalkthroughProgressReader
        key={JSON.stringify({
          sessionId: workbench.session.id,
          runId: workbench.insights.walkthrough.retained.runId,
          headSha: workbench.revision.reviewedHeadSha,
          progress: workbench.insights.walkthrough.progress,
        })}
        walkthrough={workbench.insights.walkthrough.retained.value}
        initialProgress={workbench.insights.walkthrough.progress}
        profileId={profileId}
        reviewId={reviewId}
        runId={workbench.insights.walkthrough.retained.runId}
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
            const selected = models.find(
              (candidate) => candidate.id === nextModel,
            );
            if (
              selected !== undefined &&
              selected.reasoning !== undefined &&
              !selected.reasoning.includes(reasoning)
            ) {
              setConfiguration({
                model: nextModel,
                reasoning: selected.reasoning[0] ?? "medium",
              });
              return;
            }
            setConfiguration({ model: nextModel });
          }}
          onProviderChange={changeProvider}
          onActivateCodex={activateCodex}
          onReasoningChange={(nextReasoning) =>
            setConfiguration({ reasoning: nextReasoning })
          }
          onConfirm={confirmRun}
        />
      )}
    </section>
  );
}

type WalkthroughProgressReaderProps = Omit<
  React.ComponentProps<typeof NarrativeWalkthrough>,
  "reviewedSectionIds" | "supportReviewed" | "currentSectionId" | "actions"
> & {
  readonly initialProgress: WorkbenchResponse["insights"]["walkthrough"]["progress"];
  readonly profileId: string;
  readonly reviewId: string;
  readonly runId: string | undefined;
};
function WalkthroughProgressReader({
  initialProgress,
  profileId,
  reviewId,
  runId,
  ...props
}: WalkthroughProgressReaderProps): React.JSX.Element {
  const [reviewedSectionIds, setReviewedSectionIds] = useState<
    ReadonlyArray<string>
  >(initialProgress?.reviewedSectionIds ?? []);
  const [supportReviewed, setSupportReviewed] = useState(
    initialProgress?.supportReviewed ?? false,
  );
  const [currentSectionId, setCurrentSectionId] = useState<string | undefined>(
    initialProgress?.currentSectionId,
  );
  const [progressError, setProgressError] = useState(false);
  const save = (progress: {
    readonly reviewedSectionIds: ReadonlyArray<string>;
    readonly supportReviewed: boolean;
    readonly currentSectionId?: string;
  }): void => {
    if (runId === undefined) return;
    void requestJson("/v1/reviews/insights/walkthrough/progress", {
      method: "POST",
      body: { profileId, reviewId, runId, ...progress },
    })
      .then(() => setProgressError(false))
      .catch(() => setProgressError(true));
  };
  return (
    <>
      {progressError ? (
        <p role="alert" className="py-2 text-sm text-destructive">
          Walkthrough progress could not be saved.
        </p>
      ) : null}
      <NarrativeWalkthrough
        {...props}
        reviewedSectionIds={reviewedSectionIds}
        supportReviewed={supportReviewed}
        {...(currentSectionId === undefined ? {} : { currentSectionId })}
        actions={{
          onMarkSectionReviewed: (sectionId) => {
            const next = reviewedSectionIds.includes(sectionId)
              ? reviewedSectionIds
              : [...reviewedSectionIds, sectionId];
            setReviewedSectionIds(next);
            const saved = { reviewedSectionIds: next, supportReviewed };
            save(
              currentSectionId === undefined
                ? saved
                : { ...saved, currentSectionId },
            );
          },
          onMarkSupportReviewed: () => {
            setSupportReviewed(true);
            const saved = { reviewedSectionIds, supportReviewed: true };
            save(
              currentSectionId === undefined
                ? saved
                : { ...saved, currentSectionId },
            );
          },
          onSelectSection: (sectionId) => {
            setCurrentSectionId(sectionId);
            save({
              reviewedSectionIds,
              supportReviewed,
              currentSectionId: sectionId,
            });
          },
        }}
      />
    </>
  );
}

function formatInsightTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return insightTimestampFormatter.format(timestamp);
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
    | "cancelled"
    | "failed"
    | "invalid_result"
    | "superseded";
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

type DirectConversationReceipt =
  | {
      readonly _tag: "CommentCreated";
      readonly commentId: string;
      readonly reviewId?: string;
      readonly threadId?: string;
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

/** Mutable builder shape for `DirectConversationReceipt`'s `CommentCreated` variant; frozen into the readonly contract on return. */
type MutableCommentCreatedReceipt = {
  _tag: "CommentCreated";
  commentId: string;
  reviewId?: string;
  threadId?: string;
};
/** Mutable builder shape for `DirectConversationReceipt`'s `ReplyCreated` variant; frozen into the readonly contract on return. */
type MutableReplyCreatedReceipt = {
  _tag: "ReplyCreated";
  commentId: string;
  reviewId?: string;
};

const directConversationReceiptSchema = v.variant("_tag", [
  v.looseObject({
    _tag: v.literal("CommentCreated"),
    commentId: v.pipe(v.string(), v.minLength(1)),
    reviewId: v.optional(v.pipe(v.string(), v.minLength(1))),
    threadId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.looseObject({
    _tag: v.literal("ReplyCreated"),
    commentId: v.pipe(v.string(), v.minLength(1)),
    reviewId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.looseObject({
    _tag: v.literal("ThreadStateChanged"),
    threadId: v.string(),
    state: v.picklist(["open", "resolved"]),
  }),
  v.looseObject({
    _tag: v.literal("CommentEdited"),
    commentId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.looseObject({
    _tag: v.literal("CommentDeleted"),
    commentId: v.pipe(v.string(), v.minLength(1)),
  }),
]);

function parseDirectConversationReceipt(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for the direct-conversation command response; there is no earlier boundary to run it at.
  value: unknown,
): DirectConversationReceipt | undefined {
  const parsed = v.safeParse(directConversationReceiptSchema, value);
  if (!parsed.success) return undefined;
  const output = parsed.output;
  if (output._tag === "ThreadStateChanged") {
    const threadId = parseGitHubThreadId(output.threadId);
    return threadId._tag === "err"
      ? undefined
      : {
          _tag: "ThreadStateChanged",
          threadId: threadId.value,
          state: output.state,
        };
  }
  if (output._tag === "CommentEdited" || output._tag === "CommentDeleted")
    return { _tag: output._tag, commentId: output.commentId };
  if (output._tag === "ReplyCreated") {
    const receipt: MutableReplyCreatedReceipt = {
      _tag: "ReplyCreated",
      commentId: output.commentId,
    };
    if (output.reviewId !== undefined) receipt.reviewId = output.reviewId;
    return receipt;
  }
  const receipt: MutableCommentCreatedReceipt = {
    _tag: "CommentCreated",
    commentId: output.commentId,
  };
  if (output.reviewId !== undefined) receipt.reviewId = output.reviewId;
  if (output.threadId !== undefined) receipt.threadId = output.threadId;
  return receipt;
}

const labelReceiptSchema = v.variant("_tag", [
  v.looseObject({
    _tag: v.literal("LabelsAdded"),
    added: v.array(v.string()),
  }),
  v.looseObject({
    _tag: v.literal("LabelsRemoved"),
    removed: v.array(v.string()),
  }),
]);

type LabelReceipt =
  | { readonly _tag: "LabelsAdded"; readonly added: ReadonlyArray<string> }
  | {
      readonly _tag: "LabelsRemoved";
      readonly removed: ReadonlyArray<string>;
    };

function parseLabelReceipt(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for the labels command response; there is no earlier boundary to run it at.
  value: unknown,
): LabelReceipt | undefined {
  const parsed = v.safeParse(labelReceiptSchema, value);
  return parsed.success ? parsed.output : undefined;
}

const assigneeReceiptSchema = v.variant("_tag", [
  v.looseObject({
    _tag: v.literal("AssigneesAdded"),
    added: v.array(v.string()),
  }),
  v.looseObject({
    _tag: v.literal("AssigneesRemoved"),
    removed: v.array(v.string()),
  }),
]);

type AssigneeReceipt =
  | { readonly _tag: "AssigneesAdded"; readonly added: ReadonlyArray<string> }
  | {
      readonly _tag: "AssigneesRemoved";
      readonly removed: ReadonlyArray<string>;
    };

function parseAssigneeReceipt(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for the assignees command response; there is no earlier boundary to run it at.
  value: unknown,
): AssigneeReceipt | undefined {
  const parsed = v.safeParse(assigneeReceiptSchema, value);
  return parsed.success ? parsed.output : undefined;
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

const detectionSchema = v.looseObject({ updatesAvailable: v.boolean() });

function isDetection(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this predicate is itself the JSON I/O boundary parser for the detect-updates response; there is no earlier boundary to run it at.
  value: unknown,
): value is { readonly updatesAvailable: boolean } {
  return v.safeParse(detectionSchema, value).success;
}

const reviewObservationSchema = v.variant("_tag", [
  v.looseObject({ _tag: v.literal("Unchanged") }),
  v.looseObject({ _tag: v.literal("RevisionChanged") }),
  v.looseObject({ _tag: v.literal("Unavailable") }),
  v.looseObject({
    _tag: v.literal("Reconciled"),
    projection: v.optional(v.unknown()),
  }),
  v.looseObject({
    _tag: v.literal("Terminal"),
    status: v.picklist(["merged", "closed"]),
  }),
]);

function isReviewObservation(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for the review-observation response; there is no earlier boundary to run it at.
  value: unknown,
):
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Reconciled"; readonly projection?: unknown }
  | { readonly _tag: "RevisionChanged" }
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Terminal"; readonly status: "merged" | "closed" }
  | undefined {
  const parsed = v.safeParse(reviewObservationSchema, value);
  return parsed.success ? parsed.output : undefined;
}
