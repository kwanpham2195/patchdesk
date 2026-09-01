import { useState } from "react";
import { XIcon } from "lucide-react";
import { definedProps } from "../../../domain/defined-props";

import type { InsightProvider } from "../../../domain/insight-provider";
import { INSIGHT_NOUNS, InsightRunDialog } from "./insight-run-dialog";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";
import { Spinner } from "./ui/spinner";
import {
  InsightArtifactMismatch,
  InsightEmpty,
  InsightFailed,
  InsightNavRail,
  InsightOutdated,
  InsightOverview,
  InsightRunning,
  type InsightSelection,
} from "./insight-panels";
import { NOT_GENERATED_BRIEF } from "../brief-contracts";
import { buildInsightReaders } from "./insight-readers";
import { useInsightResultEntrance } from "../hooks/use-insight-result-entrance";
import { useWalkthroughFocusTransition } from "../hooks/use-walkthrough-focus-transition";
import type { InsightRunConfiguration } from "../hooks/use-insight-configuration";
import { useInsightRunControls } from "../hooks/use-insight-run-controls";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { AnalysisFinding } from "../flows/use-analysis-review-actions";
import type { ReviewWorkbenchPatch } from "../flows/use-review-observation";

const insightTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatInsightTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return insightTimestampFormatter.format(timestamp);
}

function insightRequestFailureMessage(
  insightName: string,
  requestFailure: "start" | "cancel" | "status" | undefined,
): string | undefined {
  if (requestFailure === "start")
    return `${insightName} could not start. Check the run options and try again.`;
  if (requestFailure === "cancel")
    return `${insightName} cancellation failed. The current run is still active; try cancelling again.`;
  if (requestFailure === "status")
    return `${insightName} status could not be refreshed. The current run is still active; Patchdesk will check again.`;
  return undefined;
}
function InsightDocumentIdentity({
  retained,
  selectedInsight,
  selectedIsOutdated,
  currentRevision,
  walkthroughTitle,
}: {
  readonly retained:
    | Readonly<{
        headSha: string;
        generatedAt: string;
      }>
    | undefined;
  readonly selectedInsight: InsightSelection;
  readonly selectedIsOutdated: boolean;
  readonly currentRevision: string;
  readonly walkthroughTitle: string | undefined;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      {selectedInsight === "analysis" ? null : (
        <>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {selectedInsight}
          </p>
          <h2 className="truncate text-lg font-semibold">
            {selectedInsight === "brief"
              ? "Brief"
              : (walkthroughTitle ?? "Walkthrough document")}
          </h2>
        </>
      )}
      <p className="truncate text-sm text-muted-foreground">
        {retained === undefined
          ? "No retained result for this revision."
          : selectedIsOutdated
            ? `Retained revision ${retained.headSha.slice(0, 8)} · current revision ${currentRevision.slice(0, 8)} · ${formatInsightTimestamp(retained.generatedAt)}`
            : `Retained from ${retained.headSha.slice(0, 8)} · ${formatInsightTimestamp(retained.generatedAt)}`}
      </p>
    </div>
  );
}
function InsightAvailabilityErrors({
  catalogError,
  hasAvailableProvider,
  provider,
  modelCount,
  requestFailureMessage,
}: {
  readonly catalogError: boolean;
  readonly hasAvailableProvider: boolean;
  readonly provider: InsightProvider;
  readonly modelCount: number;
  readonly requestFailureMessage: string | undefined;
}): React.JSX.Element | null {
  const unavailable =
    catalogError ||
    !hasAvailableProvider ||
    (provider === "pi" && modelCount === 0);
  if (!unavailable && requestFailureMessage === undefined) return null;
  return (
    <>
      {unavailable ? (
        <InlineError className="py-2">
          {catalogError || !hasAvailableProvider
            ? "No eligible model configured. Set an API key or ambient provider credentials in the Electron process, then reload."
            : "No Pi model is configured. Open a run and select Codex CLI account to load its models."}
        </InlineError>
      ) : null}
      {requestFailureMessage === undefined ? null : (
        <InlineError className="py-2">{requestFailureMessage}</InlineError>
      )}
    </>
  );
}

export function InsightsSlot({
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
  readonly onAddFinding?: (finding: AnalysisFinding) => Promise<void>;
  readonly onFinishWithAnalysisSummary?: (summary: string) => void;
}): React.JSX.Element {
  const [selectedInsight, setSelectedInsight] = useState<InsightSelection>(
    initialDetail ?? "analysis",
  );
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
    initialDetail,
    selectedInsight,
    onWorkbenchReplace,
    onWorkbenchPatch,
  });
  const { catalog, provider, models, catalogError } = configuration;
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
  const hasAvailableProvider =
    catalog?.providers.some((candidate) => candidate.available) ?? false;
  const runEnabled =
    !catalogError && hasAvailableProvider && workbench.review.status === "open";
  const selectedProjection =
    selectedInsight === "overview" ? undefined : projections[selectedInsight];
  const insightResultRef = useInsightResultEntrance({
    retainedRunIds: {
      analysis: workbench.insights.analysis.retained?.runId,
      brief: brief.retained?.runId,
      walkthrough: workbench.insights.walkthrough.retained?.runId,
    },
    selectedInsight,
    selectedProjectionStatus: selectedProjection?.status,
  });
  const selectedRunning =
    selectedInsight === "overview" ? undefined : runs[selectedInsight];
  const retainedDescription =
    selectedInsight === "analysis"
      ? workbench.insights.analysis.retained?.value.summary
      : selectedInsight === "walkthrough"
        ? workbench.insights.walkthrough.retained?.value.focus
        : (brief.retained?.value.flow?.trees[0]?.title ??
          brief.retained?.value.startHere?.lead);
  const currentRevision =
    workbench.revision.currentHeadSha ?? workbench.revision.reviewedHeadSha;
  const retainedReader = buildInsightReaders({
    workbench,
    selectedInsight,
    profileId,
    reviewId,
    ...definedProps({
      onFinishWithAnalysisSummary,
      addFinding: onAddFinding,
    }),
    dismissFinding,
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
  const selectedInsightName =
    selectedInsight === "overview" ? "Insight" : INSIGHT_NOUNS[selectedInsight];
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
              brief={brief}
              analysis={workbench.insights.analysis}
              walkthrough={workbench.insights.walkthrough}
              scope={workbench.scope}
              onSelect={setSelectedInsight}
            />
          ) : (
            <>
              {walkthroughFocusActive ? null : (
                <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b pb-2">
                  <InsightDocumentIdentity
                    retained={selectedRetained}
                    selectedInsight={selectedInsight}
                    selectedIsOutdated={selectedIsOutdated}
                    currentRevision={currentRevision}
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
              <InsightAvailabilityErrors
                catalogError={catalogError}
                hasAvailableProvider={hasAvailableProvider}
                provider={provider}
                modelCount={models.length}
                requestFailureMessage={selectedRequestFailureMessage}
              />
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
            </>
          )}
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
