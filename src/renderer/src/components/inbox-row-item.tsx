import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  CircleSlash,
  Clock3,
  GitPullRequest,
} from "lucide-react";

import { inboxIdentityKey, type InboxRow } from "@/renderer-contracts";
import { LabelChip } from "./label-chip";
import {
  ReviewOpeningNotice,
  type ReviewOpeningState,
} from "./review-opening-status";
import { ScopeGauge } from "./scope-gauge";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function InboxRowItem({
  row,
  selected,
  onSelect,
  onAction,
  openingState,
}: {
  readonly row: InboxRow;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onAction: () => void;
  readonly openingState: ReviewOpeningState;
}): React.JSX.Element {
  const key = inboxIdentityKey(row);
  const opening = openingState?.status === "opening";
  return (
    // A plain element, not a `<button>`: an `option`'s descendants are
    // presentational under ARIA, so the row cannot hold a nested control and
    // the title below is styled text the row's own click handler reads.
    // `aria-disabled` stands in for the `disabled` attribute a div cannot
    // carry.
    <div
      id={`inbox-row-${key}`}
      role="option"
      aria-selected={selected}
      aria-disabled={opening}
      // Roving tabindex: only the selected option sits in the Tab order,
      // the way a native `<select>`'s options do. Arrow keys move both the
      // selection and real DOM focus (see `onListKeyDown` in
      // `use-inbox-view.ts`); Tab never has to step through every row.
      tabIndex={selected ? 0 : -1}
      onClick={(event) => {
        onSelect();
        if (!opening && clickedTitle(event.target)) onAction();
      }}
      onDoubleClick={() => {
        if (!opening) onAction();
      }}
      className={cn(
        "block w-full content-auto border-l-2 border-transparent px-3 py-2 text-left transition-colors [contain-intrinsic-size:auto_60px] hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "border-l-primary bg-primary/8",
        opening && "opacity-60",
      )}
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 min-[1280px]:grid-cols-[minmax(10rem,1fr)_8rem_6rem_8rem_1.75rem_2.75rem]">
        <div className="flex min-w-0 items-start gap-2">
          <GitPullRequest
            className={cn("mt-0.5 size-3.5 shrink-0", pullRequestIconTone(row))}
          />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                data-slot="pull-request-title"
                className="min-w-0 line-clamp-2 cursor-pointer text-[13px] leading-5 font-medium hover:text-primary hover:underline"
                title={`Open #${row.identity.number}`}
              >
                #{row.identity.number} {row.title}
              </span>
              {row.isDraft ? (
                <Badge variant="outline" className="h-4 px-1 text-[10px]">
                  Draft
                </Badge>
              ) : null}
              {row.remoteState === "merged" ? (
                <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                  Merged
                </Badge>
              ) : null}
              {row.briefReady === true ? (
                <Badge variant="outline" className="h-4 px-1 text-[10px]">
                  Brief
                </Badge>
              ) : null}
            </div>
            <PullRequestLabelColumn
              labels={row.labels}
              className="mt-1 min-[1280px]:hidden"
              slot="pull-request-labels-mobile"
            />
          </div>
        </div>
        <PullRequestLabelColumn
          labels={row.labels}
          className="hidden min-[1280px]:flex"
          slot="pull-request-label-column"
        />
        <span
          className="hidden truncate text-[11px] text-muted-foreground min-[1280px]:block"
          title={row.author}
        >
          {row.author}
        </span>
        <span className="hidden min-[1280px]:block">
          <ChangeSize stats={row.changeStats} />
          {row.scope === undefined ? null : (
            <ScopeGauge scope={row.scope} size="bar" className="mt-0.5 flex" />
          )}
        </span>
        <span className="hidden min-[1280px]:block">
          <CheckIcon overall={row.checks.overall} />
        </span>
        <span className="text-right text-[11px] leading-5 text-muted-foreground">
          {relativeTime(row.updatedAt)}
        </span>
        <div className="col-span-2 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground min-[1280px]:hidden">
          <CheckIcon overall={row.checks.overall} />
          <span className="truncate">{row.author}</span>
          <ChangeSize stats={row.changeStats} />
        </div>
        <ReviewOpeningNotice
          state={openingState}
          className={
            opening
              ? "col-span-full flex items-center gap-1.5 text-xs text-muted-foreground"
              : "col-span-full text-xs text-destructive"
          }
        />
      </div>
    </div>
  );
}

/** Whether a row click landed on the title, the one part of the row that opens. */
function clickedTitle(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-slot="pull-request-title"]') !== null
  );
}

/** Same emerald pair `CheckIcon` uses, so "live" reads the same across the row. */
function pullRequestIconTone(row: InboxRow): string {
  if (row.remoteState === "merged") return "text-primary";
  if (row.isDraft) return "text-muted-foreground";
  return "text-emerald-700 dark:text-emerald-400";
}

function PullRequestLabelColumn({
  labels,
  className,
  slot,
}: {
  readonly labels: InboxRow["labels"];
  readonly className: string;
  readonly slot: "pull-request-label-column" | "pull-request-labels-mobile";
}): React.JSX.Element {
  return (
    <div
      data-slot={slot}
      className={cn("min-w-0 flex-col items-start gap-1", className)}
    >
      {labels.map((label) => (
        <LabelChip key={label.name} label={label} />
      ))}
    </div>
  );
}

/** The row's check glyph, shared with the inspector's Checks fact so one
 * aggregate check status reads the same in both places. */
export function CheckIcon({
  overall,
}: {
  readonly overall: InboxRow["checks"]["overall"];
}): React.JSX.Element {
  const icon =
    overall === "passing" ? (
      <CheckCircle2 className="size-3.5 text-emerald-700 dark:text-emerald-400" />
    ) : overall === "failing" ? (
      <CircleAlert className="size-3.5 text-rose-700 dark:text-rose-400" />
    ) : overall === "pending" ? (
      <Clock3 className="size-3.5 text-muted-foreground" />
    ) : overall === "skipped" ? (
      <CircleSlash className="size-3.5 text-muted-foreground" />
    ) : (
      <CircleDashed className="size-3.5 text-muted-foreground" />
    );
  return (
    <span className="inline-flex items-center" title={`Checks ${overall}`}>
      {icon}
    </span>
  );
}

/** Change size with the workbench diff colors, so scale reads before the title does. */
function ChangeSize({
  stats,
}: {
  readonly stats: InboxRow["changeStats"];
}): React.JSX.Element {
  const { additions, deletions, changedFiles } = stats;
  if (
    additions === undefined &&
    deletions === undefined &&
    changedFiles === undefined
  )
    return <span className="text-[11px] text-muted-foreground">—</span>;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] tabular-nums"
      title={changeStatsText(stats)}
    >
      {changedFiles === undefined ? null : (
        <span className="text-muted-foreground">
          {changedFiles} {changedFiles === 1 ? "file" : "files"}
        </span>
      )}
      {additions === undefined ? null : (
        <span className="text-emerald-700 dark:text-emerald-400">
          +{compactCount(additions)}
        </span>
      )}
      {deletions === undefined ? null : (
        <span className="text-rose-700 dark:text-rose-400">
          -{compactCount(deletions)}
        </span>
      )}
    </span>
  );
}

/** Keeps large line counts inside the column; the title attribute carries the exact value. */
function changeStatsText(stats: InboxRow["changeStats"]): string {
  const { additions, deletions, changedFiles } = stats;
  const parts = [
    changedFiles === undefined ? undefined : `${changedFiles} files`,
    additions === undefined ? undefined : `+${additions}`,
    deletions === undefined ? undefined : `-${deletions}`,
  ].filter((value): value is string => value !== undefined);
  return parts.length === 0 ? "Not available" : parts.join(" · ");
}

function compactCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}k`;
  return `${Math.round(value / 100_000) / 10}M`;
}
function relativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1_440)}d`;
}
