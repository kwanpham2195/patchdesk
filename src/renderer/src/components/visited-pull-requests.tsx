import { Fragment, useEffect, useState } from "react";

import { requestJson } from "@/api-client";
import {
  formatCompactRelativeTime,
  formatExactTime,
} from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  parseSidebarReviewsResponse,
  type SidebarReviewRow,
} from "@/renderer-contracts";
import type { AppDestination } from "@/routes";

type ListState =
  | { readonly kind: "idle" }
  | { readonly kind: "loaded"; readonly rows: ReadonlyArray<SidebarReviewRow> }
  | { readonly kind: "failed" };

/**
 * The pull requests the maintainer has opened in the active workspace, listed
 * in the order `GET /v1/sidebar/reviews` returns them.
 *
 * The route reads local Review records only, so this reaches GitHub for
 * nothing. It is also not polled: the list is re-read when the workspace
 * changes or `reloadKey` moves, and never on a timer (ADR 0032).
 */
export function VisitedPullRequests({
  profileId,
  destination,
  onNavigate,
  reloadKey,
  workspaceLabel,
}: {
  /** Empty while a workspace switch is in flight, which draws the frame alone. */
  readonly profileId: string;
  readonly destination: AppDestination;
  readonly onNavigate: (destination: AppDestination) => void;
  /** Moves on every Review open, so a just-opened pull request appears without a relaunch. */
  readonly reloadKey: number;
  /** The active workspace's label for the header strip; undefined while a switch is in flight. */
  readonly workspaceLabel: string | undefined;
}): React.JSX.Element {
  const [state, setState] = useState<ListState>({ kind: "idle" });

  useEffect(() => {
    if (profileId === "") {
      setState({ kind: "idle" });
      return;
    }
    let active = true;
    void (async () => {
      try {
        const value = await requestJson(
          `/v1/sidebar/reviews?profileId=${encodeURIComponent(profileId)}`,
        );
        // A superseded request must not overwrite the one that replaced it.
        if (!active) return;
        const parsed = parseSidebarReviewsResponse(value);
        setState(
          parsed === undefined
            ? { kind: "failed" }
            : { kind: "loaded", rows: parsed.rows },
        );
      } catch {
        if (active) setState({ kind: "failed" });
      }
    })();
    return () => {
      active = false;
    };
  }, [profileId, reloadKey]);

  const openReviewId =
    destination.kind === "workbench" ? destination.reviewId : undefined;
  // The scope is over the rows on screen rather than the watchlist, so a column
  // listing one repository labels its rows bare even when the workspace watches
  // several: the label is there to tell apart what is visible.
  const scope: VisitedLabelScope =
    state.kind === "loaded" ? visitedLabelScope(state.rows) : "number";

  return (
    <aside
      id="visited-pull-requests"
      aria-label="Pull requests you have opened"
      className="mr-1 flex w-[252px] shrink-0 flex-col overflow-hidden rounded-t-lg border border-b-0 bg-card"
    >
      {/* The strip keeps its height with no label so the list does not jump
       * up while a workspace switch is in flight. */}
      <div className="flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b px-2.5 py-2">
        <span
          className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-tight uppercase"
          title={workspaceLabel}
        >
          {workspaceLabel}
        </span>
        {/* Names the order the list is in and the cap it stops at
         * (`SIDEBAR_ROW_LIMIT`), which is otherwise silent. */}
        <span className="shrink-0 text-[11px] text-muted-foreground">
          recent
        </span>
      </div>
      {/* The shared ScrollArea draws a zero-width thumb here, so the native
       * bar is styled down instead: thin, rounded, low contrast. */}
      <div className="min-h-0 flex-1 overflow-y-auto pt-3 pb-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/25 hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/45">
        {state.kind === "failed" ? (
          <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
            Patchdesk could not read the pull requests you have opened.
          </p>
        ) : null}
        {state.kind === "loaded" && state.rows.length === 0 ? (
          <div className="px-2.5 py-2 text-[12px] text-muted-foreground">
            <p>You have not opened a pull request yet.</p>
            <p className="mt-1">
              Open one from Pull requests and it appears here.
            </p>
          </div>
        ) : null}
        {state.kind === "loaded"
          ? withDateHeaders(state.rows, Date.now()).map(({ row, heading }) => (
              <Fragment key={row.reviewId}>
                {heading === undefined ? null : (
                  // The list already pads its own top, so the first header
                  // does not stack a second gap above it.
                  <p className="px-2.5 pt-3 pb-0.5 text-[10px] font-semibold tracking-widest text-muted-foreground/80 uppercase first:pt-0">
                    {heading}
                  </p>
                )}
                <VisitedRow
                  row={row}
                  selected={row.reviewId === openReviewId}
                  scope={scope}
                  onOpen={() =>
                    onNavigate({ kind: "workbench", reviewId: row.reviewId })
                  }
                />
              </Fragment>
            ))
          : null}
      </div>
    </aside>
  );
}

/**
 * How much of `owner/repo` a row spells out. The owner is never shown without
 * the repository, so the three settings are one value rather than two
 * booleans that could be combined into a label nobody wants.
 */
type VisitedLabelScope = "number" | "repo" | "owner-repo";

/**
 * The narrowest label that still tells the listed rows apart: the repository is
 * named only when the rows span more than one, and its owner only when they
 * span more than one owner. In a workspace whose rows all sit under one owner
 * the owner is roughly half the width of `centraldigital/cfw-sales-crm-api#98`
 * and distinguishes nothing, which pushed the age off the meta line.
 */
function visitedLabelScope(
  rows: ReadonlyArray<Pick<SidebarReviewRow, "owner" | "repo">>,
): VisitedLabelScope {
  const repositories = new Set(rows.map((row) => `${row.owner}/${row.repo}`));
  if (repositories.size <= 1) return "number";
  return new Set(rows.map((row) => row.owner)).size > 1 ? "owner-repo" : "repo";
}

type VisitedListEntry = {
  readonly row: SidebarReviewRow;
  /** The header this row is drawn under, set only on the row that opens a bucket. */
  readonly heading: string | undefined;
};

/**
 * Marks the row that opens each date bucket, in the order the route returned
 * the rows: nothing is sorted or dropped, and a bucket holding no row is never
 * named.
 */
function withDateHeaders(
  rows: ReadonlyArray<SidebarReviewRow>,
  now: number,
): ReadonlyArray<VisitedListEntry> {
  let previous: string | undefined;
  return rows.map((row) => {
    const label = visitedDateGroupLabel(row.openedAt, now);
    const heading = label === previous ? undefined : label;
    previous = label;
    return { row, heading };
  });
}

const DAY_MS = 86_400_000;

/**
 * The date bucket a visited row falls in. The cuts are calendar days, not
 * elapsed hours, so a pull request opened this morning reads Today whatever
 * the hour; an unreadable stamp falls to the oldest bucket rather than
 * claiming a day.
 */
// oxlint-disable-next-line react/only-export-components -- Shared grouping rule, tested as a function in tests/renderer/visited-pull-requests.ui.test.tsx.
export function visitedDateGroupLabel(
  openedAt: string,
  now: number = Date.now(),
): string {
  const days = localDayIndex(now) - localDayIndex(Date.parse(openedAt));
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  return "Earlier";
}

/** Which local calendar day an instant lands on, counted from the epoch. */
function localDayIndex(at: number): number {
  const day = new Date(at);
  return Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / DAY_MS;
}

function VisitedRow({
  row,
  selected,
  scope,
  onOpen,
}: {
  readonly row: SidebarReviewRow;
  readonly selected: boolean;
  readonly scope: VisitedLabelScope;
  readonly onOpen: () => void;
}): React.JSX.Element {
  const { title, reference } = visitedRowLabels(row, scope);
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      aria-disabled={selected ? true : undefined}
      title={title}
      // The row already showing is where navigation would land, so it does nothing.
      onClick={selected ? undefined : onOpen}
      className={cn(
        "ui-state-transition relative flex w-full min-w-0 items-start py-1.5 pr-3 pl-2.5 text-left outline-none",
        "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected && "bg-primary/10",
      )}
    >
      {selected ? (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate text-[13px] leading-snug font-medium">
          {title}
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-[11px] text-muted-foreground">
          {/* The age is computed once per render; nothing ticks it. */}
          <span className="min-w-0 truncate tabular-nums">
            {reference}
            <time dateTime={row.openedAt} title={formatExactTime(row.openedAt)}>
              {formatCompactRelativeTime(row.openedAt)}
            </time>
          </span>
          {row.terminal === undefined ? null : (
            <TerminalMarker terminal={row.terminal} />
          )}
        </span>
      </span>
    </button>
  );
}

/**
 * What a pull request that is no longer open reads as. The state is dated,
 * because the row is drawn from a stored observation and never from a live
 * GitHub read: an undated marker would look current when it is not.
 */
function TerminalMarker({
  terminal,
}: {
  readonly terminal: NonNullable<SidebarReviewRow["terminal"]>;
}): React.JSX.Element {
  const { label, tone } = visitedTerminalMarker(terminal);
  return (
    <time
      dateTime={terminal.observedAt}
      title={formatExactTime(terminal.observedAt)}
      className={cn("ml-auto shrink-0 text-[10px] font-medium", tone)}
    >
      {label}
    </time>
  );
}

/** The text colour that tells the state apart at a glance. */
type VisitedTerminalTone = "text-status-info" | "text-destructive";

type VisitedTerminalMarker = {
  readonly label: string;
  readonly tone: VisitedTerminalTone;
};

/**
 * The marker a closed or merged row carries, and its tone. Merged is the
 * ordinary end of a review, so it takes the informational blue; closed ended
 * without the change landing, so it takes the destructive red. "seen" is the
 * whole claim: three of the four writers of `observedAt` stamp Patchdesk's own
 * clock beside the GitHub read, so the age is when Patchdesk saw the state,
 * not when GitHub reached it.
 */
// oxlint-disable-next-line react/only-export-components -- Shared state-marker rule, tested as a function in tests/renderer/visited-pull-requests.ui.test.tsx.
export function visitedTerminalMarker(
  terminal: NonNullable<SidebarReviewRow["terminal"]>,
  now: number = Date.now(),
): VisitedTerminalMarker {
  const seen = `seen ${formatCompactRelativeTime(terminal.observedAt, now)}`;
  return terminal.state === "merged"
    ? { label: `Merged · ${seen}`, tone: "text-status-info" }
    : { label: `Closed · ${seen}`, tone: "text-destructive" };
}

type VisitedRowLabels = {
  readonly title: string;
  readonly reference: string;
};

/**
 * The label a visited row shows and the reference printed under it. A Review
 * opened before the route stored titles has none, so its reference becomes the
 * label; printing the reference again underneath would repeat the number, so
 * that row leaves the age standing alone.
 */
// oxlint-disable-next-line react/only-export-components -- Shared row-label rule, tested as a function in tests/renderer/visited-pull-requests.ui.test.tsx.
export function visitedRowLabels(
  row: Pick<SidebarReviewRow, "title" | "owner" | "repo" | "number">,
  scope: VisitedLabelScope,
): VisitedRowLabels {
  const repository = visitedRepositoryLabel(row, scope);
  if (row.title === undefined)
    return { title: `${repository}#${row.number}`, reference: "" };
  return {
    title: row.title,
    reference: `${repository}#${row.number} · `,
  };
}

/** The repository part of a row's label, empty when the scope names none. */
function visitedRepositoryLabel(
  row: Pick<SidebarReviewRow, "owner" | "repo">,
  scope: VisitedLabelScope,
): string {
  if (scope === "number") return "";
  return scope === "owner-repo" ? `${row.owner}/${row.repo}` : row.repo;
}
