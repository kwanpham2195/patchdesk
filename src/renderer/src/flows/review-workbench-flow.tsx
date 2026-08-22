import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  parseRepoRelativePath,
} from "../../../domain/ids";
import { renderAnalysisReviewSummary } from "../analysis-review-summary";
import { requestJson } from "../api-client";
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
import { loadCodexModelCache, saveCodexModelCache } from "../codex-model-cache";
import {
  ReviewWorkbench,
  type ReviewWorkbenchInitialState,
} from "../components/review-workbench";
import type { AssigneesSectionActions } from "../components/assignee-picker";
import type { LabelPickerActions } from "../components/label-picker";
import type { ReviewerPickerActions } from "../components/reviewer-picker";
import type { ReviewNavigatorSection } from "../components/review-navigator";
import type { PullRequestOverviewMerge } from "../components/pr-overview-sheet";
import type { LocalCommentAuthoring } from "../components/review-diff-view";
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
  parseCommitDiffResponse,
  parseInsightProviderCatalog,
  type InsightProviderCatalogModel,
  parseWorkbenchResponse,
  type CommitDiffResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import type { InsightFailureCategory } from "../../../domain/insight-record";
import type { PullRequestRef } from "../../../domain/pull-request";

import { useInsightRun } from "../hooks/use-insight-run";
import { projectReadOnlyConversationAnnotations } from "../inline-conversation-mapping";
import { useDirectConversationActions } from "./use-direct-conversation-actions";
import { useDirectSummaryActions } from "./use-direct-summary-actions";
import { usePendingReviewActions } from "./use-pending-review-actions";
import { useReviewMetadataActions } from "./use-review-metadata-actions";
import {
  useReviewObservation,
  type ReviewWorkbenchPatch,
} from "./use-review-observation";

export type { ReviewWorkbenchPatch } from "./use-review-observation";

const insightTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

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
  const {
    refreshing,
    refreshError,
    runDetect,
    refresh,
    replaceWorkbench,
    runDirectCommand,
    observeConfirmedDirectSummary,
    appendRecentWrites,
  } = useReviewObservation({
    workbench,
    onWorkbenchReplace,
    onWorkbenchPatch,
  });
  const {
    saveInlineComment,
    setThreadState,
    replyToThread,
    editComment,
    deleteComment,
  } = useDirectConversationActions({
    workbench,
    runDirectCommand,
    appendRecentWrites,
  });
  // Labels, assignees, and reviewers are pull-request-level metadata. Their
  // eligibility remains a projection concern; the hook owns only their reads,
  // writes, receipt parsing, and recent-write journal entries.
  const canWriteLabels = workbench.review.status === "open";
  const canWriteAssignees = workbench.review.status === "open";
  const canWriteReviewers = workbench.review.status === "open";
  const {
    fetchLabels,
    addLabels,
    removeLabels,
    fetchAssignableUsers,
    addAssignees,
    removeAssignees,
    assignSelf,
    fetchReviewers,
    requestReviewers,
    removeReviewers,
  } = useReviewMetadataActions({
    workbench,
    runDirectCommand,
    appendRecentWrites,
  });
  const canWriteDirectConversation =
    workbench.review.status === "open" &&
    workbench.revision.freshness === "fresh" &&
    workbench.revision.patchHash !== undefined;
  const { pendingReviewComposer, pendingReview, openFinishDialogWithSummary } =
    usePendingReviewActions({
      workbench,
      onWorkbenchReplace: replaceWorkbench,
      onWorkbenchPatch,
      appendRecentWrites,
    });
  const { directSummary } = useDirectSummaryActions({
    workbench,
    runDirectCommand,
    appendRecentWrites,
    observeConfirmedDirectSummary,
  });
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

  const conversationActions = canWriteDirectConversation
    ? { setThreadState, replyToThread, editComment, deleteComment }
    : undefined;
  const labelActions: LabelPickerActions | undefined = canWriteLabels
    ? { fetchLabels, addLabels, removeLabels }
    : undefined;
  const assigneeActions: AssigneesSectionActions | undefined = canWriteAssignees
    ? { fetchAssignableUsers, addAssignees, removeAssignees, assignSelf }
    : undefined;
  const reviewerActions: ReviewerPickerActions | undefined = canWriteReviewers
    ? { fetchReviewers, requestReviewers, removeReviewers }
    : undefined;

  const workbenchActionsBase = {
    detectUpdates: runDetect,
    refresh,
    loadCommitDiff: async (commitSha: string): Promise<CommitDiffResponse> => {
      const value = await requestJson("/v1/reviews/commit-diff", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          reviewId: workbench.review.id,
          commitSha,
        },
      });
      const parsed = parseCommitDiffResponse(value);
      if (parsed === undefined) throw new Error("Invalid commit diff response");
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
    pendingReview === undefined
      ? workbenchActionsWithPendingReviewComposer
      : {
          ...workbenchActionsWithPendingReviewComposer,
          pendingReview,
        };
  const workbenchActionsWithDirectSummaryPanel =
    directSummary === undefined
      ? workbenchActionsWithPendingReviewPanel
      : {
          ...workbenchActionsWithPendingReviewPanel,
          directSummary,
        };
  const workbenchActionsWithLabels =
    labelActions === undefined
      ? workbenchActionsWithDirectSummaryPanel
      : { ...workbenchActionsWithDirectSummaryPanel, labels: labelActions };
  const workbenchActionsWithAssignees =
    assigneeActions === undefined
      ? workbenchActionsWithLabels
      : { ...workbenchActionsWithLabels, assignees: assigneeActions };
  const workbenchActionsWithReviewers =
    reviewerActions === undefined
      ? workbenchActionsWithAssignees
      : { ...workbenchActionsWithAssignees, reviewers: reviewerActions };
  const workbenchActions =
    conversationActions === undefined
      ? workbenchActionsWithReviewers
      : { ...workbenchActionsWithReviewers, ...conversationActions };

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
              onFinishWithAnalysisSummary={openFinishDialogWithSummary}
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
type CatalogModel = InsightProviderCatalogModel;
/** Replaces every `codex-cli-account` entry in a model list, keeping the rest. */
function mergeCodexModels(
  models: ReadonlyArray<CatalogModel>,
  codexModels: ReadonlyArray<CatalogModel>,
): CatalogModel[] {
  return [
    ...models.filter((candidate) => candidate.provider !== "codex-cli-account"),
    ...codexModels,
  ];
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
        const cachedCodexModels = loadCodexModelCache(profileId);
        const catalogWithCache =
          cachedCodexModels === undefined
            ? parsed
            : {
                ...parsed,
                models: mergeCodexModels(parsed.models, cachedCodexModels),
              };
        setConfiguration({
          catalog: catalogWithCache,
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
                models: mergeCodexModels(catalog.models, parsed.models),
              };
        const codexModels = parsed.models.filter(
          (candidate) => candidate.provider === "codex-cli-account",
        );
        saveCodexModelCache(profileId, codexModels);
        const preference = preferencesRef.current[activePreferenceType];
        const first = codexModels[0];
        setConfiguration({
          catalog: nextCatalog,
          models: codexModels,
          model:
            preference?.provider === "codex-cli-account" &&
            codexModels.some((candidate) => candidate.id === preference.model)
              ? preference.model
              : (first?.id ?? null),
          reasoning:
            preference?.provider === "codex-cli-account"
              ? preference.reasoning
              : (first?.defaultReasoning ?? first?.reasoning[0] ?? "medium"),
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
          onRefreshCodexModels={activateCodex}
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
