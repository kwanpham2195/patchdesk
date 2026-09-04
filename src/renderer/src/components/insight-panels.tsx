import { FileText, History, Route, SearchIcon } from "lucide-react";

import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { ScopeGauge } from "./scope-gauge";
import { Spinner } from "./ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import type { InsightFailureCategory } from "../../../domain/insight-record";
import { NOT_GENERATED_BRIEF, type BriefInsight } from "../brief-contracts";
import { INSIGHT_NOUNS, type InsightRunDialogType } from "./insight-run-dialog";
import type { WorkbenchResponse } from "../renderer-contracts";
import {
  analysisHeadline,
  type AnalysisFindingStatus,
  type CheckStatus,
} from "../analysis-headline";
import { RelativeTime } from "./relative-time";
import { insightStatusTone } from "../insight-status-tone";

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
/** What each Insight gives the reviewer, shown before one has been generated. */
const INSIGHT_PURPOSES = {
  analysis:
    "Weighs the change and reports findings with evidence so you can decide whether it should merge.",
  walkthrough:
    "Explains how the changed code behaves now, chapter by chapter, so you can read it in order.",
  brief:
    "Maps what changed structurally and where to start, so you can orient before reading the diff.",
} as const satisfies Record<InsightRunDialogType, string>;
const INSIGHT_ICONS = {
  analysis: SearchIcon,
  walkthrough: Route,
  brief: FileText,
} as const satisfies Record<InsightRunDialogType, React.ElementType>;
const INSIGHT_STATE_CLASS = "mx-auto max-w-2xl border py-10";

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
  // Reading order: Brief says what changed structurally, Walkthrough how it
  // behaves now, Analysis whether it should merge. The judgment comes last.
  const documents = [
    ["brief", workbench.insights.brief ?? NOT_GENERATED_BRIEF],
    ["walkthrough", workbench.insights.walkthrough],
    ["analysis", workbench.insights.analysis],
  ] as const satisfies ReadonlyArray<
    readonly [InsightRunDialogType, InsightProjection]
  >;
  return (
    <nav
      aria-label="Insight navigation"
      className="shrink-0 overflow-x-auto border-b"
    >
      <Tabs
        value={selectedInsight}
        onValueChange={(value) =>
          // SAFETY: every TabsTrigger below is keyed by an InsightSelection
          // literal, so Base UI's reported value can only ever be one of those.
          setSelectedInsight(value as InsightSelection)
        }
      >
        <TabsList variant="line" className="pb-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {documents.map(([type, projection]) => (
            <TabsTrigger key={type} value={type}>
              {INSIGHT_NOUNS[type]}
              <InsightStatusBadge status={projection.status} />
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </nav>
  );
}

function InsightStatusBadge({
  status,
}: {
  readonly status: InsightProjection["status"];
}): React.JSX.Element {
  return (
    <Badge
      variant={insightStatusTone(status)}
      className="h-4 px-1.5 text-[10px] font-normal"
    >
      {status === "running" ? <Spinner /> : null}
      {insightStatusLabel(status)}
    </Badge>
  );
}

export function InsightOverview({
  brief,
  analysis,
  walkthrough,
  scope,
  checkStatus,
  findingStatuses,
  onSelect,
}: {
  readonly brief: BriefInsight;
  readonly analysis: WorkbenchResponse["insights"]["analysis"];
  readonly walkthrough: WorkbenchResponse["insights"]["walkthrough"];
  /** Absent when the represented patch bytes were unreadable; see `ReviewWorkbenchProjection.scope`. */
  readonly scope: WorkbenchResponse["scope"];
  readonly checkStatus: CheckStatus;
  readonly findingStatuses:
    | Readonly<Record<string, AnalysisFindingStatus>>
    | undefined;
  readonly onSelect: (value: "brief" | "analysis" | "walkthrough") => void;
}): React.JSX.Element {
  const briefValue = brief.retained?.value;
  const walkthroughValue = walkthrough.retained?.value;
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Insights overview</h2>
      {scope === undefined ? null : <ScopeGauge scope={scope} size="card" />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <InsightOverviewCard
          name="Brief"
          projection={brief}
          // A Brief carries structure, not prose (ADR 0040), so its headline
          // is the Start here lead or, failing that, the first Flow tree.
          headline={
            briefValue?.startHere?.lead ?? briefValue?.flow?.trees[0]?.title
          }
          onSelect={() => onSelect("brief")}
        />
        <InsightOverviewCard
          name="Walkthrough"
          projection={walkthrough}
          headline={
            walkthroughValue === undefined
              ? undefined
              : walkthroughHeadline(walkthroughValue.chapters)
          }
          onSelect={() => onSelect("walkthrough")}
        />
        <InsightOverviewCard
          name="Analysis"
          projection={analysis}
          headline={
            analysis.retained === undefined
              ? undefined
              : analysisHeadline({
                  result: analysis.retained.value,
                  findingStatuses,
                  checkStatus,
                })
          }
          onSelect={() => onSelect("analysis")}
        />
      </div>
    </div>
  );
}

function walkthroughHeadline(
  chapters: ReadonlyArray<{
    readonly sections: ReadonlyArray<unknown>;
  }>,
): string {
  const sections = chapters.reduce(
    (count, chapter) => count + chapter.sections.length,
    0,
  );
  return `${chapters.length} ${chapters.length === 1 ? "chapter" : "chapters"} · ${sections} ${sections === 1 ? "section" : "sections"}`;
}

function InsightOverviewCard({
  name,
  projection,
  headline,
  onSelect,
}: {
  readonly name: string;
  readonly projection: InsightProjection;
  readonly headline: string | undefined;
  readonly onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="rounded-md border p-4 text-left hover:bg-accent"
      onClick={onSelect}
    >
      <p className="font-medium">{name}</p>
      {headline === undefined ? null : (
        <p className="mt-1 line-clamp-2 text-sm">{headline}</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        {insightStatusLabel(projection.status)} ·{" "}
        {projection.retained === undefined ? (
          "No retained result"
        ) : (
          <RelativeTime
            iso={projection.retained.generatedAt}
            prefix="retained "
          />
        )}
      </p>
    </button>
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
    <Empty className={INSIGHT_STATE_CLASS}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Spinner />
        </EmptyMedia>
        <EmptyTitle>{INSIGHT_NOUNS[type]} is running</EmptyTitle>
        <EmptyDescription>
          {projection?.activeRun === undefined
            ? "Preparing a bounded run…"
            : `Started ${projection.activeRun.startedAt}. Partial results are not shown.`}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
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
    <Empty className={INSIGHT_STATE_CLASS}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <History />
        </EmptyMedia>
        <EmptyTitle>{INSIGHT_NOUNS[type]} is outdated</EmptyTitle>
        <EmptyDescription>
          Retained revision {retainedRevision?.slice(0, 8) ?? "unknown"} differs
          from current revision {currentRevision.slice(0, 8)}. This evidence
          remains readable, but it cannot navigate current code or change the
          Review draft.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" onClick={onRetry}>
          Run for latest revision
        </Button>
      </EmptyContent>
    </Empty>
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
  const Icon = INSIGHT_ICONS[type];
  return (
    <Empty className={INSIGHT_STATE_CLASS}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>No {INSIGHT_NOUNS[type].toLowerCase()} yet</EmptyTitle>
        <EmptyDescription>{INSIGHT_PURPOSES[type]}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" onClick={onRun} disabled={disabled}>
          {GENERATE_LABELS[type]}
        </Button>
      </EmptyContent>
    </Empty>
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
