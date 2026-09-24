import { useState } from "react";

import { History } from "lucide-react";

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
import type { InsightFailureCategory } from "../../../domain/insight-record";
import { NOT_GENERATED_BRIEF, type BriefInsight } from "../brief-contracts";
import { INSIGHT_NOUNS, type InsightRunDialogType } from "./insight-run-dialog";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { InsightRunActivity } from "../insight-contracts";
import { RelativeTime } from "./relative-time";
import {
  insightStatusTone,
  type InsightStatusTone,
} from "../insight-status-tone";
import { INSIGHT_ICONS } from "../insight-icons";

export type InsightProjection =
  | WorkbenchResponse["insights"]["analysis"]
  | WorkbenchResponse["insights"]["walkthrough"]
  | BriefInsight;
/** Each type's call to action when nothing has been generated for this revision. */
const GENERATE_LABELS = {
  analysis: "Generate analysis",
  walkthrough: "Generate walkthrough",
  brief: "Generate brief",
} as const satisfies Record<InsightRunDialogType, string>;
/** What each Insight gives the reviewer, shown before one has been generated. */
const INSIGHT_PURPOSES = {
  analysis: "Findings and a merge verdict.",
  walkthrough: "Chapter-by-chapter read of the change.",
  brief: "Structure and where to start.",
} as const satisfies Record<InsightRunDialogType, string>;
/** The rail marks each state with a small dot so the tabs stay quiet; Not generated is a hollow ring. */
const STATUS_DOT_CLASS = {
  success: "bg-status-success",
  warning: "bg-status-warning",
  secondary: "bg-muted-foreground",
  destructive: "bg-destructive",
  outline: "border border-muted-foreground",
} as const satisfies Record<InsightStatusTone, string>;
const INSIGHT_STATE_CLASS = "mx-auto max-w-2xl border py-10";
const INSIGHT_EMPTY_CLASS = "mx-auto max-w-2xl justify-start py-10";

export function InsightNavRail({
  workbench,
  selectedInsight,
  setSelectedInsight,
  trailing,
}: {
  readonly workbench: WorkbenchResponse;
  readonly selectedInsight: InsightRunDialogType;
  readonly setSelectedInsight: React.Dispatch<
    React.SetStateAction<InsightRunDialogType>
  >;
  /** The selected document's meta line and run action, drawn at the row's right end so the tab strip is the only divider above the content. */
  readonly trailing?: React.ReactNode;
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
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b">
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
              <TabsTrigger key={type} value={type}>
                {INSIGHT_NOUNS[type]}
                <InsightStatusMark status={projection.status} />
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </nav>
      {trailing}
    </div>
  );
}

function InsightStatusMark({
  status,
}: {
  readonly status: InsightProjection["status"];
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
      {status === "running" ? (
        <Spinner className="size-3" />
      ) : (
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[insightStatusTone(status)]}`}
        />
      )}
      {insightStatusLabel(status)}
    </span>
  );
}

export function InsightRunning({
  type,
  projection,
  activity,
}: {
  readonly type: InsightRunDialogType;
  readonly projection: InsightProjection | undefined;
  /** Absent for a Pi run, which projects no trace. */
  readonly activity: InsightRunActivity | undefined;
}): React.JSX.Element {
  return (
    <Empty className={INSIGHT_STATE_CLASS}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Spinner />
        </EmptyMedia>
        <EmptyTitle>{INSIGHT_NOUNS[type]} is running</EmptyTitle>
        <EmptyDescription>
          {projection?.activeRun === undefined ||
          activity?.phase === "preparing" ? (
            "Preparing…"
          ) : (
            <RelativeTime
              iso={projection.activeRun.startedAt}
              prefix="Started "
            />
          )}
        </EmptyDescription>
      </EmptyHeader>
      {activity === undefined ? null : (
        <EmptyContent className="max-w-none">
          <InsightActivityTrace activity={activity} />
        </EmptyContent>
      )}
    </Empty>
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
    <div className="flex w-full min-w-0 flex-col gap-2 text-left">
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
              <span className="min-w-0 flex-1 truncate" title={command.command}>
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
  );
}

export function InsightFailed({
  projection,
  onRetry,
  onReprepare,
  retainedDescription,
  activity,
}: {
  readonly projection: InsightProjection;
  readonly onRetry: () => void;
  readonly onReprepare: () => Promise<WorkbenchResponse>;
  readonly retainedDescription?: string;
  /** The trace the run left, so a timed-out run still shows what it was doing. */
  readonly activity?: InsightRunActivity | undefined;
}): React.JSX.Element {
  const failure = projection.replacementFailure;
  const [repreparing, setRepreparing] = useState(false);
  const [reprepareFailed, setReprepareFailed] = useState(false);
  const message =
    failure?.category === undefined
      ? "This Insight run failed."
      : failureMessage(failure.category);
  const reviewWorktreeUnavailable =
    failure?.category === "review_worktree_unavailable";
  const runReprepare = async (): Promise<void> => {
    setRepreparing(true);
    setReprepareFailed(false);
    try {
      await onReprepare();
      onRetry();
    } catch {
      setReprepareFailed(true);
    } finally {
      setRepreparing(false);
    }
  };
  return (
    <Alert
      variant="warning"
      className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-4"
    >
      <AlertDescription className="basis-full space-y-1">
        <p>{message}</p>
        {projection.retained === undefined ? (
          <p>No retained result.</p>
        ) : (
          <p>
            Retained from {projection.retained.headSha.slice(0, 8)}:{" "}
            {retainedDescription ?? "retained document"}
          </p>
        )}
        {reprepareFailed ? <p>The Review could not be re-prepared.</p> : null}
      </AlertDescription>
      <Button
        size="sm"
        disabled={repreparing}
        onClick={
          reviewWorktreeUnavailable ? () => void runReprepare() : onRetry
        }
      >
        {reviewWorktreeUnavailable
          ? repreparing
            ? "Re-preparing Review…"
            : "Re-prepare Review"
          : "Try again"}
      </Button>
      {activity === undefined ? null : (
        <div className="min-w-0 basis-full">
          <InsightActivityTrace activity={activity} />
        </div>
      )}
    </Alert>
  );
}

function failureMessage(category: InsightFailureCategory | undefined): string {
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
    case "execution_failed":
      return "The provider refused or failed this run.";
    case "invalid_result":
      return "The provider answered with a result this app could not read.";
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
          Retained at {retainedRevision?.slice(0, 8) ?? "unknown"}; current is{" "}
          {currentRevision.slice(0, 8)}. Rerun to navigate current code.
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

function insightStatusLabel(status: string): string {
  switch (status) {
    case "not_generated":
      return "Not generated";
    case "running":
      return "Running";
    case "current":
      return "Generated";
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
