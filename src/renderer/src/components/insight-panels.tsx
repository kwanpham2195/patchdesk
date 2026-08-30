import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { ScopeGauge } from "./scope-gauge";
import { Spinner } from "./ui/spinner";
import type { InsightFailureCategory } from "../../../domain/insight-record";
import { NOT_GENERATED_BRIEF, type BriefInsight } from "../brief-contracts";
import { INSIGHT_NOUNS, type InsightRunDialogType } from "./insight-run-dialog";
import type { WorkbenchResponse } from "../renderer-contracts";

export type InsightSelection = "overview" | InsightRunDialogType;
export type InsightProjection =
  | WorkbenchResponse["insights"]["analysis"]
  | WorkbenchResponse["insights"]["walkthrough"]
  | BriefInsight;
/** Each type's call to action when nothing has been generated for this revision. */
const GENERATE_LABELS = {
  analysis: "Generate analysis",
  walkthrough: "Generate Walkthrough",
  brief: "Generate brief",
} as const satisfies Record<InsightRunDialogType, string>;

export function InsightNavRail({
  workbench,
  selectedInsight,
  setSelectedInsight,
}: {
  readonly workbench: WorkbenchResponse;
  readonly selectedInsight: InsightSelection;
  readonly setSelectedInsight: React.Dispatch<
    React.SetStateAction<InsightSelection>
  >;
}): React.JSX.Element {
  // Brief first: it is the shortest read and the one that says what the pull
  // request is for, so it comes before the two documents that judge or explain
  // it. Overview stays leftmost as the landing selection.
  const documents = [
    ["brief", workbench.insights.brief ?? NOT_GENERATED_BRIEF],
    ["analysis", workbench.insights.analysis],
    ["walkthrough", workbench.insights.walkthrough],
  ] as const satisfies ReadonlyArray<
    readonly [InsightRunDialogType, InsightProjection]
  >;
  return (
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
      {documents.map(([type, projection]) => (
        <InsightRailButton
          key={type}
          selected={selectedInsight === type}
          onClick={() => setSelectedInsight(type)}
          title={INSIGHT_NOUNS[type]}
          status={insightStatusLabel(projection.status)}
          {...(projection.retained === undefined
            ? {}
            : { revision: projection.retained.headSha })}
        />
      ))}
    </nav>
  );
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

export function InsightOverview({
  analysis,
  walkthrough,
  scope,
  onSelect,
}: {
  readonly analysis: InsightProjection;
  readonly walkthrough: InsightProjection;
  /** Absent when the represented patch bytes were unreadable; see `ReviewWorkbenchProjection.scope`. */
  readonly scope: WorkbenchResponse["scope"];
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
      {scope === undefined ? null : <ScopeGauge scope={scope} size="card" />}
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

export function InsightRunning({
  type,
  projection,
}: {
  readonly type: InsightRunDialogType;
  readonly projection: InsightProjection | undefined;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 py-6">
      <h3 className="font-medium">{INSIGHT_NOUNS[type]} is running</h3>
      <p className="text-sm text-muted-foreground">
        {projection?.activeRun === undefined
          ? "Preparing a bounded run…"
          : `Started ${projection.activeRun.startedAt}. Partial results are not shown.`}
      </p>
      <Spinner />
    </div>
  );
}

export function InsightFailed({
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
    <Alert
      variant="warning"
      className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 px-3 py-4"
    >
      <AlertDescription className="contents">
        <p>{message}</p>
        {projection.retained === undefined ? (
          <p>No retained result is available.</p>
        ) : (
          <p>
            Retained evidence from {projection.retained.headSha.slice(0, 8)} is
            still readable: {retainedDescription ?? "retained document"}
          </p>
        )}
      </AlertDescription>
      <Button size="sm" onClick={onRetry}>
        Try again
      </Button>
    </Alert>
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
      return "The provider refused or failed this run. Check the provider account and the run options, then try again.";
    case "invalid_result":
      return "The provider answered with a result this app could not read. Try again.";
    case "unexpected_failure":
      return "The Insight failed unexpectedly. Try again.";
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
  readonly onRetry: () => void;
  readonly retainedRevision?: string;
  readonly currentRevision: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 py-6">
      <h3 className="font-medium">{INSIGHT_NOUNS[type]} is outdated</h3>
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

export function InsightArtifactMismatch({
  type,
}: {
  readonly type: InsightSelection;
}): React.JSX.Element {
  return (
    <Alert variant="warning" className="px-3 py-2">
      <AlertDescription>
        Stored {type === "overview" ? "Insight" : type} source bytes do not
        match the retained revision. Source scope and hunk navigation are
        unavailable; the bounded document remains readable.
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
        {GENERATE_LABELS[type]}
      </Button>
    </div>
  );
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
