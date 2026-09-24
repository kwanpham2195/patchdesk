import { XIcon } from "lucide-react";
import { useMemo } from "react";
import { definedProps } from "../../../domain/defined-props";
import { parseUnifiedPatch, type ParsedPatchFile } from "../../../domain/patch";

import type {
  InsightLanguage,
  InsightProvider,
} from "../../../domain/insight-provider";
import {
  INSIGHT_NOUNS,
  InsightRunDialog,
  type InsightRunDialogType,
} from "./insight-run-dialog";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";
import { Spinner } from "./ui/spinner";
import {
  InsightArtifactMismatch,
  InsightEmpty,
  InsightFailed,
  InsightNavRail,
  InsightOutdated,
  InsightRunning,
} from "./insight-panels";
import { NOT_GENERATED_BRIEF, type BriefInsight } from "../brief-contracts";
import { buildInsightReaders } from "./insight-readers";
import { useInsightResultEntrance } from "../hooks/use-insight-result-entrance";
import { useInsightSelection } from "../hooks/use-insight-selection";
import { useWalkthroughFocusTransition } from "../hooks/use-walkthrough-focus-transition";
import type { InsightRunConfiguration } from "../hooks/use-insight-configuration";
import { useInsightRunControls } from "../hooks/use-insight-run-controls";
import { useAnalysisVerification } from "../hooks/use-analysis-verification";
import { useWalkthroughProgress } from "../hooks/use-walkthrough-progress";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { AnalysisFinding } from "../flows/use-analysis-review-actions";
import type { AddAllFindingsControls } from "../flows/use-add-all-findings";
import type { ReviewWorkbenchPatch } from "../flows/use-review-observation";
import {
  INSIGHT_LANGUAGE_LABELS,
  INSIGHT_PROVIDER_LABELS,
} from "../insight-contracts";
import { RelativeTime } from "./relative-time";

function insightRequestFailureMessage(
  insightName: string,
  requestFailure: "start" | "cancel" | "status" | undefined,
): string | undefined {
  if (requestFailure === "start")
    return `${insightName} could not start. Check the run options and try again.`;
  if (requestFailure === "cancel")
    return `${insightName} cancel failed; still running. Try again.`;
  if (requestFailure === "status")
    return `${insightName} status refresh failed; still running.`;
  return undefined;
}
/** The selected document's retained time, provider, and model, drawn muted at the right end of the tab strip. */
function InsightDocumentMeta({
  retained,
  selectedInsight,
  selectedIsOutdated,
}: {
  readonly retained:
    | Readonly<{
        generatedAt: string;
        provenance?:
          | Readonly<{
              provider: "pi" | "codex-cli-account";
              model: string;
              language: InsightLanguage;
            }>
          | undefined;
      }>
    | undefined;
  readonly selectedInsight: InsightRunDialogType;
  readonly selectedIsOutdated: boolean;
}): React.JSX.Element | null {
  if (retained === undefined) return null;
  // The Brief draws its own Provenance card, so only the other readers state the provider and model here.
  const provenance =
    selectedInsight === "brief" ? undefined : retained.provenance;
  const language = retained.provenance?.language;
  return (
    <p className="min-w-0 truncate text-xs text-muted-foreground">
      <RelativeTime
        iso={retained.generatedAt}
        prefix={selectedIsOutdated ? "Outdated · generated " : "Generated "}
      />
      {provenance === undefined
        ? null
        : ` · ${INSIGHT_PROVIDER_LABELS[provenance.provider]} · ${provenance.model}`}
      {language === undefined || language === "en"
        ? null
        : ` · ${INSIGHT_LANGUAGE_LABELS[language]}`}
    </p>
  );
}
function hasAvailableInsightProvider(
  configuration: InsightRunConfiguration,
): boolean {
  return (
    configuration.catalog?.providers.some((candidate) => candidate.available) ??
    false
  );
}

function InsightAvailabilityErrors({
  reviewOpen,
  configuration,
  requestFailureMessage,
}: {
  /** A merged or closed Review hides every run control, so a provider error would name a fix that enables nothing. */
  readonly reviewOpen: boolean;
  readonly configuration: InsightRunConfiguration;
  readonly requestFailureMessage: string | undefined;
}): React.JSX.Element {
  const { catalogError, provider, models } = configuration;
  const hasAvailableProvider = hasAvailableInsightProvider(configuration);
  const unavailable =
    reviewOpen &&
    (catalogError ||
      !hasAvailableProvider ||
      (provider === "pi" && models.length === 0));
  return (
    <>
      {unavailable ? (
        <InlineError className="py-2">
          {catalogError || !hasAvailableProvider
            ? "No model configured. Add a provider API key, then reload."
            : "No API-key model configured. Open a run and pick Codex CLI account."}
        </InlineError>
      ) : null}
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

/** The one line each reader shows under its heading, taken from the retained artifact it is reading. */
function retainedInsightDescription(
  workbench: WorkbenchResponse,
  brief: BriefInsight,
  selectedInsight: InsightRunDialogType,
): string | undefined {
  if (selectedInsight === "analysis")
    return workbench.insights.analysis.retained?.value.summary;
  if (selectedInsight === "walkthrough")
    return workbench.insights.walkthrough.retained?.value.focus;
  return (
    brief.retained?.value.flow?.trees[0]?.title ??
    brief.retained?.value.startHere?.lead
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
  onFinishWithAnalysisSummary,
}: {
  readonly workbench: WorkbenchResponse;
  readonly initialDetail?: "analysis" | "walkthrough";
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
  readonly onReprepare: () => Promise<WorkbenchResponse>;
  readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void>;
  readonly addAllFindings?: AddAllFindingsControls;
  readonly onFinishWithAnalysisSummary?: (summary: string) => void;
}): React.JSX.Element {
  const {
    initialInsight,
    selectedInsight,
    setSelectedInsight,
    openFindingInDiff,
  } = useInsightSelection(initialDetail, workbench.insights);
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
    activateCodex,
    analysisRun,
    walkthroughRun,
    briefRun,
    openRunDialog,
    closeRunDialog,
    confirmRun,
    dismissFinding,
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
  const walkthroughProgress = useWalkthroughProgress({
    profileId,
    reviewId,
    reviewOpen: workbench.review.status === "open",
    walkthrough: workbench.insights.walkthrough,
    onWorkbenchPatch,
  });
  const brief = workbench.insights.brief ?? NOT_GENERATED_BRIEF;
  const projections = {
    analysis: workbench.insights.analysis,
    walkthrough: workbench.insights.walkthrough,
    brief,
  };
  const runs = {
    analysis: analysisRun,
    walkthrough: walkthroughRun,
    brief: briefRun,
  };
  const reviewOpen = workbench.review.status === "open";
  const runEnabled =
    !configuration.catalogError &&
    hasAvailableInsightProvider(configuration) &&
    reviewOpen;
  const selectedProjection = projections[selectedInsight];
  const insightResultRef = useInsightResultEntrance({
    retainedRunIds: {
      analysis: workbench.insights.analysis.retained?.runId,
      brief: brief.retained?.runId,
      walkthrough: workbench.insights.walkthrough.retained?.runId,
    },
    selectedInsight,
    selectedProjectionStatus: selectedProjection?.status,
  });
  const selectedRunning = runs[selectedInsight];
  const retainedDescription = retainedInsightDescription(
    workbench,
    brief,
    selectedInsight,
  );
  const currentRevision =
    workbench.revision.currentHeadSha ?? workbench.revision.reviewedHeadSha;
  const patchFiles = useParsedPatchFiles(workbench.fullPatch);
  const retainedReader = buildInsightReaders({
    workbench,
    patchFiles,
    selectedInsight,
    ...definedProps({
      onFinishWithAnalysisSummary,
      addFinding: onAddFinding,
      addAllFindings,
      onOpenFindingInDiff: openFindingInDiff,
      // The Brief points at the Walkthrough rather than duplicating it: read the current one, or start one while the Review is open.
      onOpenWalkthrough:
        workbench.insights.walkthrough.status === "current"
          ? () => setSelectedInsight("walkthrough")
          : reviewOpen
            ? () => openRunDialog("run", "walkthrough")
            : undefined,
    }),
    dismissFinding,
    analysisVerification,
    walkthroughProgress,
    walkthroughFocused,
    setWalkthroughFocused: requestWalkthroughFocusChange,
    onRegenerateBrief: () => openRunDialog("regenerate"),
    runEnabled,
  });
  const walkthroughFocusActive =
    selectedInsight === "walkthrough" && walkthroughFocused;
  const selectedRetained = selectedProjection?.retained;
  const selectedIsOutdated = selectedProjection?.status === "outdated";
  const analysisFirstRunActive =
    selectedInsight === "analysis" &&
    selectedProjection?.status === "running" &&
    selectedProjection.retained === undefined;
  const selectedRequestFailure = selectedRunning?.requestFailure;
  const selectedInsightName = INSIGHT_NOUNS[selectedInsight];
  const walkthroughTitle =
    selectedInsight === "walkthrough" && selectedRetained !== undefined
      ? workbench.insights.walkthrough.retained?.value.title
      : undefined;
  const dialogRun =
    configuration.runDialogType === null
      ? undefined
      : runs[configuration.runDialogType];
  const retryRun = reviewOpen ? () => openRunDialog("retry") : undefined;
  const selectedRequestFailureMessage = insightRequestFailureMessage(
    selectedInsightName,
    selectedRequestFailure,
  );
  return (
    <section
      aria-label="Review insights"
      data-walkthrough-focus-transition={walkthroughFocusTransition}
      onTransitionEnd={handleWalkthroughFocusTransitionEnd}
      className="flex h-full min-h-0 w-full flex-col gap-2"
    >
      <div className="flex h-full min-h-0 flex-1 flex-col gap-2">
        {walkthroughFocusActive ? null : (
          <InsightNavRail
            workbench={workbench}
            selectedInsight={selectedInsight}
            setSelectedInsight={setSelectedInsight}
            trailing={
              <div className="flex min-w-0 items-center gap-2 pb-1 empty:hidden">
                <InsightDocumentMeta
                  retained={selectedRetained}
                  selectedInsight={selectedInsight}
                  selectedIsOutdated={selectedIsOutdated}
                />
                <InsightHeaderAction
                  running={selectedRunning}
                  projectionRunning={selectedProjection?.status === "running"}
                  insightName={selectedInsightName}
                  hideRegenerate={
                    analysisFirstRunActive ||
                    !reviewOpen ||
                    selectedIsOutdated ||
                    selectedProjection?.status === "failed" ||
                    selectedProjection?.retained === undefined
                  }
                  runEnabled={runEnabled}
                  onRegenerate={() => openRunDialog("regenerate")}
                />
              </div>
            }
          />
        )}
        <article
          aria-label={`${selectedInsight} document`}
          data-review-insight-document={selectedInsight}
          className={`flex h-full min-h-0 min-w-0 flex-1 flex-col ${selectedInsight === "walkthrough" ? "overflow-hidden" : "overflow-auto"}`}
        >
          {walkthroughFocusActive || walkthroughTitle === undefined ? null : (
            <h2 className="shrink-0 truncate pb-2 text-lg font-semibold">
              {walkthroughTitle}
            </h2>
          )}
          <InsightAvailabilityErrors
            reviewOpen={reviewOpen}
            configuration={configuration}
            requestFailureMessage={selectedRequestFailureMessage}
          />
          {selectedProjection?.artifactStatus === "mismatch" ? (
            <InsightArtifactMismatch />
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
                activity={selectedRunning?.activity}
              />
            ) : selectedProjection?.status === "failed" ? (
              <InsightFailed
                projection={selectedProjection}
                activity={selectedRunning?.activity}
                onReprepare={onReprepare}
                {...definedProps({ retainedDescription, onRetry: retryRun })}
              />
            ) : selectedIsOutdated ? (
              <InsightOutdated
                type={selectedInsight}
                {...definedProps({
                  retainedRevision: selectedRetained?.headSha,
                  onRetry: retryRun,
                })}
                currentRevision={currentRevision}
              />
            ) : retainedReader === null ? (
              <InsightEmpty
                type={selectedInsight}
                disabled={!runEnabled}
                {...definedProps({
                  onRun: reviewOpen ? () => openRunDialog("run") : undefined,
                })}
              />
            ) : null}
            {retainedReader === null ? null : (
              <div
                ref={insightResultRef}
                data-insight-result
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
        </article>
      </div>
      <InsightRunControls
        configuration={configuration}
        closeRunDialog={closeRunDialog}
        setConfiguration={setConfiguration}
        changeProvider={changeProvider}
        activateCodex={activateCodex}
        confirmRun={confirmRun}
        runPending={dialogRun?.starting ?? false}
        {...definedProps({
          runErrorMessage:
            configuration.runDialogType === null
              ? undefined
              : insightRequestFailureMessage(
                  INSIGHT_NOUNS[configuration.runDialogType],
                  dialogRun?.requestFailure,
                ),
        })}
      />
    </section>
  );
}

function InsightRunControls({
  configuration,
  closeRunDialog,
  setConfiguration,
  changeProvider,
  activateCodex,
  confirmRun,
  runPending,
  runErrorMessage,
}: {
  readonly configuration: InsightRunConfiguration;
  readonly closeRunDialog: () => void;
  readonly setConfiguration: (patch: Partial<InsightRunConfiguration>) => void;
  readonly changeProvider: (provider: InsightProvider) => void;
  readonly activateCodex: () => void;
  readonly confirmRun: () => void;
  readonly runPending: boolean;
  readonly runErrorMessage?: string;
}): React.JSX.Element | null {
  const {
    models,
    model,
    provider,
    codexActivationPending,
    codexActivationError,
    reasoning,
    language,
    runDialogType,
    runDialogAction,
  } = configuration;
  if (runDialogType === null) return null;
  return (
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
      language={language}
      onOpenChange={(open) => {
        if (!open) closeRunDialog();
      }}
      onModelChange={(nextModel) => {
        const selected = models.find((candidate) => candidate.id === nextModel);
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
      onLanguageChange={(nextLanguage) =>
        setConfiguration({ language: nextLanguage })
      }
      onConfirm={confirmRun}
      pending={runPending}
      {...definedProps({ errorMessage: runErrorMessage })}
    />
  );
}

/** Cancels the selected Insight's run while it runs, or offers Regenerate for its retained result. */
function InsightHeaderAction({
  running,
  projectionRunning,
  insightName,
  hideRegenerate,
  runEnabled,
  onRegenerate,
}: {
  readonly running:
    | ReturnType<typeof useInsightRunControls>["analysisRun"]
    | undefined;
  readonly projectionRunning: boolean;
  readonly insightName: string;
  readonly hideRegenerate: boolean;
  readonly runEnabled: boolean;
  readonly onRegenerate: () => void;
}): React.JSX.Element | null {
  if (running?.busy || projectionRunning)
    return (
      <Button
        size="icon-sm"
        variant="outline"
        onClick={running?.cancel}
        disabled={
          running === undefined || running.starting || running.cancelling
        }
        aria-label={
          running?.cancelling
            ? `Cancelling ${insightName}…`
            : `Cancel ${insightName}`
        }
      >
        {running?.cancelling ? (
          <Spinner aria-hidden="true" />
        ) : (
          <XIcon aria-hidden="true" />
        )}
      </Button>
    );
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
