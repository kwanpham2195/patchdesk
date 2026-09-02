import { ArrowRight, CircleAlert } from "lucide-react";

import type { InboxRow } from "@/renderer-contracts";
import type { InboxDataFreshness } from "../../../domain/maintainer-inbox";
import {
  inspectorReviewStatus,
  type InspectorReviewStatus,
  type InspectorReviewStatusKind,
} from "@/inspector-review-status";
import { LabelChip } from "./label-chip";
import { CheckIcon } from "./inbox-row-item";
import { ScopeGauge } from "./scope-gauge";
import {
  ReviewOpeningButtonContent,
  type ReviewOpeningState,
} from "./review-opening-status";
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
            <span className="truncate">{row.checks.overall}</span>
          </dd>
        </div>
        <Fact label="Changes" value={changeStatsText(row.changeStats)} mono />
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
      </dl>
      {freshness === "cached" ? (
        <Card className="gap-1.5 border-amber-500/30 bg-amber-500/5 py-2.5">
          <CardContent className="flex gap-2 px-2.5 text-[11px] leading-4 text-muted-foreground">
            <CircleAlert className="size-3.5 shrink-0 text-amber-500" />
            GitHub data is cached.
          </CardContent>
        </Card>
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

/** Emerald matches the row's live glyph; amber matches the stale-data badge. */
const STATUS_DOT_FILLS = {
  merged: "bg-primary",
  not_reviewed: "bg-muted-foreground",
  current: "bg-emerald-700 dark:bg-emerald-400",
  updates_available: "bg-amber-600 dark:bg-amber-400",
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
        "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 px-2.5 py-2.5",
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

function Fact({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <FactLabel>{label}</FactLabel>
      <dd
        className={cn(
          "mt-0.5 text-[12px]",
          // The change counts are the one fact worth two lines: the column is
          // narrow enough to clip "-30" off the end, and a clipped count reads
          // as a smaller diff rather than as a truncation.
          mono
            ? "font-mono text-[11px] tabular-nums [overflow-wrap:anywhere]"
            : "truncate",
        )}
        title={value}
      >
        {value}
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

function changeStatsText(stats: InboxRow["changeStats"]): string {
  const { additions, deletions, changedFiles } = stats;
  const parts = [
    changedFiles === undefined ? undefined : `${changedFiles} files`,
    additions === undefined ? undefined : `+${additions}`,
    deletions === undefined ? undefined : `-${deletions}`,
  ].filter((value): value is string => value !== undefined);
  return parts.length === 0 ? "Not available" : parts.join(" · ");
}
