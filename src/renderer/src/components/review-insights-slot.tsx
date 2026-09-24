import { XIcon } from "lucide-react";
import { useId, useMemo } from "react";
import { definedProps } from "../../../domain/defined-props";
import { parseUnifiedPatch, type ParsedPatchFile } from "../../../domain/patch";

import type { InsightProvider } from "../../../domain/insight-provider";
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
import type { WorkbenchResponse } from "../renderer-contracts";
import type { AnalysisFinding } from "../flows/use-analysis-review-actions";
import type { ReviewWorkbenchPatch } from "../flows/use-review-observation";
import { INSIGHT_PROVIDER_LABELS } from "../insight-contracts";
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
function InsightDocumentIdentity({
  retained,
  selectedInsight,
  selectedIsOutdated,
  walkthroughTitle,
}: {
  readonly retained:
    | Readonly<{
        generatedAt: string;
        provenance?:
          | Readonly<{ provider: "pi" | "codex-cli-account"; model: string }>
          | undefined;
      }>
    | undefined;
  readonly selectedInsight: InsightRunDialogType;
  readonly selectedIsOutdated: boolean;
  readonly walkthroughTitle: string | undefined;
}): React.JSX.Element {
  // The Brief draws its own Provenance card, so only the other readers state
  // the provider and model here; the revision itself is named once, in the
  // workbench header.
  const provenance =
    selectedInsight === "brief" ? undefined : retained?.provenance;
  // The selected tab already names the Insight, so the only heading worth
  // drawing is a Walkthrough document's own title.
  const heading =
    selectedInsight === "walkthrough" ? walkthroughTitle : undefined;
  return (
    <div className="min-w-0">
      {heading === undefined ? null : (
        <h2 className="truncate text-lg font-semibold">{heading}</h2>
      )}
      {retained === undefined ? null : (
        <p className="truncate text-sm text-muted-foreground">
          <RelativeTime
            iso={retained.generatedAt}
            prefix={selectedIsOutdated ? "Outdated · generated " : "Generated "}
          />
          {provenance === undefined
            ? null
            : ` · ${INSIGHT_PROVIDER_LABELS[provenance.provider]} · ${provenance.model}`}
        </p>
      )}
    </div>
  );
}
export const TERMINAL_REVIEW_INSIGHT_REASON =
  "This Review is merged or closed; Insights cannot be generated.";

function hasAvailableInsightProvider(
  configuration: InsightRunConfiguration,
): boolean {
  return (
    configuration.catalog?.providers.some((candidate) => candidate.available) ??
    false
  );
}

/** Whether an Insight run can start, and the id of the reason it cannot when the Review is merged or closed. */
function useInsightRunAvailability(
  workbench: WorkbenchResponse,
  configuration: InsightRunConfiguration,
) {
  const reasonId = `insight-run-reason-${useId()}`;
  const reviewOpen = workbench.review.status === "open";
  return {
    runEnabled:
      !configuration.catalogError &&
      hasAvailableInsightProvider(configuration) &&
      reviewOpen,
    runDisabledReasonId: reviewOpen ? undefined : reasonId,
  };
}

function InsightAvailabilityErrors({
  terminalReasonId,
  configuration,
  requestFailureMessage,
}: {
  /** Set on a merged or closed Review, whose reason replaces provider errors because fixing a provider would not enable a run. */
  readonly terminalReasonId: string | undefined;
  readonly configuration: InsightRunConfiguration;
  readonly requestFailureMessage: string | undefined;
}): React.JSX.Element {
  const { catalogError, provider, models } = configuration;
  const hasAvailableProvider = hasAvailableInsightProvider(configuration);
  const unavailable =
    terminalReasonId === undefined &&
    (catalogError ||
      !hasAvailableProvider ||
      (provider === "pi" && models.length === 0));
  return (
    <>
      {terminalReasonId === undefined ? null : (
        <p id={terminalReasonId} className="py-2 text-sm text-muted-foreground">
          {TERMINAL_REVIEW_INSIGHT_REASON}
        </p>
      )}
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
  onFinishWithAnalysisSummary,
}: {
  readonly workbench: WorkbenchResponse;
  readonly initialDetail?: "analysis" | "walkthrough";
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
  readonly onReprepare: () => Promise<WorkbenchResponse>;
  readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void>;
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
  const { runEnabled, runDisabledReasonId } = useInsightRunAvailability(
    workbench,
    configuration,
  );
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
    profileId,
    reviewId,
    ...definedProps({
      onFinishWithAnalysisSummary,
      addFinding: onAddFinding,
      onOpenFindingInDiff: openFindingInDiff,
    }),
    dismissFinding,
    analysisVerification,
    walkthroughFocused,
    setWalkthroughFocused: requestWalkthroughFocusChange,
    onRegenerateBrief: () => openRunDialog("regenerate"),
    // The Brief points at the Walkthrough rather than duplicating it: read the
    // one that already stands for this revision, or start one from the same
    // run dialog every other Insight run uses.
    onOpenWalkthrough: () => {
      if (workbench.insights.walkthrough.status === "current") {
        setSelectedInsight("walkthrough");
        return;
      }
      openRunDialog("run", "walkthrough");
    },
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
  const showDocumentHeader =
    selectedRetained !== undefined ||
    selectedRunning?.busy === true ||
    selectedProjection?.status === "running";
  const dialogRun =
    configuration.runDialogType === null
      ? undefined
      : runs[configuration.runDialogType];
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
          />
        )}
        <article
          aria-label={`${selectedInsight} document`}
          data-review-insight-document={selectedInsight}
          className={`flex h-full min-h-0 min-w-0 flex-1 flex-col ${selectedInsight === "walkthrough" ? "overflow-hidden" : "overflow-auto"}`}
        >
          {walkthroughFocusActive || !showDocumentHeader ? null : (
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b pb-2">
              <InsightDocumentIdentity
                retained={selectedRetained}
                selectedInsight={selectedInsight}
                selectedIsOutdated={selectedIsOutdated}
                walkthroughTitle={
                  workbench.insights.walkthrough.retained?.value.title
                }
              />
              <div className="flex flex-wrap items-center gap-2">
                {selectedRunning?.busy ||
                selectedProjection?.status === "running" ? (
                  <Button
                    size="icon-sm"
                    variant="outline"
                    onClick={selectedRunning?.cancel}
                    disabled={
                      selectedRunning === undefined ||
                      selectedRunning.starting ||
                      selectedRunning.cancelling
                    }
                    aria-label={
                      selectedRunning?.cancelling
                        ? `Cancelling ${selectedInsightName}…`
                        : `Cancel ${selectedInsightName}`
                    }
                  >
                    {selectedRunning?.cancelling ? (
                      <Spinner aria-hidden="true" />
                    ) : (
                      <XIcon aria-hidden="true" />
                    )}
                  </Button>
                ) : analysisFirstRunActive ||
                  // A merged or closed Review keeps only the reason line below.
                  runDisabledReasonId !== undefined ||
                  selectedIsOutdated ||
                  selectedProjection?.status === "failed" ||
                  selectedProjection?.retained === undefined ? null : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => openRunDialog("regenerate")}
                    disabled={!runEnabled}
                  >
                    Regenerate
                  </Button>
                )}
              </div>
            </header>
          )}
          <InsightAvailabilityErrors
            terminalReasonId={runDisabledReasonId}
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
                onRetry={() => openRunDialog("retry")}
                onReprepare={onReprepare}
                {...definedProps({ retainedDescription })}
              />
            ) : selectedIsOutdated ? (
              <InsightOutdated
                type={selectedInsight}
                onRetry={() => openRunDialog("retry")}
                {...definedProps({
                  retainedRevision: selectedRetained?.headSha,
                })}
                currentRevision={currentRevision}
              />
            ) : retainedReader === null ? (
              <InsightEmpty
                type={selectedInsight}
                disabled={!runEnabled}
                {...definedProps({
                  onRun:
                    runDisabledReasonId === undefined
                      ? () => openRunDialog("run")
                      : undefined,
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
      onConfirm={confirmRun}
      pending={runPending}
      {...definedProps({ errorMessage: runErrorMessage })}
    />
  );
}
