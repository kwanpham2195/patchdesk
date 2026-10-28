import { useEffect, useState } from "react";
import { CODEX_EXPLANATION_VERSION_MESSAGE } from "#src/domain/codex-explanation-version";
import { EXPLANATION_FAILURE_DETAILS } from "#src/domain/insight-failure-diagnostic";

import { History, Pause, Play, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { Spinner } from "./ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import type { InsightFailureCategory } from "#src/domain/insight-record";
import type { GuideSummary } from "#src/domain/guide-progress";
import {
  NOT_GENERATED_BRIEF,
  type BriefInsight,
} from "#src/renderer/src/brief-contracts";
import { INSIGHT_NOUNS, type InsightRunDialogType } from "./insight-run-dialog";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import type { InsightRunActivity } from "#src/renderer/src/insight-contracts";
import type { InsightRunController } from "#src/renderer/src/hooks/use-insight-run";
import { CopyLoadedTextButton } from "./copy-loaded-text-button";
import { loadInsightFailureDiagnostics } from "./insight-failure-diagnostics";
import { RelativeTime } from "./relative-time";
import type { NativeSessionAttemptPage } from "#src/domain/native-session-attempt";
import { InsightAttemptDetails } from "./insight-attempt-details";
import { INSIGHT_STATUS_LABELS } from "#src/renderer/src/insight-status";
import { INSIGHT_ICONS } from "#src/renderer/src/insight-icons";
import { InsightStatusIcon } from "./insight-status-icon";
import { cn } from "@/lib/utils";

export type InsightProjection =
  | WorkbenchResponse["insights"]["analysis"]
  | WorkbenchResponse["insights"]["walkthrough"]
  | BriefInsight
  | NonNullable<WorkbenchResponse["insights"]["guide"]>;
/** Each type's call to action when nothing has been generated for this revision. */
const GENERATE_LABELS = {
  analysis: "Generate analysis",
  walkthrough: "Generate walkthrough",
  brief: "Generate brief",
  guide: "Generate Guide",
} as const satisfies Record<InsightRunDialogType, string>;
/** What each Insight gives the reviewer, shown before one has been generated. */
const INSIGHT_PURPOSES = {
  analysis: "Findings and a merge verdict.",
  walkthrough: "Chapter-by-chapter read of the change.",
  brief: "Structure and where to start.",
  guide: "Ordered behavior groups with their supporting files.",
} as const satisfies Record<InsightRunDialogType, string>;
/** Not run reads dimmer than a tab with a result, selected or not. */
const NOT_RUN_TAB_CLASS =
  "text-foreground/40 data-active:text-foreground/70 dark:text-muted-foreground/60 dark:data-active:text-foreground/70";
const INSIGHT_STATE_CLASS = "mx-auto max-w-2xl border py-10";
const INSIGHT_EMPTY_CLASS = "mx-auto max-w-2xl justify-start py-10";

export function InsightNavRail({
  workbench,
  selectedInsight,
  setSelectedInsight,
  runs,
  onRunInsights,
  runInsightsDisabled = false,
  trailing,
  guideStatus,
  walkthroughStatus,
}: {
  readonly workbench: WorkbenchResponse;
  readonly selectedInsight: InsightRunDialogType;
  readonly setSelectedInsight: React.Dispatch<
    React.SetStateAction<InsightRunDialogType>
  >;
  /** The controller supplies the accepted run phase between workbench loads. */
  readonly runs: Readonly<
    Record<InsightRunDialogType, Pick<InsightRunController, "runId" | "status">>
  >;
  /** Opens the Run Insights dialog; absent on a merged or closed Review, which can never run one. */
  readonly onRunInsights?: (() => void) | undefined;
  readonly runInsightsDisabled?: boolean;
  /** The selected document's meta line and run action, drawn at the row's right end so the tab strip is the only divider above the content. */
  readonly trailing?: React.ReactNode;
  readonly guideStatus: {
    readonly status: InsightProjection["status"];
    readonly label: string | undefined;
    readonly activeStatus: InsightRunController["status"] | undefined;
  };
  readonly walkthroughStatus?: {
    readonly status: InsightProjection["status"];
    readonly label: string | undefined;
    readonly activeStatus: InsightRunController["status"] | undefined;
  };
}): React.JSX.Element {
  // Reading order: Brief says what changed structurally, Walkthrough how it
  // behaves now, Analysis whether it should merge. The judgment comes last.
  const documents = [
    ["brief", workbench.insights.brief ?? NOT_GENERATED_BRIEF],
    ["guide", workbench.insights.guide],
    ["walkthrough", workbench.insights.walkthrough],
    ["analysis", workbench.insights.analysis],
  ] as const satisfies ReadonlyArray<
    readonly [InsightRunDialogType, InsightProjection]
  >;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b">
      <div className="flex min-w-0 items-center gap-2">
        <nav
          aria-label="Insight navigation"
          className="max-w-full overflow-x-auto overflow-y-hidden"
        >
          <Tabs
            value={selectedInsight}
            onValueChange={(value) =>
              // SAFETY: every TabsTrigger below is keyed by an InsightRunDialogType
              // literal, so Base UI's reported value can only ever be one of those.
              setSelectedInsight(value as InsightRunDialogType)
            }
          >
            <TabsList variant="line" className="pb-1">
              {documents.map(([type, projection]) => (
                <InsightTab
                  key={type}
                  type={type}
                  activeStatus={
                    type === "guide"
                      ? guideStatus.activeStatus
                      : type === "walkthrough" &&
                          walkthroughStatus !== undefined
                        ? walkthroughStatus.activeStatus
                        : runs[type].runId === undefined
                          ? projection.activeRun?.status
                          : runs[type].status
                  }
                  status={
                    type === "guide"
                      ? guideStatus.status
                      : type === "walkthrough" &&
                          walkthroughStatus !== undefined
                        ? walkthroughStatus.status
                        : runs[type].runId === undefined
                          ? projection.status
                          : "running"
                  }
                  {...((type === "guide"
                    ? guideStatus.label
                    : type === "walkthrough"
                      ? walkthroughStatus?.label
                      : undefined) !== undefined
                    ? {
                        statusLabel:
                          (type === "guide"
                            ? guideStatus.label
                            : walkthroughStatus?.label) ?? "",
                      }
                    : {})}
                />
              ))}
            </TabsList>
          </Tabs>
        </nav>
        {onRunInsights === undefined ? null : (
          <Button
            size="sm"
            variant="ghost"
            className="mb-1"
            disabled={runInsightsDisabled}
            onClick={onRunInsights}
          >
            <Play data-icon="inline-start" aria-hidden="true" />
            Run Insights…
          </Button>
        )}
      </div>
      {trailing}
    </div>
  );
}

/** Only Running, Outdated, and Failed draw an icon; the tooltip and accessible name carry the word. */
function InsightTab({
  type,
  status,
  activeStatus,
  statusLabel,
}: {
  readonly activeStatus: InsightRunController["status"] | undefined;
  readonly type: InsightRunDialogType;
  readonly status: InsightProjection["status"];
  readonly statusLabel?: string;
}): React.JSX.Element {
  const noun = INSIGHT_NOUNS[type];
  const label =
    statusLabel ??
    (activeStatus === "queued"
      ? "Preparing"
      : activeStatus === "cancelling"
        ? "Cancelling"
        : INSIGHT_STATUS_LABELS[status]);
  if (label === undefined)
    return <TabsTrigger value={type}>{noun}</TabsTrigger>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <TabsTrigger
            value={type}
            aria-label={`${noun}: ${label}`}
            className={cn(status === "not_generated" && NOT_RUN_TAB_CLASS)}
          />
        }
      >
        {noun}
        {status === "not_generated" ? null : label === "Paused" ? (
          <Pause aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <InsightStatusIcon status={status} />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function InsightRunning({
  type,
  projection,
  activity,
  status,
  onCancel,
  cancelDisabled = false,
  startedAt,
  children,
}: {
  readonly status?: InsightRunController["status"] | undefined;
  readonly type: InsightRunDialogType;
  readonly projection?: InsightProjection | undefined;
  /** Absent for a Pi run, which projects no trace. */
  readonly activity?: InsightRunActivity | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly cancelDisabled?: boolean;
  readonly startedAt?: string | undefined;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  const phase =
    status === undefined || status === "idle"
      ? projection?.activeRun?.status
      : status;
  const start = startedAt ?? projection?.activeRun?.startedAt;
  return (
    <section
      aria-label={`${INSIGHT_NOUNS[type]} run`}
      className="flex shrink-0 flex-col gap-2 rounded-md border p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        {phase === "cancelled" ||
        phase === "completed" ||
        phase === "failed" ? null : (
          <Spinner aria-hidden="true" />
        )}
        <p role="status" className="min-w-0 flex-1">
          {INSIGHT_NOUNS[type]} ·{" "}
          {phase === "queued" ||
          (phase === "running" && activity?.phase === "preparing")
            ? "Preparing"
            : phase === "cancelling"
              ? "Cancelling"
              : phase === "error"
                ? "Status unavailable"
                : phase === "cancelled"
                  ? "Cancelled"
                  : phase === "completed"
                    ? "Completed"
                    : phase === "failed"
                      ? "Failed"
                      : "Running"}
          {start === undefined ? null : (
            <>
              {" "}
              · <InsightElapsedTime startedAt={start} />
            </>
          )}
        </p>
        {onCancel === undefined ||
        phase === "cancelling" ||
        phase === "cancelled" ||
        phase === "completed" ||
        phase === "failed" ? null : (
          <Button
            size="xs"
            variant="outline"
            disabled={cancelDisabled}
            onClick={onCancel}
          >
            Cancel run
          </Button>
        )}
      </div>
      {activity === undefined ? null : (
        <InsightActivityTrace activity={activity} />
      )}
      {children}
    </section>
  );
}

function InsightElapsedTime({
  startedAt,
}: {
  readonly startedAt: string;
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return (
    <time dateTime={startedAt} className="tabular-nums">
      {seconds < 60
        ? `${seconds}s elapsed`
        : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`}
    </time>
  );
}

/** Commands are untrusted model output (#240), so they render as plain text with no mark that implies they were checked. */
function InsightActivityTrace({
  activity,
}: {
  readonly activity: InsightRunActivity;
}): React.JSX.Element | null {
  if (activity.reasoningLine === undefined && activity.commands.length === 0)
    return null;
  return (
    <details className="w-full min-w-0 text-left text-xs">
      <summary className="cursor-pointer">Activity</summary>
      <div className="flex min-w-0 flex-col gap-2 pt-2">
        {activity.reasoningLine === undefined ? null : (
          <p className="truncate text-sm">{activity.reasoningLine}</p>
        )}
        {activity.commands.length === 0 ? null : (
          <ol
            aria-label="Commands"
            className="flex max-h-72 flex-col gap-1 overflow-y-auto font-mono text-xs"
          >
            {activity.commands.map((command) => (
              <li key={command.id} className="flex min-w-0 items-center gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">
                  {command.status === "in_progress" ? (
                    <Spinner aria-label="Running" />
                  ) : command.status === "declined" ? (
                    "declined"
                  ) : command.exitCode === undefined ? (
                    command.status
                  ) : (
                    `exit ${String(command.exitCode)}`
                  )}
                </span>
                <span
                  className="min-w-0 flex-1 truncate"
                  title={command.command}
                >
                  {command.command}
                </span>
                {command.durationMs === undefined ? null : (
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {(command.durationMs / 1000).toFixed(1)}s
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

export function InsightFailed({
  projection,
  onRetry,
  onReprepare,
  guideFailure,
  retainedGeneratedAt,
  retainedHeadSha,
  nativeAttempts,
  detailsSource,
}: {
  readonly projection: InsightProjection;
  /** Absent on a merged or closed Review, where the service refuses a run, so neither Try again nor Re-prepare Review is drawn. */
  readonly onRetry?: () => void;
  readonly onReprepare: () => Promise<WorkbenchResponse>;
  /** New Guide metadata does not require a legacy retained value. */
  readonly guideFailure?: NonNullable<GuideSummary["failure"]>;
  readonly retainedGeneratedAt?: string | undefined;
  readonly retainedHeadSha?: string | undefined;
  readonly nativeAttempts?: NativeSessionAttemptPage | undefined;
  readonly detailsSource?:
    | {
        readonly profileId: string;
        readonly reviewId: string;
        readonly type: InsightRunDialogType;
        readonly runId: string;
      }
    | undefined;
}): React.JSX.Element {
  const failure = guideFailure ?? projection.replacementFailure;
  const category = failure?.category;
  const generatedAt = retainedGeneratedAt ?? projection.retained?.generatedAt;
  const [repreparing, setRepreparing] = useState(false);
  const [reprepareFailed, setReprepareFailed] = useState(false);
  const message = failureMessage(
    category,
    guideFailure?.diagnostic,
    projection.replacementFailure?.incompleteReason,
  );
  const needsReprepare =
    category === "review_worktree_unavailable" ||
    category === "evidence_unavailable" ||
    category === "evidence_mismatch";
  const runReprepare = async (): Promise<void> => {
    setRepreparing(true);
    setReprepareFailed(false);
    try {
      await onReprepare();
      onRetry?.();
    } catch {
      setReprepareFailed(true);
    } finally {
      setRepreparing(false);
    }
  };
  const interruption = projection.replacementFailure?.reason;
  // A cancelled or superseded run is not a failure, so it keeps its run details instead of the failure line.
  if (interruption === "cancelled" || interruption === "superseded")
    return (
      <Alert>
        <AlertDescription>
          <p>
            {interruption === "cancelled"
              ? "The new run was cancelled."
              : "The new run was superseded by a different Review revision."}{" "}
            {generatedAt === undefined ? "" : "Showing the previous result."}
          </p>
          <details className="text-xs">
            <summary className="cursor-pointer">Run details</summary>
            <InsightAttemptDetails
              key={detailsSource?.runId ?? nativeAttempts?.attempts[0]?.runId}
              page={nativeAttempts}
              source={detailsSource}
            />
          </details>
        </AlertDescription>
      </Alert>
    );
  return (
    <Alert
      variant="warning"
      className="flex w-full min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-2"
    >
      <TriangleAlert aria-hidden="true" className="shrink-0" />
      <AlertDescription className="min-w-48 flex-1">
        {generatedAt === undefined ? (
          message
        ) : (
          <>
            New run failed: {message} Showing the result from{" "}
            <RelativeTime iso={generatedAt} />.
          </>
        )}
        {reprepareFailed ? <p>The Review could not be re-prepared.</p> : null}
      </AlertDescription>
      {onRetry === undefined ? null : (
        <Button
          size="sm"
          disabled={repreparing}
          onClick={needsReprepare ? () => void runReprepare() : onRetry}
        >
          {needsReprepare
            ? repreparing
              ? "Re-preparing Review…"
              : "Re-prepare Review"
            : "Try again"}
        </Button>
      )}
      <CopyLoadedTextButton
        key={failure?.runId}
        label="Copy diagnostics"
        failure="Diagnostics could not be copied. Try again."
        load={() =>
          loadInsightFailureDiagnostics({
            projection,
            retainedHeadSha,
            guideFailure,
            nativeAttempts,
            source: detailsSource,
          })
        }
      />
    </Alert>
  );
}

function failureMessage(
  category: InsightFailureCategory | null | undefined,
  diagnostic?: NonNullable<GuideSummary["failure"]>["diagnostic"],
  incompleteReason?: "insufficient_evidence" | "unable_to_complete",
): string {
  if (diagnostic === "unsupported_codex_version")
    return CODEX_EXPLANATION_VERSION_MESSAGE;
  if (diagnostic === "provider_completed_without_finish")
    return EXPLANATION_FAILURE_DETAILS.provider_completed_without_finish;
  switch (category) {
    case "authentication_required":
      return "The provider needs authentication.";
    case "rate_limited":
      return "Provider rate limit reached.";
    case "runtime_unavailable":
      return "The Insight runtime is unavailable.";
    case "review_worktree_unavailable":
      return "This Review’s local files are unavailable.";
    case "timed_out":
      return "The Insight run timed out.";
    case "guide_patch_empty":
      return "The represented patch has no changes this Insight can index.";
    case "guide_artifact_unreadable":
      return "This Insight could not read the represented Review evidence.";
    case "guide_input_too_large":
      return "The represented Review input exceeds this Insight's supported size.";
    case "execution_failed":
      return "The provider refused or failed this run.";
    case "invalid_result":
      return "The provider answered with a result this app could not read.";
    case "analysis_incomplete":
      return incompleteReason === "insufficient_evidence"
        ? "The model reported insufficient evidence for a complete Analysis."
        : incompleteReason === "unable_to_complete"
          ? "The model reported that it was unable to complete this Analysis."
          : "The provider could not complete this Analysis.";
    case "evidence_unavailable":
      return "Captured evidence is unavailable. Re-prepare the Review before trying again.";
    case "evidence_mismatch":
      return "Captured evidence no longer matches this run. Re-prepare the Review before trying again.";
    case "unexpected_failure":
      return "The Insight failed unexpectedly.";
    default:
      return "This Insight run failed.";
  }
}

export function InsightOutdated({
  type,
  onRetry,
  retainedRevision,
  currentRevision,
}: {
  readonly type: InsightRunDialogType;
  /** Absent on a merged or closed Review, where the service refuses a run. */
  readonly onRetry?: () => void;
  readonly retainedRevision?: string;
  readonly currentRevision: string;
}): React.JSX.Element {
  return (
    <Empty className={INSIGHT_STATE_CLASS}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <History />
        </EmptyMedia>
        <EmptyTitle>{INSIGHT_NOUNS[type]} is outdated</EmptyTitle>
        <EmptyDescription>
          Retained at {retainedRevision?.slice(0, 8) ?? "unknown"}; current is{" "}
          {currentRevision.slice(0, 8)}. Rerun to navigate current code.
        </EmptyDescription>
      </EmptyHeader>
      {onRetry === undefined ? null : (
        <EmptyContent>
          <Button size="sm" onClick={onRetry}>
            Run for latest revision
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

export function InsightArtifactMismatch(): React.JSX.Element {
  return (
    <Alert variant="warning" className="px-3 py-2">
      <AlertDescription>
        Source no longer matches this revision; hunk navigation is unavailable.
      </AlertDescription>
    </Alert>
  );
}

export function InsightEmpty({
  type,
  onRun,
  disabled,
}: {
  readonly type: InsightRunDialogType;
  /** Absent on a merged or closed Review, which can never run one, so no Generate button is drawn. */
  readonly onRun?: () => void;
  readonly disabled: boolean;
}): React.JSX.Element {
  const Icon = INSIGHT_ICONS[type];
  return (
    <Empty className={INSIGHT_EMPTY_CLASS}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>No {INSIGHT_NOUNS[type].toLowerCase()} yet</EmptyTitle>
        <EmptyDescription>{INSIGHT_PURPOSES[type]}</EmptyDescription>
      </EmptyHeader>
      {onRun === undefined ? null : (
        <EmptyContent>
          <Button size="sm" onClick={onRun} disabled={disabled}>
            {GENERATE_LABELS[type]}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}
