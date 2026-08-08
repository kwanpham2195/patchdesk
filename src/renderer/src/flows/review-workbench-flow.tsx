import { useCallback, useEffect, useState } from "react";

import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  parseRepoRelativePath,
} from "../../../domain/ids";
import { fingerprintPatchAnchor } from "../../../domain/review-anchor";
import {
  parseReviewBatch,
  type ReviewAnchor,
} from "../../../domain/review-batch";
import { requestJson } from "../api-client";
import { AnalysisReader } from "../components/analysis-reader";
import { NarrativeWalkthrough } from "../components/narrative-walkthrough";
import {
  InsightRunDialog,
  type InsightRunDialogType,
  type InsightReasoning,
} from "../components/insight-run-dialog";
import {
  ReviewWorkbench,
  type ReviewWorkbenchInitialState,
  usePublishedFeedbackNavigation,
  useReviewWorkbenchNavigation,
} from "../components/review-workbench";
import type { PullRequestOverviewMerge } from "../components/pr-overview-sheet";
import type { LocalCommentAuthoring } from "../components/review-diff-view";
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
  parseModelCatalog,
  parsePublicationPreview,
  parseReviewBatchProjection,
  parseWorkbenchResponse,
  type CommitDiffResponse,
} from "../renderer-contracts";
import { useInsightRun } from "../hooks/use-insight-run";
import {
  openPullRequestExternalUrl,
  pullRequestPageUrl,
} from "../external-links";

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
}: ReviewWorkbenchFlowProps): React.JSX.Element {
  void initialSection;
  void onNavigate;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [autoOpenPublication, setAutoOpenPublication] = useState(false);
  const [selectedRepairAnchor, setSelectedRepairAnchor] = useState<
    ReviewAnchor | undefined
  >();
  // Comment/thread ids written by this window since the last projection
  // replace. The detector excludes them so own writes never read as remote
  // updates; cleared once a refresh/reload re-baselines the snapshot.
  const [recentWrites, setRecentWrites] = useState<ReadonlyArray<string>>([]);
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
  const detectUpdates = useCallback(async (): Promise<void> => {
    if (workbench.review.status !== "open") return;
    try {
      const value = await requestJson("/v1/reviews/detect-updates", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          reviewId: workbench.review.id,
          ...(recentWrites.length === 0 ? {} : { recentWrites }),
        },
      });
      if (isDetection(value) && value.updatesAvailable) {
        if (
          workbench.revision.freshness !== "updates_available" &&
          detectedStaleFreshness === undefined
        )
          setDetectedStaleFreshness(workbench.revision.freshness);
        onWorkbenchPatch({
          revision: { ...workbench.revision, freshness: "updates_available" },
        });
      } else if (
        isDetection(value) &&
        !value.updatesAvailable &&
        workbench.revision.freshness === "updates_available"
      ) {
        // Detection is authoritative: a cleared flag means the stale patch was
        // a phantom (or the remote caught up), so restore writes.
        onWorkbenchPatch({
          revision: {
            ...workbench.revision,
            freshness: detectedStaleFreshness ?? "fresh",
          },
        });
        setDetectedStaleFreshness(undefined);
      }
    } catch {
      // Detection is advisory and never replaces the represented snapshot.
    }
  }, [detectedStaleFreshness, onWorkbenchPatch, recentWrites, workbench]);

  useEffect(() => {
    void detectUpdates();
    if (workbench.review.status !== "open") return undefined;
    const timer = window.setInterval(() => void detectUpdates(), 30_000);
    return () => window.clearInterval(timer);
  }, [detectUpdates, workbench.review.status]);

  const refresh = useCallback(async (): Promise<void> => {
    if (workbench.review.status !== "open" || refreshing) return;
    setRefreshing(true);
    setRefreshError(false);
    try {
      const value = await requestJson("/v1/reviews/refresh", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          reviewId: workbench.review.id,
        },
      });
      const parsed = parseWorkbenchResponse(value);
      if (parsed === undefined)
        throw new Error("Invalid Review refresh response");
      setDetectedStaleFreshness(undefined);
      replaceWorkbench(parsed);
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  }, [replaceWorkbench, refreshing, workbench]);

  const refreshConfirmedPublication = useCallback(async (): Promise<void> => {
    if (workbench.review.status !== "open") return;
    const value = await requestJson("/v1/reviews/refresh", {
      method: "POST",
      body: {
        profileId: workbench.session.key.profileId,
        reviewId: workbench.review.id,
      },
    });
    const parsed = parseWorkbenchResponse(value);
    if (parsed === undefined)
      throw new Error("Invalid Review publication refresh response");
    replaceWorkbench(parsed);
  }, [replaceWorkbench, workbench]);

  const saveInlineComment = useCallback(
    async (
      input: Parameters<NonNullable<LocalCommentAuthoring["onSave"]>>[0],
    ): Promise<{ readonly commentId: string; readonly threadId?: string } | void> => {
      const patchHash = workbench.revision.patchHash;
      if (patchHash === undefined) throw new Error("The current Diff cannot accept comments.");
      const value = await requestJson("/v1/reviews/inline-conversations/command", {
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
      });
      const receipt = value as {
        readonly _tag?: string;
        readonly commentId?: string;
        readonly threadId?: string;
        readonly reviewId?: string;
      };
      if (receipt._tag === "CommentCreated" && typeof receipt.commentId === "string") {
        const commentId = receipt.commentId as string;
        setRecentWrites((current) => [
          ...current,
          commentId,
          ...(typeof receipt.threadId === "string" ? [receipt.threadId as string] : []),
          ...(typeof receipt.reviewId === "string" ? [receipt.reviewId as string] : []),
        ]);
        return {
          commentId,
          ...(typeof receipt.threadId === "string" ? { threadId: receipt.threadId as string } : {}),
        };
      }
      return undefined;
    },
    [workbench],
  );

  const setThreadState = useCallback(async (threadId: string, state: "open" | "resolved"): Promise<void> => {
    const patchHash = workbench.revision.patchHash;
    if (patchHash === undefined) throw new Error("The current Diff cannot update this thread.");
    await requestJson("/v1/reviews/inline-conversations/command", {
      method: "POST",
      body: {
        profileId: workbench.session.key.profileId,
        reviewId: workbench.review.id,
        command: {
          _tag: "SetThreadState",
          expected: { sessionId: workbench.session.id, headSha: workbench.revision.reviewedHeadSha, patchHash },
          threadId,
          state,
        },
      },
    });
    setRecentWrites((current) => [...current, threadId]);
  }, [workbench]);

  const replyToThread = useCallback(async (threadId: string, body: string): Promise<string | void> => {
    const patchHash = workbench.revision.patchHash;
    if (patchHash === undefined) throw new Error("The current Diff cannot accept replies.");
    const value = await requestJson("/v1/reviews/inline-conversations/command", {
      method: "POST",
      body: {
        profileId: workbench.session.key.profileId,
        reviewId: workbench.review.id,
        command: {
          _tag: "Reply",
          expected: { sessionId: workbench.session.id, headSha: workbench.revision.reviewedHeadSha, patchHash },
          threadId,
          body,
        },
      },
    });
    const receipt = value as { readonly _tag?: string; readonly commentId?: string; readonly reviewId?: string };
    if (receipt._tag === "ReplyCreated" && typeof receipt.commentId === "string") {
      const commentId = receipt.commentId as string;
      setRecentWrites((current) => [
        ...current,
        commentId,
        ...(typeof receipt.reviewId === "string" ? [receipt.reviewId as string] : []),
      ]);
      return commentId;
    }
    return undefined;
  }, [workbench]);

  const editComment = useCallback(async (commentId: string, body: string): Promise<void> => {
    const patchHash = workbench.revision.patchHash;
    if (patchHash === undefined) throw new Error("The current Diff cannot edit comments.");
    await requestJson("/v1/reviews/inline-conversations/command", {
      method: "POST",
      body: {
        profileId: workbench.session.key.profileId,
        reviewId: workbench.review.id,
        command: {
          _tag: "EditComment",
          expected: { sessionId: workbench.session.id, headSha: workbench.revision.reviewedHeadSha, patchHash },
          commentId,
          body,
        },
      },
    });
    setRecentWrites((current) => [...current, commentId]);
  }, [workbench]);

  const deleteComment = useCallback(async (commentId: string): Promise<void> => {
    const patchHash = workbench.revision.patchHash;
    if (patchHash === undefined) throw new Error("The current Diff cannot delete comments.");
    await requestJson("/v1/reviews/inline-conversations/command", {
      method: "POST",
      body: {
        profileId: workbench.session.key.profileId,
        reviewId: workbench.review.id,
        command: {
          _tag: "DeleteComment",
          expected: { sessionId: workbench.session.id, headSha: workbench.revision.reviewedHeadSha, patchHash },
          commentId,
          confirmation: true,
        },
      },
    });
    setRecentWrites((current) => [...current, commentId]);
  }, [workbench]);
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
  const localCommentAuthoring: LocalCommentAuthoring | undefined = canWriteDirectConversation
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
            acknowledgedWarnings: boolean,
          ) => {
            await requestJson("/v1/reviews/merge", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                reviewId: workbench.review.id,
                sessionId: workbench.session.id,
                expectedHeadSha: workbench.revision.reviewedHeadSha,
                expectedPatchHash: workbench.revision.patchHash,
                expectedRevision:
                  workbench.draft?.updatedAt ?? workbench.revision.refreshedAt,
                method,
                acknowledgedWarnings,
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
  const addFindingToDraft = useCallback(
    async (finding: AnalysisFinding): Promise<void> => {
      const batch = workbench.draft;
      const runId = workbench.insights.analysis.retained?.runId;
      if (batch === undefined || runId === undefined)
        throw new Error("Analysis draft is unavailable");
      const body = finding.suggestedComment ?? finding.explanation;
      const command =
        finding.mappingStatus === "mapped" &&
        finding.file !== undefined &&
        finding.lineStart !== undefined &&
        workbench.fullPatch !== undefined
          ? (() => {
              const mapped = mapFindingLocation(
                parseUnifiedPatch(workbench.fullPatch as string),
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
                path?._tag === "ok" &&
                mapped.line !== undefined &&
                mapped.side !== undefined
              ) {
                const anchor = {
                  path: path.value,
                  startLine: mapped.startLine ?? mapped.line,
                  line: mapped.line,
                  side: mapped.side,
                };
                const fingerprint = fingerprintPatchAnchor(
                  workbench.fullPatch as string,
                  anchor,
                );
                if (fingerprint !== undefined)
                  return {
                    _tag: "AddFindingInlineComment" as const,
                    reviewId: workbench.review.id,
                    findingId: finding.id,
                    runId,
                    anchor,
                    fingerprint,
                    body,
                  };
              }
              return {
                _tag: "AddFindingGeneralComment" as const,
                reviewId: workbench.review.id,
                findingId: finding.id,
                runId,
                body,
              };
            })()
          : {
              _tag: "AddFindingGeneralComment" as const,
              reviewId: workbench.review.id,
              findingId: finding.id,
              runId,
              body,
            };
      const value = await requestJson("/v1/reviews/batch", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          sessionId: workbench.session.id,
          expectedRevision: batch.updatedAt,
          command,
        },
      });
      const next = parseBatchResponse(value);
      if (next === undefined) throw new Error("Invalid Review batch response");
      onWorkbenchPatch({ draft: next });
    },
    [onWorkbenchPatch, workbench],
  );
  const dismissFindingFromWorkbench = useCallback(
    async (finding: AnalysisFinding, reason: string): Promise<void> => {
      const runId = workbench.insights.analysis.retained?.runId;
      if (
        runId === undefined ||
        workbench.insights.analysis.status !== "current"
      )
        throw new Error("Analysis is not current");
      await requestJson(
        `/v1/reviews/insights/analysis/findings/${encodeURIComponent(finding.id)}/dismiss`,
        {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            runId,
            reason,
          },
        },
      );
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
        actions={{
          detectUpdates,
          refresh,
          ...(mergeAction === undefined ? {} : { merge: mergeAction }),
          addFinding: addFindingToDraft,
          dismissFinding: dismissFindingFromWorkbench,
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
          ...(canWriteDirectConversation ? { setThreadState, replyToThread, editComment, deleteComment } : {}),
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
              onAnalysisCompletion={() => setAutoOpenPublication(true)}
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
type AnalysisCompletionChoice =
  | "SaveAsReviewDraft"
  | "OpenPreviewWhenComplete"
  | "PublishWhenComplete:COMMENT"
  | "PublishWhenComplete:APPROVE"
  | "PublishWhenComplete:REQUEST_CHANGES";

function analysisCompletionAction(
  choice: AnalysisCompletionChoice,
): Parameters<ReturnType<typeof useInsightRun>["run"]>[2] {
  if (choice === "SaveAsReviewDraft") return { _tag: "SaveAsReviewDraft" };
  if (choice === "OpenPreviewWhenComplete")
    return { _tag: "OpenPreviewWhenComplete" };
  const event = choice.slice("PublishWhenComplete:".length) as
    "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  return {
    _tag: "PublishWhenComplete",
    event,
    authorizationId: `publication-${crypto.randomUUID()}`,
  };
}

function InsightsSlot({
  workbench,
  initialDetail,
  onWorkbenchReplace,
  onWorkbenchPatch,
  onAnalysisCompletion,
}: {
  readonly workbench: WorkbenchResponse;
  readonly initialDetail?: "analysis" | "walkthrough";
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
  readonly onAnalysisCompletion: () => void;
}): React.JSX.Element {
  const navigateToFiles = useReviewWorkbenchNavigation();
  const [models, setModels] = useState<
    ReadonlyArray<{ readonly id: string; readonly label: string }>
  >([]);
  const [model, setModel] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<InsightReasoning>("medium");
  const [analysisCompletion, setAnalysisCompletion] =
    useState<AnalysisCompletionChoice>("OpenPreviewWhenComplete");
  const [runDialogType, setRunDialogType] =
    useState<InsightRunDialogType | null>(null);
  const [runDialogAction, setRunDialogAction] = useState<
    "run" | "retry" | "regenerate"
  >("run");
  const [catalogError, setCatalogError] = useState(false);
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
    onCompleted: () => {
      if (analysisCompletion === "OpenPreviewWhenComplete")
        onAnalysisCompletion();
    },
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
    void requestJson("/v1/reviews/models")
      .then((value) => {
        if (!active) return;
        const catalog = parseModelCatalog(value);
        if (catalog === undefined) {
          setModels([]);
          setModel(null);
          setCatalogError(true);
          return;
        }
        setModels(catalog.models);
        setModel(catalog.defaultModel ?? catalog.models[0]?.id ?? null);
        setCatalogError(false);
      })
      .catch(() => {
        if (!active) return;
        setModels([]);
        setModel(null);
        setCatalogError(true);
      });
    return () => {
      active = false;
    };
  }, [profileId]);

  const runEnabled =
    !catalogError && model !== null && workbench.review.status === "open";
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
  const addFinding = async (finding: AnalysisFinding): Promise<void> => {
    const batch = workbench.draft;
    const runId = workbench.insights.analysis.retained?.runId;
    if (batch === undefined || runId === undefined) return;
    const body = finding.suggestedComment ?? finding.explanation;
    let command:
      | {
          readonly _tag: "AddFindingInlineComment";
          readonly reviewId: string;
          readonly findingId: string;
          readonly runId: string;
          readonly anchor: {
            readonly path: string;
            readonly startLine: number;
            readonly line: number;
            readonly side: "new" | "old";
          };
          readonly fingerprint: NonNullable<
            ReturnType<typeof fingerprintPatchAnchor>
          >;
          readonly body: string;
        }
      | {
          readonly _tag: "AddFindingGeneralComment";
          readonly reviewId: string;
          readonly findingId: string;
          readonly runId: string;
          readonly body: string;
        };
    if (
      finding.mappingStatus === "mapped" &&
      finding.file !== undefined &&
      finding.lineStart !== undefined &&
      workbench.fullPatch !== undefined
    ) {
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
      const line = mapped.line;
      const side = mapped.side;
      if (
        path !== undefined &&
        path._tag === "ok" &&
        line !== undefined &&
        side !== undefined
      ) {
        const startLine = mapped.startLine ?? line;
        const anchor = { path: path.value, startLine, line, side };
        const fingerprint = fingerprintPatchAnchor(workbench.fullPatch, anchor);
        if (fingerprint !== undefined) {
          command = {
            _tag: "AddFindingInlineComment",
            reviewId,
            findingId: finding.id,
            runId,
            anchor,
            fingerprint,
            body,
          };
        } else {
          command = {
            _tag: "AddFindingGeneralComment",
            reviewId,
            findingId: finding.id,
            runId,
            body,
          };
        }
      } else {
        command = {
          _tag: "AddFindingGeneralComment",
          reviewId,
          findingId: finding.id,
          runId,
          body,
        };
      }
    } else {
      command = {
        _tag: "AddFindingGeneralComment",
        reviewId,
        findingId: finding.id,
        runId,
        body,
      };
    }
    const value = await requestJson("/v1/reviews/batch", {
      method: "POST",
      body: {
        profileId,
        sessionId: workbench.session.id,
        expectedRevision: batch.updatedAt,
        command,
      },
    });
    const next = parseBatchResponse(value);
    if (next === undefined) throw new Error("Invalid Review batch response");
    onWorkbenchPatch({ draft: next });
  };
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
  const insightScope = {
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
  const emptyInsightScope = {
    baseShort: "unknown",
    headShort: selectedRetained?.headSha.slice(0, 7) ?? "unknown",
    commitCount: 0,
    fileCount: 0,
    additions: 0,
    deletions: 0,
    changedFiles: [] as ReadonlyArray<{
      readonly path: string;
      readonly additions: number;
      readonly deletions: number;
    }>,
  };
  const analysisRetainedScope = workbench.insights.analysis.retained?.scope;
  const readerScope =
    selectedInsight === "analysis"
      ? selectedIsOutdated
        ? (analysisRetainedScope ?? emptyInsightScope)
        : (analysisRetainedScope ?? insightScope)
      : insightScope;
  const analysisFirstRunActive =
    selectedInsight === "analysis" &&
    selectedProjection?.status === "running" &&
    selectedProjection.retained === undefined;
  const analysisControlsVisible =
    selectedInsight === "analysis" &&
    !analysisFirstRunActive &&
    !selectedIsOutdated;
  const runSelected = (): void => {
    if (model === null || selectedInsight === "overview") return;
    if (selectedInsight === "analysis") {
      analysisRun.run(
        model,
        reasoning,
        selectedIsOutdated
          ? undefined
          : analysisCompletionAction(analysisCompletion),
      );
    } else {
      walkthroughRun.run(model, reasoning);
    }
  };
  const openRunDialog = (action: "run" | "retry" | "regenerate"): void => {
    if (selectedInsight === "overview" || !runEnabled) return;
    setRunDialogType(selectedInsight);
    setRunDialogAction(action);
  };
  const closeRunDialog = (): void => setRunDialogType(null);
  const confirmRun = (): void => {
    closeRunDialog();
    runSelected();
  };
  const retainedDescription =
    selectedInsight === "analysis"
      ? workbench.insights.analysis.retained?.value.summary
      : selectedInsight === "walkthrough"
        ? workbench.insights.walkthrough.retained?.value.focus
        : undefined;
  const currentRevision =
    workbench.revision.currentHeadSha ?? workbench.revision.reviewedHeadSha;
  const retainedAnalysis =
    selectedInsight === "analysis" &&
    workbench.insights.analysis.retained !== undefined ? (
      <AnalysisReader
        result={workbench.insights.analysis.retained.value}
        onBack={() => setSelectedInsight("overview")}
        {...(workbench.insights.analysis.status === "current"
          ? { onAddFinding: addFinding, onDismissFinding: dismissFinding }
          : {})}
        scope={readerScope}
      />
    ) : null;
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
  return (
    <section
      aria-label="Review insights"
      className="flex h-full min-h-0 w-full flex-col gap-2"
    >
      <div className="flex h-full min-h-0 flex-1 flex-col gap-2">
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
              : { revision: workbench.insights.walkthrough.retained.headSha })}
          />
        </nav>
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
              <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b pb-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {selectedInsight}
                  </p>
                  <h2 className="truncate text-lg font-semibold">
                    {selectedInsight === "analysis"
                      ? "Analysis document"
                      : selectedInsight === "walkthrough" &&
                          workbench.insights.walkthrough.retained !== undefined
                        ? workbench.insights.walkthrough.retained.value.title
                        : "Walkthrough document"}
                  </h2>
                  <p className="truncate text-sm text-muted-foreground">
                    {selectedRetained === undefined
                      ? "No retained result for this revision."
                      : selectedIsOutdated
                        ? `Retained revision ${selectedRetained.headSha.slice(0, 8)} · current revision ${currentRevision.slice(0, 8)} · ${formatInsightTimestamp(selectedRetained.generatedAt)}`
                        : `Retained from ${selectedRetained.headSha.slice(0, 8)} · ${formatInsightTimestamp(selectedRetained.generatedAt)}`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {analysisControlsVisible ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Open Analysis"
                      onClick={() => setSelectedInsight("analysis")}
                    >
                      Open Analysis
                    </Button>
                  ) : null}
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
              {catalogError || models.length === 0 ? (
                <p role="alert" className="py-2 text-sm text-destructive">
                  No eligible model configured. Set an API key or ambient
                  provider credentials in the Electron process, then reload.
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
          reasoning={reasoning}
          {...(runDialogType === "analysis"
            ? {
                completion: analysisCompletion,
                completionOptions: [
                  { value: "SaveAsReviewDraft", label: "Save as Review draft" },
                  {
                    value: "OpenPreviewWhenComplete",
                    label: "Open preview when complete",
                  },
                  {
                    value: "PublishWhenComplete:COMMENT",
                    label: "Publish as Comment",
                  },
                  {
                    value: "PublishWhenComplete:APPROVE",
                    label: "Publish as Approve",
                  },
                  {
                    value: "PublishWhenComplete:REQUEST_CHANGES",
                    label: "Publish as Request changes",
                  },
                ],
                onCompletionChange: (value: string) =>
                  setAnalysisCompletion(value as AnalysisCompletionChoice),
              }
            : {})}
          onOpenChange={(open) => {
            if (!open) closeRunDialog();
          }}
          onModelChange={setModel}
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
  const generic = failure?.category === undefined;
  return (
    <div className="flex flex-col gap-3 py-6">
      <p role="alert" className="text-sm text-destructive">
        {message}
      </p>
      {generic ? (
        <p className="text-sm text-muted-foreground">
          No additional failure details are available.
        </p>
      ) : null}
      {failure?.model === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          Selected model: {failure.model}
          {failure.reasoning === undefined
            ? ""
            : ` · Reasoning: ${failure.reasoning}`}
        </p>
      )}
      {failure?.runId === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          Correlation ID: {failure.runId}
        </p>
      )}
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
        Run again
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
    <div className="flex flex-col gap-3 py-6">
      <h3 className="font-medium">No {type} has been generated</h3>
      <p className="text-sm text-muted-foreground">
        Run this optional Insight for the represented Review snapshot.
      </p>
      <Button size="sm" onClick={onRun} disabled={disabled}>
        Run
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
