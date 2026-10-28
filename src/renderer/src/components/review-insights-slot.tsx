import type { GuideReadingControls } from "#src/renderer/src/hooks/use-guide-reading-state";
import { useGuideReadingTransition } from "#src/renderer/src/hooks/use-guide-reading-flush";
import { useContext, useMemo, type RefObject } from "react";
import { definedProps } from "#src/domain/defined-props";
import { supportsInsightProvider } from "#src/domain/insight-provider-capabilities";
import type { LocalPatchView } from "#src/domain/local-patch-view";
import { parseUnifiedPatch, type ParsedPatchFile } from "#src/domain/patch";

import type {
  AccountInsightProvider,
  InsightLanguage,
  InsightProvider,
} from "#src/domain/insight-provider";
import {
  INSIGHT_NOUNS,
  InsightRunDialog,
  type InsightRunDialogType,
} from "./insight-run-dialog";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";
import {
  InsightArtifactMismatch,
  InsightEmpty,
  InsightFailed,
  InsightNavRail,
  InsightOutdated,
  InsightRunning,
  type InsightProjection,
} from "./insight-panels";
import { NOT_GENERATED_BRIEF } from "#src/renderer/src/brief-contracts";
import { buildInsightReaders } from "./insight-readers";
import { WalkthroughDiffAuthoringContext } from "./walkthrough-diff-authoring";
import { useInsightResultEntrance } from "#src/renderer/src/hooks/use-insight-result-entrance";
import { useInsightSelection } from "#src/renderer/src/hooks/use-insight-selection";
import { useWalkthroughFocusTransition } from "#src/renderer/src/hooks/use-walkthrough-focus-transition";
import type { InsightRunConfiguration } from "#src/renderer/src/hooks/use-insight-configuration";
import { useInsightRunControls } from "#src/renderer/src/hooks/use-insight-run-controls";
import {
  RUN_INSIGHTS_ORDER,
  type RunInsightsDialogController,
} from "#src/renderer/src/hooks/use-run-insights-dialog";
import { useAnalysisVerification } from "#src/renderer/src/hooks/use-analysis-verification";
import { walkthroughRevisionMatches } from "#src/renderer/src/hooks/use-walkthrough-summary";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import type { AnalysisFinding } from "#src/renderer/src/flows/use-analysis-review-actions";
import type { AddAllFindingsControls } from "#src/renderer/src/flows/use-add-all-findings";
import type { LocalApplyControls } from "#src/renderer/src/flows/use-local-apply";
import type { LocalDraftControls } from "#src/renderer/src/flows/use-local-drafts";
import { AgentRequestsBar } from "./agent-requests-bar";
import { RunInsightsDialog } from "./run-insights-dialog";
import { insightRunOptionsForModel } from "#src/renderer/src/insight-run-options";
import type { ReviewWorkbenchPatch } from "#src/renderer/src/flows/use-review-observation";
import {
  INSIGHT_LANGUAGE_LABELS,
  INSIGHT_PROVIDER_LABELS,
} from "#src/renderer/src/insight-contracts";
import { localPatchViewLabels } from "#src/renderer/src/review-source";
import { RelativeTime } from "./relative-time";
import type { InsightRunController } from "#src/renderer/src/hooks/use-insight-run";
import { useInsightSummaries } from "#src/renderer/src/hooks/use-insight-summaries";
import {
  analysisChangeIntentLine,
  changeIntentRunRefusalMessage,
} from "#src/renderer/src/change-intent-copy";

function insightRequestFailureMessage(
  insightName: string,
  requestFailure: InsightRunController["requestFailure"],
): string | undefined {
  if (requestFailure === undefined) return undefined;
  if (requestFailure === "unsupported_provider")
    return `${insightName} does not support this provider. Choose Codex or Pi CLI in the run options.`;
  if (requestFailure === "guide_input_too_large")
    return `${insightName} input exceeds the complete-input size limit. The existing ${insightName} is retained.`;
  if (requestFailure === "guide_patch_empty")
    return `${insightName} needs a nonempty patch with readable file headers.`;
  if (requestFailure === "guide_artifact_unreadable")
    return `${insightName} could not read its complete review evidence. Reprepare the Review and retry.`;
  if (requestFailure === "start")
    return `${insightName} could not start. Check the run options and try again.`;
  if (requestFailure === "cancel")
    return `${insightName} cancel failed; still running. Try again.`;
  if (requestFailure === "status")
    return `${insightName} status refresh failed; still running.`;
  if (requestFailure === "request_not_awaiting")
    return "The agent's request was declined or run meanwhile.";
  return changeIntentRunRefusalMessage(requestFailure);
}
/** The selected document's retained time, provider, and model, drawn muted at the right end of the tab strip. */
function InsightDocumentMeta({
  retained,
  selectedInsight,
  selectedIsOutdated,
  workbench,
  patchView,
}: {
  readonly retained:
    | Readonly<{
        generatedAt: string;
        provenance?:
          | Readonly<{
              provider: InsightProvider;
              model: string;
              language: InsightLanguage;
            }>
          | undefined;
      }>
    | undefined;
  readonly selectedInsight: InsightRunDialogType;
  readonly selectedIsOutdated: boolean;
  readonly workbench: WorkbenchResponse;
  readonly patchView: LocalPatchView | undefined;
}): React.JSX.Element | null {
  if (retained === undefined) return null;
  // The Change intent a local Review's Analysis ran against (#467).
  const changeIntentLine =
    selectedInsight === "analysis"
      ? analysisChangeIntentLine(
          workbench.insights.analysis.retained?.changeIntent,
          workbench.changeIntent,
        )
      : undefined;
  // The Brief draws its own Provenance card, so only the other readers state the provider and model here.
  const provenance =
    selectedInsight === "brief" ? undefined : retained.provenance;
  const language = retained.provenance?.language;
  return (
    <p
      aria-label="Insight document metadata"
      className="min-w-0 truncate text-xs text-muted-foreground"
    >
      <RelativeTime
        iso={retained.generatedAt}
        prefix={
          selectedIsOutdated
            ? "Outdated · generated "
            : selectedInsight === "guide"
              ? "Current · generated "
              : "Generated "
        }
      />
      {provenance === undefined
        ? null
        : ` · ${INSIGHT_PROVIDER_LABELS[provenance.provider]} · ${provenance.model}`}
      {language === undefined || language === "en"
        ? null
        : ` · ${INSIGHT_LANGUAGE_LABELS[language]}`}
      {changeIntentLine === undefined ? null : ` · ${changeIntentLine}`}
      {/* Every Insight runs on Combined, so another view's diff is not what it read (ADR 0050). */}
      {patchView === undefined || patchView === "combined"
        ? null
        : ` · ${localPatchViewLabels.combined} view`}
    </p>
  );
}
function insightRunEnabled(
  configuration: InsightRunConfiguration,
  reviewOpen: boolean,
  type: InsightRunDialogType,
): boolean {
  return (
    !configuration.catalogError &&
    hasAvailableInsightProvider(configuration, type) &&
    reviewOpen
  );
}

function hasAvailableInsightProvider(
  configuration: InsightRunConfiguration,
  type: InsightRunDialogType,
): boolean {
  return (
    configuration.catalog?.providers.some(
      (candidate) =>
        candidate.available &&
        candidate.supportedTypes.includes(type) &&
        supportsInsightProvider(type, candidate.id),
    ) ?? false
  );
}

function insightAvailabilityMessage(
  configuration: InsightRunConfiguration,
  type: InsightRunDialogType,
): string | undefined {
  if (configuration.catalogError)
    return "Could not load the model list. Reopen the Review to try again.";
  if (!hasAvailableInsightProvider(configuration, type))
    return "No native integration available. Install Codex or Pi CLI on the app launch PATH and log in externally.";
  return undefined;
}

function InsightAvailabilityErrors({
  reviewOpen,
  type,
  configuration,
  requestFailureMessage,
}: {
  /** A merged or closed Review hides every run control, so a provider error would name a fix that enables nothing. */
  readonly reviewOpen: boolean;
  readonly type: InsightRunDialogType;
  readonly configuration: InsightRunConfiguration;
  readonly requestFailureMessage: string | undefined;
}): React.JSX.Element {
  const message = reviewOpen
    ? insightAvailabilityMessage(configuration, type)
    : undefined;
  return (
    <>
      {message === undefined ? null : (
        <InlineError className="py-2">{message}</InlineError>
      )}
      {requestFailureMessage === undefined ? null : (
        <InlineError className="py-2">{requestFailureMessage}</InlineError>
      )}
    </>
  );
}

/**
 * The reviewed patch, parsed once per patch text. The readers need the same
 * files three times over and the bridge allows 8 MB of diff, so reparsing it
 * per render is the Insights tab's largest avoidable cost.
 */
function useParsedPatchFiles(
  fullPatch: string | undefined,
): ReadonlyArray<ParsedPatchFile> {
  return useMemo(
    () => (fullPatch === undefined ? [] : parseUnifiedPatch(fullPatch)),
    [fullPatch],
  );
}

export function InsightsSlot({
  workbench,
  initialDetail,
  onWorkbenchReplace,
  onWorkbenchPatch,
  onReprepare,
  onAddFinding,
  addAllFindings,
  localApply,
  localDrafts,
  onFinishWithAnalysisSummary,
  profileLabel,
  patchView,
}: {
  readonly workbench: WorkbenchResponse;
  readonly guideReading?: GuideReadingControls;
  readonly initialDetail?: "analysis" | "walkthrough" | "guide";
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
  readonly onReprepare: () => Promise<WorkbenchResponse>;
  readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void>;
  readonly addAllFindings?: AddAllFindingsControls;
  readonly localApply?: LocalApplyControls;
  /** A local Review's Local draft list (ADR 0050, ADR 0051). */
  readonly localDrafts?: LocalDraftControls;
  readonly onFinishWithAnalysisSummary?: (summary: string) => void;
  /** The workspace profile's label, set when more than one profile is configured. */
  readonly profileLabel?: string;
  readonly patchView?: LocalPatchView;
}): React.JSX.Element {
  const {
    initialInsight,
    selectedInsight,
    setSelectedInsight: selectInsight,
    openFindingInDiff,
    openFileInDiff,
    openScopeBucketInDiff,
  } = useInsightSelection(initialDetail, workbench.insights);
  const setSelectedInsight = useGuideReadingTransition(selectInsight, true);
  const {
    walkthroughFocused,
    walkthroughFocusTransition,
    requestWalkthroughFocusChange,
    handleWalkthroughFocusTransitionEnd,
  } = useWalkthroughFocusTransition();
  const profileId = workbench.session.key.profileId;
  const reviewId = workbench.review.id;
  const {
    configuration,
    setConfiguration,
    changeProvider,
    activateAccount,
    runs,
    openRunDialog,
    closeRunDialog,
    confirmRun,
    runInsights,
    dismissFinding,
    restoreFinding,
  } = useInsightRunControls({
    workbench,
    profileId,
    reviewId,
    initialInsight,
    selectedInsight,
    onWorkbenchReplace,
    onWorkbenchPatch,
  });
  const analysisVerification = useAnalysisVerification({
    profileId,
    reviewId,
    analysis: workbench.insights.analysis,
    onWorkbenchPatch,
  });
  const {
    walkthroughSummary,
    readyWalkthrough,
    walkthroughStatus,
    walkthroughRun,
    walkthroughCanRegenerate,
    selectedProjection,
    selectedRetained,
    selectedIsOutdated,
    analysisFirstRunActive,
    walkthroughTitle,
    guideSummary,
    guideSnapshot,
    readyGuide,
    guideStatus,
  } = useInsightSummaries(workbench, runs, selectedInsight);
  const brief = workbench.insights.brief ?? NOT_GENERATED_BRIEF;
  const guideRun = guideSnapshot?.run;
  const reviewOpen = workbench.review.status === "open";
  const canRun = (type: InsightRunDialogType): boolean =>
    insightRunEnabled(configuration, reviewOpen, type);
  const runEnabled = canRun(selectedInsight);
  const insightResultRef = useInsightResultEntrance({
    retainedRunIds: {
      analysis: workbench.insights.analysis.retained?.runId,
      brief: brief.retained?.runId,
      guide: readyGuide?.runId,
      walkthrough: readyWalkthrough?.runId,
    },
    selectedInsight,
    selectedProjectionStatus: selectedProjection?.status,
  });
  const selectedRunning = runs[selectedInsight];
  const selectedBusy =
    selectedInsight !== "guide" &&
    !(selectedInsight === "walkthrough" && walkthroughRun !== null) &&
    (selectedRunning?.busy === true ||
      selectedProjection?.status === "running");
  const currentRevision =
    workbench.revision.currentHeadSha ?? workbench.revision.reviewedHeadSha;
  const patchFiles = useParsedPatchFiles(workbench.fullPatch);
  const walkthroughDiffAuthoring = useContext(WalkthroughDiffAuthoringContext);
  const retainedReader = buildInsightReaders({
    runControllers: runs,
    workbench,
    patchFiles,
    selectedInsight,
    ...definedProps({
      onRunGuide: reviewOpen ? () => openRunDialog("run") : undefined,
      onRunWalkthrough: reviewOpen
        ? () => openRunDialog("run", "walkthrough")
        : undefined,
      onFinishWithAnalysisSummary,
      addFinding: onAddFinding,
      addAllFindings,
      localApply,
      localDrafts,
      walkthroughDiffAuthoring,
      onOpenFindingInDiff: openFindingInDiff,
      onOpenFileInDiff: openFileInDiff,
      onOpenScopeBucketInDiff: openScopeBucketInDiff,
    }),
    dismissFinding,
    restoreFinding,
    analysisVerification,
    walkthroughSummaryState: walkthroughSummary.state,
    refreshWalkthrough: walkthroughSummary.refresh,
    onReprepare,
    walkthroughFocused,
    setWalkthroughFocused: requestWalkthroughFocusChange,
    onRegenerateBrief: () => openRunDialog("regenerate"),
    runEnabled,
    guideSummaryState: guideSummary.state,
    refreshGuide: guideSummary.refresh,
    guideActiveRun: guideSummary.activeRun,
    guideOnReprepare: onReprepare,
  });
  const walkthroughFocusActive =
    selectedInsight === "walkthrough" && walkthroughFocused;
  const selectedInsightName = INSIGHT_NOUNS[selectedInsight];
  const retryRun = reviewOpen ? () => openRunDialog("retry") : undefined;
  const selectedRequestFailureMessage = insightRequestFailureMessage(
    selectedInsightName,
    selectedRunning?.requestFailure,
  );
  return (
    <section
      aria-label="Review insights"
      data-walkthrough-focus-transition={walkthroughFocusTransition}
      onTransitionEnd={handleWalkthroughFocusTransitionEnd}
      className="flex h-full min-h-0 w-full flex-col gap-2"
    >
      {walkthroughFocusActive ? null : (
        <AgentRequestsBar
          workbench={workbench}
          onWorkbenchPatch={onWorkbenchPatch}
          {...definedProps({ profileLabel })}
          runBlockedReason={(type) =>
            agentRunBlockedReason(canRun(type), runs[type], type)
          }
          onRun={(request) => {
            setSelectedInsight(request.type);
            openRunDialog("run", request.type, request.requestId);
          }}
        />
      )}
      <div className="flex h-full min-h-0 flex-1 flex-col gap-2">
        {walkthroughFocusActive ? null : (
          <InsightNavRail
            workbench={workbench}
            selectedInsight={selectedInsight}
            setSelectedInsight={setSelectedInsight}
            runs={runs}
            guideStatus={guideStatus}
            walkthroughStatus={walkthroughStatus}
            onRunInsights={reviewOpen ? runInsights.open : undefined}
            runInsightsDisabled={!RUN_INSIGHTS_ORDER.some(canRun)}
            trailing={
              <div className="flex min-w-0 items-center gap-2 pb-1 empty:hidden">
                <InsightDocumentMeta
                  retained={selectedRetained}
                  selectedInsight={selectedInsight}
                  selectedIsOutdated={selectedIsOutdated}
                  workbench={workbench}
                  patchView={patchView}
                />
                {selectedInsight === "brief" && !selectedBusy ? (
                  <BriefWalkthroughAction
                    workbench={workbench}
                    walkthroughReady={
                      readyWalkthrough !== undefined &&
                      walkthroughRevisionMatches(workbench, readyWalkthrough)
                    }
                    runEnabled={canRun("walkthrough")}
                    onOpen={() => setSelectedInsight("walkthrough")}
                    onGenerate={() => openRunDialog("run", "walkthrough")}
                  />
                ) : null}
                <InsightHeaderAction
                  running={
                    (selectedInsight === "guide" &&
                      (!reviewOpen || guideSummary.activeRun !== null)) ||
                    (selectedInsight === "walkthrough" &&
                      walkthroughRun !== null)
                      ? undefined
                      : selectedRunning
                  }
                  projectionRunning={
                    selectedProjection?.status === "running" &&
                    !(
                      selectedInsight === "walkthrough" &&
                      walkthroughRun !== null
                    )
                  }
                  hideRegenerate={
                    analysisFirstRunActive ||
                    !reviewOpen ||
                    (selectedInsight !== "walkthrough" &&
                      (selectedIsOutdated ||
                        selectedProjection?.status === "failed")) ||
                    (selectedInsight === "guide"
                      ? readyGuide === undefined ||
                        guideSnapshot?.failure != null ||
                        guideRun != null ||
                        runs.guide.busy
                      : selectedInsight === "walkthrough"
                        ? !walkthroughCanRegenerate || runs.walkthrough.busy
                        : selectedProjection?.retained === undefined)
                  }
                  runEnabled={runEnabled}
                  onRegenerate={() => openRunDialog("regenerate")}
                />
              </div>
            }
          />
        )}
        <InsightDocument
          selectedInsight={selectedInsight}
          walkthroughTitle={
            walkthroughFocusActive ? undefined : walkthroughTitle
          }
          reviewOpen={reviewOpen}
          configuration={configuration}
          requestFailureMessage={selectedRequestFailureMessage}
          selectedProjection={selectedProjection}
          selectedBusy={selectedBusy}
          selectedRunning={selectedRunning}
          onReprepare={onReprepare}
          retryRun={retryRun}
          selectedIsOutdated={
            selectedInsight === "guide" ? false : selectedIsOutdated
          }
          currentRevision={currentRevision}
          onRun={() => openRunDialog("run")}
          runEnabled={runEnabled}
          retainedReader={retainedReader}
          insightResultRef={insightResultRef}
          detailsIdentity={{ profileId, reviewId }}
        />
      </div>
      <InsightRunControls
        configuration={configuration}
        closeRunDialog={closeRunDialog}
        setConfiguration={setConfiguration}
        changeProvider={changeProvider}
        activateAccount={activateAccount}
        confirmRun={confirmRun}
        runs={runs}
        runInsights={runInsights}
        runsOnCombined={workbench.patchViews !== undefined}
      />
    </section>
  );
}

function InsightDocument({
  selectedInsight,
  walkthroughTitle,
  reviewOpen,
  configuration,
  requestFailureMessage,
  selectedProjection,
  selectedBusy,
  selectedRunning,
  onReprepare,
  retryRun,
  selectedIsOutdated,
  currentRevision,
  onRun,
  runEnabled,
  retainedReader,
  insightResultRef,
  detailsIdentity,
}: {
  readonly selectedInsight: InsightRunDialogType;
  readonly walkthroughTitle: string | undefined;
  readonly reviewOpen: boolean;
  readonly configuration: InsightRunConfiguration;
  readonly requestFailureMessage: string | undefined;
  readonly selectedProjection: InsightProjection | undefined;
  readonly selectedBusy: boolean;
  readonly selectedRunning: InsightRunController | undefined;
  readonly onReprepare: () => Promise<WorkbenchResponse>;
  readonly retryRun: (() => void) | undefined;
  readonly selectedIsOutdated: boolean;
  readonly currentRevision: string;
  readonly onRun: () => void;
  readonly runEnabled: boolean;
  readonly retainedReader: React.ReactNode;
  readonly insightResultRef: RefObject<HTMLDivElement | null>;
  readonly detailsIdentity: {
    readonly profileId: string;
    readonly reviewId: string;
  };
}): React.JSX.Element {
  return (
    <article
      aria-label={`${selectedInsight} document`}
      data-review-insight-document={selectedInsight}
      className={`flex h-full min-h-0 min-w-0 flex-1 flex-col ${selectedInsight === "walkthrough" || selectedInsight === "guide" ? "overflow-hidden" : "overflow-auto"}`}
    >
      {walkthroughTitle === undefined ? null : (
        <h2 className="shrink-0 truncate pb-2 text-lg font-semibold">
          {walkthroughTitle}
        </h2>
      )}
      <InsightAvailabilityErrors
        reviewOpen={reviewOpen}
        type={selectedInsight}
        configuration={configuration}
        requestFailureMessage={requestFailureMessage}
      />
      {selectedProjection?.artifactStatus === "mismatch" ? (
        <InsightArtifactMismatch />
      ) : null}
      <div
        data-review-insight-content
        className={`flex min-h-0 flex-col gap-4 ${selectedInsight === "walkthrough" || selectedInsight === "guide" ? "flex-1 overflow-hidden" : ""}`}
      >
        {selectedBusy ? (
          <InsightRunning
            type={selectedInsight}
            projection={selectedProjection}
            activity={selectedRunning?.activity}
            status={
              selectedRunning?.starting
                ? "queued"
                : selectedRunning?.cancelling
                  ? "cancelling"
                  : selectedRunning?.status
            }
            onCancel={reviewOpen ? selectedRunning?.cancel : undefined}
            cancelDisabled={
              selectedRunning === undefined || selectedRunning.starting
            }
          />
        ) : selectedInsight !== "walkthrough" &&
          selectedProjection?.status === "failed" ? (
          <InsightFailed
            projection={selectedProjection}
            onReprepare={onReprepare}
            detailsSource={
              selectedProjection.replacementFailure?.runId === undefined
                ? undefined
                : {
                    ...detailsIdentity,
                    type: selectedInsight,
                    runId: selectedProjection.replacementFailure.runId,
                  }
            }
            {...definedProps({
              onRetry:
                selectedProjection.replacementFailure?.retryable === false
                  ? undefined
                  : retryRun,
            })}
          />
        ) : selectedIsOutdated ? (
          <InsightOutdated
            type={selectedInsight}
            {...definedProps({
              retainedRevision: selectedProjection?.retained?.headSha,
              onRetry: retryRun,
            })}
            currentRevision={currentRevision}
          />
        ) : retainedReader === null ? (
          <InsightEmpty
            type={selectedInsight}
            disabled={!runEnabled}
            {...definedProps({
              onRun: reviewOpen ? onRun : undefined,
            })}
          />
        ) : null}
        {selectedBusy && retainedReader === null ? (
          <p className="text-sm text-muted-foreground">
            No published {INSIGHT_NOUNS[selectedInsight]} yet.
          </p>
        ) : null}
        {retainedReader === null ? null : (
          <div
            ref={insightResultRef}
            data-insight-result
            className={
              selectedInsight === "walkthrough" || selectedInsight === "guide"
                ? "min-h-0 flex-1 overflow-hidden"
                : ""
            }
          >
            {retainedReader}
          </div>
        )}
      </div>
    </article>
  );
}

/** Why the Agent requests bar's Run cannot start a request of `type` now; undefined when it can. */
function agentRunBlockedReason(
  runEnabled: boolean,
  run: InsightRunController,
  type: InsightRunDialogType,
): string | undefined {
  if (!runEnabled) return "No model configured";
  return run.busy
    ? `${INSIGHT_NOUNS[type]} is ${run.starting || run.status === "queued" ? "preparing" : run.status === "cancelling" ? "cancelling" : "running"}`
    : undefined;
}

function RunInsightsControls({
  controller,
  configuration,
  runs,
  runsOnCombined,
}: {
  readonly controller: RunInsightsDialogController;
  readonly configuration: InsightRunConfiguration;
  readonly runs: Readonly<Record<InsightRunDialogType, InsightRunController>>;
  readonly runsOnCombined: boolean;
}): React.JSX.Element {
  const startFailureMessage = (type: InsightRunDialogType) =>
    insightRequestFailureMessage(
      INSIGHT_NOUNS[type],
      runs[type].requestFailure,
    );
  return (
    <RunInsightsDialog
      controller={controller}
      accountModelsPending={configuration.accountModelsPending}
      accountModelsFailure={configuration.accountModelsFailure}
      startFailureMessages={{
        brief: startFailureMessage("brief"),
        guide: startFailureMessage("guide"),
        walkthrough: startFailureMessage("walkthrough"),
        analysis: startFailureMessage("analysis"),
      }}
      runsOnCombined={runsOnCombined}
    />
  );
}

function InsightRunControls({
  configuration,
  closeRunDialog,
  setConfiguration,
  changeProvider,
  activateAccount,
  confirmRun,
  runs,
  runInsights,
  runsOnCombined,
}: {
  readonly configuration: InsightRunConfiguration;
  readonly closeRunDialog: () => void;
  readonly setConfiguration: (patch: Partial<InsightRunConfiguration>) => void;
  readonly changeProvider: (provider: InsightProvider) => void;
  readonly activateAccount: (provider: AccountInsightProvider) => void;
  readonly confirmRun: () => void;
  readonly runs: Readonly<Record<InsightRunDialogType, InsightRunController>>;
  readonly runInsights: RunInsightsDialogController;
  readonly runsOnCombined: boolean;
}): React.JSX.Element | null {
  if (runInsights.rows !== undefined)
    return (
      <RunInsightsControls
        controller={runInsights}
        configuration={configuration}
        runs={runs}
        runsOnCombined={runsOnCombined}
      />
    );
  const {
    models,
    model,
    provider,
    accountModelsPending,
    accountModelsFailure,
    reasoning,
    language,
    runDialogType,
    runDialogAction,
  } = configuration;
  if (runDialogType === null) return null;
  const dialogRun = runs[runDialogType];
  const runErrorMessage = insightRequestFailureMessage(
    INSIGHT_NOUNS[runDialogType],
    dialogRun.requestFailure,
  );
  return (
    <InsightRunDialog
      open
      type={runDialogType}
      action={runDialogAction}
      models={models}
      model={model}
      provider={provider}
      accountModelsPending={accountModelsPending}
      accountModelsFailure={accountModelsFailure}
      reasoning={reasoning}
      language={language}
      onOpenChange={(open) => {
        if (!open) closeRunDialog();
      }}
      onModelChange={(nextModel) =>
        setConfiguration(
          insightRunOptionsForModel(models, nextModel, reasoning),
        )
      }
      onProviderChange={changeProvider}
      onLoadAccountModels={activateAccount}
      onReasoningChange={(nextReasoning) =>
        setConfiguration({ reasoning: nextReasoning })
      }
      onLanguageChange={(nextLanguage) =>
        setConfiguration({ language: nextLanguage })
      }
      onConfirm={confirmRun}
      pending={dialogRun.starting}
      runsOnCombined={runsOnCombined}
      {...definedProps({
        errorMessage: runErrorMessage,
        selectionNotice: configuration.selectionNotice,
      })}
    />
  );
}

/**
 * The Brief points at the Walkthrough rather than repeating a reading order:
 * a retained Brief opens the current one, or starts one while the Review is
 * open.
 */
function BriefWalkthroughAction({
  workbench,
  walkthroughReady,
  runEnabled,
  onOpen,
  onGenerate,
}: {
  readonly workbench: WorkbenchResponse;
  readonly walkthroughReady: boolean;
  readonly runEnabled: boolean;
  readonly onOpen: () => void;
  readonly onGenerate: () => void;
}): React.JSX.Element | null {
  if (workbench.insights.brief?.retained === undefined) return null;
  if (walkthroughReady)
    return (
      <Button size="sm" variant="outline" onClick={onOpen}>
        Open walkthrough
      </Button>
    );
  if (workbench.review.status !== "open") return null;
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={onGenerate}
      disabled={!runEnabled}
    >
      Generate walkthrough
    </Button>
  );
}

/** Cancels the selected Insight's run while it runs, or offers Regenerate for its retained result. */
function InsightHeaderAction({
  running,
  projectionRunning,
  hideRegenerate,
  runEnabled,
  onRegenerate,
}: {
  readonly running:
    | ReturnType<typeof useInsightRunControls>["analysisRun"]
    | undefined;
  readonly projectionRunning: boolean;
  readonly hideRegenerate: boolean;
  readonly runEnabled: boolean;
  readonly onRegenerate: () => void;
}): React.JSX.Element | null {
  if (running?.busy || projectionRunning) return null;
  if (hideRegenerate) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={onRegenerate}
      disabled={!runEnabled}
    >
      Regenerate
    </Button>
  );
}
