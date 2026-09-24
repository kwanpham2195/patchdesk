import { ArrowRight, CircleAlert } from "lucide-react";

import { checkStatusLabel } from "@/analysis-headline";
import type { InboxRow } from "@/renderer-contracts";
import type {
  InboxDataFreshness,
  InboxInsightKind,
} from "../../../domain/maintainer-inbox";
import {
  inspectorReviewStatus,
  type InspectorReviewStatus,
  type InspectorReviewStatusKind,
} from "@/inspector-review-status";
import { LabelChip } from "./label-chip";
import { inboxRowMergeFact } from "./merge-readiness-items";
import { InsightStatusIcon } from "./insight-status-icon";
import type { InsightStatus } from "@/insight-status";
import { CheckIcon } from "./inbox-row-item";
import { ScopeGauge } from "./scope-gauge";
import { WatchPullRequestButton } from "./watch-pull-request-button";
import {
  ReviewOpeningButtonContent,
  type ReviewOpeningState,
} from "./review-opening-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InlineError } from "@/components/ui/inline-error";
import { cn } from "@/lib/utils";

export function ReviewDetailsInspector({
  row,
  freshness,
  onAction,
  openingState,
}: {
  readonly row?: InboxRow;
  readonly freshness: InboxDataFreshness;
  readonly onAction: () => void | undefined;
  readonly openingState?: Exclude<ReviewOpeningState, undefined>;
}): React.JSX.Element {
  if (row === undefined)
    return (
      <div className="p-3 text-sm text-muted-foreground">
        Select a pull request to inspect its exact review state.
      </div>
    );
  const status = inspectorReviewStatus(row);
  return (
    <div className="space-y-3 p-3">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Review details
        </p>
        <h2 className="mt-1.5 text-[13px] leading-5 font-semibold">
          #{row.identity.number} {row.title}
        </h2>
        <p
          className="mt-0.5 truncate text-[11px] text-muted-foreground"
          title={`${row.identity.owner}/${row.identity.repo}`}
        >
          {row.identity.owner}/{row.identity.repo}
        </p>
      </div>
      <InspectorStatusCard status={status} />
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Fact label="Author" value={row.author} />
        <Fact label="Branch" value={`${row.baseBranch} ← ${row.headBranch}`} />
        <div className="min-w-0">
          <FactLabel>Checks</FactLabel>
          <dd className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px]">
            <CheckIcon overall={row.checks.overall} />
            <span className="truncate">
              {checkStatusLabel(row.checks.overall)}
            </span>
          </dd>
        </div>
        <MergeFact row={row} />
        <ChangesFact stats={row.changeStats} />
        {row.scope === undefined ? null : (
          <div className="col-span-2 min-w-0">
            <FactLabel>Scope</FactLabel>
            <dd className="mt-1">
              <ScopeGauge scope={row.scope} size="legend" />
            </dd>
          </div>
        )}
        {row.labels.length > 0 ? (
          <div className="col-span-2 min-w-0">
            <FactLabel>Labels</FactLabel>
            <dd className="mt-1 flex flex-wrap items-center gap-1">
              {row.labels.map((label) => (
                <LabelChip key={label.name} label={label} />
              ))}
              {row.labelCount !== undefined &&
              row.labelCount > row.labels.length ? (
                <span className="text-[11px] text-muted-foreground">
                  +{row.labelCount - row.labels.length} more
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
        <InsightsFact row={row} />
      </dl>
      {freshness === "cached" ? (
        <Card className="gap-1.5 border-status-warning/30 bg-status-warning/5 py-2.5">
          <CardContent className="flex gap-2 px-2.5 text-[11px] leading-4 text-muted-foreground">
            <CircleAlert className="size-3.5 shrink-0 text-status-warning" />
            GitHub data is cached.
          </CardContent>
        </Card>
      ) : null}
      {row.remoteState === "open" ? (
        <div className="flex flex-wrap items-center gap-2">
          <WatchPullRequestButton
            pullRequest={row.identity}
            className="h-8 w-full text-xs"
          />
        </div>
      ) : null}
      {/* The inspector's one read-only Review entry point; every row state
          opens the same way, so the button says Open rather than naming a
          per-state action. */}
      <Button
        size="sm"
        className="h-8 w-full text-xs"
        onClick={onAction}
        disabled={openingState?.status === "opening"}
      >
        <ReviewOpeningButtonContent state={openingState}>
          <ArrowRight />
          Open
        </ReviewOpeningButtonContent>
      </Button>
      {openingState?.status === "error" ? (
        <InlineError className="text-xs">{openingState.error}</InlineError>
      ) : null}
    </div>
  );
}

/** `--status-success` matches the row's live glyph; `--status-warning` matches the stale-data card. */
const STATUS_DOT_FILLS = {
  merged: "bg-primary",
  not_reviewed: "bg-muted-foreground",
  current: "bg-status-success",
  updates_available: "bg-status-warning",
} satisfies Record<InspectorReviewStatusKind, string>;

function InspectorStatusCard({
  status,
}: {
  readonly status: InspectorReviewStatus;
}): React.JSX.Element {
  return (
    <Card
      role="status"
      aria-label={status.label}
      size="sm"
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 bg-muted px-2.5 py-2.5",
        status.kind === "updates_available" &&
          "border-primary/30 bg-primary/5 ring-primary/30",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          STATUS_DOT_FILLS[status.kind],
        )}
      />
      <span className="text-[12px] font-semibold">{status.label}</span>
      <span className="col-start-2 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
        {status.heads.map((head, index) => (
          <span key={head} className="flex items-center gap-1.5">
            {index === 0 ? null : (
              <span className="text-muted-foreground">→</span>
            )}
            {head}
          </span>
        ))}
      </span>
      <p className="col-start-2 text-[11px] leading-4 text-muted-foreground">
        {status.description}
      </p>
    </Card>
  );
}

/** Copy for a chip whose kind has nothing retained; the row omits the kind rather than saying so. */
const INSIGHT_STATE_LABELS = {
  ready: "Ready",
  outdated: "Outdated",
  failed: "Failed",
  absent: "Not run",
} as const;

/** The shared status icon for each chip state; it takes the separator's place, and a Ready chip shows only its check. */
const INSIGHT_STATE_STATUSES = {
  ready: "current",
  outdated: "outdated",
  failed: "failed",
  absent: "not_generated",
} as const satisfies Record<keyof typeof INSIGHT_STATE_LABELS, InsightStatus>;

/** Retained-but-stale evidence is still readable, so Outdated reads amber and only Failed reads red. */
const INSIGHT_STATE_TONES = {
  ready: "secondary",
  outdated: "warning",
  failed: "destructive",
  absent: "outline",
} as const;

/** The Insight kinds the inspector lists, in the Insights tab order. */
const INSPECTOR_INSIGHTS = [
  { kind: "brief", noun: "Brief" },
  { kind: "walkthrough", noun: "Walkthrough" },
  { kind: "analysis", noun: "Analysis" },
] as const satisfies ReadonlyArray<{
  readonly kind: InboxInsightKind;
  readonly noun: string;
}>;

/** The row's Insight readiness, one read-only chip per kind; runs start from the Review. */
function InsightsFact({ row }: { readonly row: InboxRow }): React.JSX.Element {
  return (
    <div className="col-span-2 min-w-0">
      <FactLabel>Insights</FactLabel>
      <dd className="mt-1">
        <ul className="flex flex-wrap gap-1" aria-label="Insights">
          {INSPECTOR_INSIGHTS.map(({ kind, noun }) => {
            const state = row.insights?.[kind] ?? "absent";
            return (
              <li key={kind}>
                <Badge
                  variant={INSIGHT_STATE_TONES[state]}
                  aria-label={`${noun}: ${INSIGHT_STATE_LABELS[state]}`}
                  className={cn(
                    "h-5 gap-0.5 px-1.5 text-[10px]",
                    state === "absent" && "text-muted-foreground",
                  )}
                >
                  {noun}
                  <InsightStatusIcon status={INSIGHT_STATE_STATUSES[state]} />
                  {state === "ready" ? null : INSIGHT_STATE_LABELS[state]}
                </Badge>
              </li>
            );
          })}
        </ul>
      </dd>
    </div>
  );
}

function Fact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <FactLabel>{label}</FactLabel>
      <dd className="mt-0.5 truncate text-[12px]" title={value}>
        {value}
      </dd>
    </div>
  );
}

/** The Merge fact in PR overview's readiness wording; a blocked row names its first cause and its accessible name lists them all. */
function MergeFact({ row }: { readonly row: InboxRow }): React.JSX.Element {
  const fact = inboxRowMergeFact(row);
  return (
    <div className="min-w-0">
      <FactLabel>Merge</FactLabel>
      <dd
        className={cn("mt-0.5 truncate text-[12px]", fact.tone)}
        aria-label={`Merge: ${fact.accessibleName}`}
        title={fact.text}
      >
        {fact.text}
      </dd>
    </div>
  );
}

/** The change counts, with a zero count muted so "-0" does not read as a removal. */
function ChangesFact({
  stats,
}: {
  readonly stats: InboxRow["changeStats"];
}): React.JSX.Element {
  const { additions, deletions, changedFiles } = stats;
  const parts = [
    changedFiles === undefined
      ? undefined
      : {
          text: `${changedFiles} ${changedFiles === 1 ? "file" : "files"}`,
          zero: false,
        },
    additions === undefined
      ? undefined
      : { text: `+${additions}`, zero: additions === 0 },
    deletions === undefined
      ? undefined
      : { text: `-${deletions}`, zero: deletions === 0 },
  ].filter((part) => part !== undefined);
  const text =
    parts.length === 0
      ? "Not available"
      : parts.map((part) => part.text).join(" · ");
  return (
    <div className="min-w-0">
      <FactLabel>Changes</FactLabel>
      {/* The one fact worth two lines: a clipped "-30" reads as a smaller diff rather than a truncation. */}
      <dd
        className="mt-0.5 font-mono text-[11px] tabular-nums [overflow-wrap:anywhere]"
        title={text}
      >
        {parts.length === 0
          ? text
          : parts.map((part, index) => (
              <span key={part.text}>
                {index === 0 ? null : " · "}
                <span className={cn(part.zero && "text-muted-foreground")}>
                  {part.text}
                </span>
              </span>
            ))}
      </dd>
    </div>
  );
}

function FactLabel({
  children,
}: {
  readonly children: string;
}): React.JSX.Element {
  return (
    <dt className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </dt>
  );
}
