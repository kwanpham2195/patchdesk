import { Fragment, useEffect, useRef, useState } from "react";
import { Eye } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { formatExactTime, formatRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { useWatchedPullRequests } from "@/hooks/use-watched-pull-requests";
import type { VisitedPullRequestRows } from "@/hooks/use-visited-pull-request-rows";
import {
  isSidebarLocalRepositoryRow,
  sidebarRowKey,
  sidebarRowShowsReview,
  type SidebarLocalRepositoryRow,
  type SidebarPullRequestRow,
  type SidebarReviewRow,
} from "@/sidebar-contracts";
import type { AppDestination } from "@/routes";

/**
 * Opens the working tree of the branch the repository's checkout is on now
 * (#479), through the local open path, which reads the checkout again.
 */
export type LocalRepositoryOpen = (row: SidebarLocalRepositoryRow) => void;

/**
 * The pull requests and local Reviews the maintainer has opened in the active
 * workspace, drawn from rows `useVisitedPullRequestRows` loads so the Navigate
 * palette can search the same list.
 */
export function VisitedPullRequests({
  state,
  destination,
  onNavigate,
  onOpenLocalReview,
  workspaceLabel,
  host,
}: {
  readonly state: VisitedPullRequestRows;
  readonly destination: AppDestination;
  readonly onNavigate: (destination: AppDestination) => void;
  readonly onOpenLocalReview: LocalRepositoryOpen;
  /** The active workspace's label for the header strip; undefined while a switch is in flight. */
  readonly workspaceLabel: string | undefined;
  /** The workspace's GitHub host; the rows carry none, and a watched mark needs it. */
  readonly host?: string;
}): React.JSX.Element {
  const watch = useWatchedPullRequests();
  const [activeRowKey, setActiveRowKey] = useState<string | undefined>();

  const openReviewId =
    destination.kind === "workbench" ? destination.reviewId : undefined;
  // The scope is over the rows on screen rather than the watchlist, so a column
  // listing one repository labels its rows bare even when the workspace watches
  // several: the label is there to tell apart what is visible.
  const scope: VisitedLabelScope =
    state.kind === "loaded" ? visitedLabelScope(state.rows) : "number";
  const rows = state.kind === "loaded" ? state.rows : [];
  const selectedRow = rows.find((row) =>
    sidebarRowShowsReview(row, openReviewId),
  );
  // Roving tabindex, as on the Pull requests table: the column is one Tab stop.
  const tabStopKey =
    [activeRowKey, selectedRow && sidebarRowKey(selectedRow)].find((key) =>
      rows.some((row) => sidebarRowKey(row) === key),
    ) ??
    (rows[0] && sidebarRowKey(rows[0]));
  const onRowsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = rows.findIndex((row) => sidebarRowKey(row) === tabStopKey);
    const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next === undefined) return;
    setActiveRowKey(sidebarRowKey(next));
    document.getElementById(`visited-row-${sidebarRowKey(next)}`)?.focus();
  };

  return (
    <aside
      id="visited-pull-requests"
      aria-label="Reviews you have opened"
      // Navigation sits on the window itself so the main pane stays the one raised surface.
      className="mr-1 flex w-[252px] shrink-0 flex-col overflow-hidden bg-shell"
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
        <span className="shrink-0 text-[11px] tracking-tight text-muted-foreground uppercase">
          Recent
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {/* The padding sits inside the viewport so it does not inset the
         * scrollbar, which is positioned against the ScrollArea root. */}
        <div className="pt-3 pb-2" onKeyDown={onRowsKeyDown}>
          {state.kind === "failed" ? (
            <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
              Could not load recent reviews.
            </p>
          ) : null}
          {state.kind === "loaded" && state.rows.length === 0 ? (
            <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
              Pull requests and local reviews you open appear here.
            </p>
          ) : null}
          {state.kind === "loaded"
            ? withDateHeaders(state.rows, Date.now()).map(
                ({ row, heading }) => (
                  <Fragment key={sidebarRowKey(row)}>
                    {heading === undefined ? null : (
                      // The list already pads its own top, so the first header
                      // does not stack a second gap above it.
                      <p className="px-2.5 pt-3 pb-0.5 text-[10px] font-semibold tracking-widest text-muted-foreground/80 uppercase first:pt-0">
                        {heading}
                      </p>
                    )}
                    <VisitedRow
                      row={row}
                      selected={row === selectedRow}
                      tabStop={sidebarRowKey(row) === tabStopKey}
                      scope={scope}
                      watched={
                        host !== undefined &&
                        !isSidebarLocalRepositoryRow(row) &&
                        watch?.isWatched({ ...row, host }) === true
                      }
                      onFocus={() => setActiveRowKey(sidebarRowKey(row))}
                      onOpen={() => {
                        if (isSidebarLocalRepositoryRow(row)) {
                          onOpenLocalReview(row);
                          return;
                        }
                        onNavigate({
                          kind: "workbench",
                          reviewId: row.reviewId,
                        });
                      }}
                    />
                  </Fragment>
                ),
              )
            : null}
        </div>
      </ScrollArea>
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
 * the `octo-org/` prefix takes nearly half the width of `octo-org/acme-api#98`
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
    const label = visitedDateGroupLabel(row.sortedAt, now);
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
  sortedAt: string,
  now: number = Date.now(),
): string {
  const days = localDayIndex(now) - localDayIndex(Date.parse(sortedAt));
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
  tabStop,
  scope,
  watched,
  onOpen,
  onFocus,
}: {
  readonly row: SidebarReviewRow;
  readonly selected: boolean;
  readonly tabStop: boolean;
  readonly scope: VisitedLabelScope;
  /** Marks a pull request the maintainer watches (ADR 0045). */
  readonly watched: boolean;
  readonly onOpen: () => void;
  readonly onFocus: () => void;
}): React.JSX.Element {
  const { title, reference } = visitedRowLabels(row, scope);
  const marquee = useTitleMarquee();
  // A selected pull request row is where navigation would land, so it does
  // nothing. A local row stays live: its open follows the checkout's branch,
  // which may differ from the local Review on screen.
  const inert = selected && !isSidebarLocalRepositoryRow(row);
  return (
    <button
      type="button"
      id={`visited-row-${sidebarRowKey(row)}`}
      tabIndex={tabStop ? 0 : -1}
      onFocus={(event) => {
        onFocus();
        // A click also focuses the row, and that focus must not keep the title moving once the pointer leaves.
        if (event.currentTarget.matches(":focus-visible"))
          marquee.engage("focus");
      }}
      onBlur={() => marquee.release("focus")}
      onPointerEnter={() => marquee.engage("hover")}
      onPointerLeave={() => marquee.release("hover")}
      aria-current={selected ? "page" : undefined}
      aria-disabled={inert ? true : undefined}
      title={title}
      onClick={inert ? undefined : onOpen}
      className={cn(
        "ui-state-transition relative flex w-full min-w-0 items-start py-1.5 pr-3 pl-2.5 text-left outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        // An inert row takes no hover fill; a selected local row stays
        // clickable, so its hover darkens the selected fill.
        selected ? "bg-foreground/10" : "hover:bg-foreground/5",
        selected && !inert && "hover:bg-foreground/15",
      )}
    >
      {selected ? (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          ref={marquee.titleRef}
          data-marquee={marquee.style === undefined ? "idle" : "running"}
          style={marquee.style}
          className={cn(
            "min-w-0 truncate text-[13px] leading-snug",
            selected ? "font-semibold" : "font-medium",
          )}
        >
          <span>{title}</span>
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-[11px] text-muted-foreground">
          {/* The age is computed once per render; nothing ticks it. "visited"
           * keeps it apart from the state marker's "seen" age (ADR 0042). The
           * reference is the only part that clips, because the age is what
           * the row exists to tell you and it never gets its space back. A row
           * with no recorded open prints no age rather than dating a visit
           * Patchdesk never saw. */}
          <span className="flex min-w-0 items-baseline tabular-nums">
            {reference === "" ? null : (
              // Truncation drops the separator's trailing space, so padding stands in for it.
              <span className="min-w-0 truncate pr-1">{reference}</span>
            )}
            {row.lastOpenedAt === undefined ? null : (
              <time
                dateTime={row.lastOpenedAt}
                title={formatExactTime(row.lastOpenedAt)}
                className="shrink-0"
              >
                visited {formatRelativeTime(row.lastOpenedAt)}
              </time>
            )}
          </span>
          {watched ? (
            <span
              className="ml-auto inline-flex shrink-0 self-center"
              title="Watched"
            >
              <Eye className="size-3" aria-hidden="true" />
              <span className="sr-only">Watched</span>
            </span>
          ) : null}
          {isSidebarLocalRepositoryRow(row) ||
          row.terminal === undefined ? null : (
            <TerminalMarker terminal={row.terminal} />
          )}
        </span>
      </span>
    </button>
  );
}

const MARQUEE_DELAY_MS = 500;
const MARQUEE_PX_PER_SECOND = 30;
// Share of each pass spent moving; the rest holds at the two ends so both can be read.
const MARQUEE_TRAVEL_SHARE = 0.8;

type MarqueeTrigger = "hover" | "focus";

type TitleMarquee = {
  readonly titleRef: React.RefObject<HTMLSpanElement | null>;
  /** The scroll distance and pass length, set only while the title scrolls. */
  readonly style: React.CSSProperties | undefined;
  readonly engage: (trigger: MarqueeTrigger) => void;
  readonly release: (trigger: MarqueeTrigger) => void;
};

/**
 * Scrolls a clipped title to its end and back while the row is hovered or
 * focused, after a short delay. A title that fits, or a reader who asked for
 * less motion, keeps the static ellipsis.
 */
function useTitleMarquee(): TitleMarquee {
  const titleRef = useRef<HTMLSpanElement>(null);
  const triggers = useRef(new Set<MarqueeTrigger>());
  const timer = useRef<number | undefined>(undefined);
  const [style, setStyle] = useState<React.CSSProperties | undefined>();

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const engage = (trigger: MarqueeTrigger): void => {
    const wasIdle = triggers.current.size === 0;
    triggers.current.add(trigger);
    const title = titleRef.current;
    if (!wasIdle || title === null || prefersReducedMotion()) return;
    const distance = title.scrollWidth - title.clientWidth;
    if (distance <= 0) return;
    const seconds = distance / MARQUEE_PX_PER_SECOND / MARQUEE_TRAVEL_SHARE;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // SAFETY: both keys are custom properties the marquee rule in styles.css reads; CSSProperties does not declare them.
      setStyle({
        "--marquee-distance": `${distance}px`,
        "--marquee-duration": `${seconds.toFixed(2)}s`,
      } as React.CSSProperties);
    }, MARQUEE_DELAY_MS);
  };

  const release = (trigger: MarqueeTrigger): void => {
    triggers.current.delete(trigger);
    if (triggers.current.size > 0) return;
    window.clearTimeout(timer.current);
    setStyle(undefined);
  };

  return { titleRef, style, engage, release };
}

function prefersReducedMotion(): boolean {
  if (window.matchMedia === undefined) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * What a pull request that is no longer open reads as. The state is dated,
 * because the row is drawn from a stored observation and never from a live
 * GitHub read: an undated marker would look current when it is not.
 */
function TerminalMarker({
  terminal,
}: {
  readonly terminal: NonNullable<SidebarPullRequestRow["terminal"]>;
}): React.JSX.Element {
  const { label, dot } = visitedTerminalMarker(terminal);
  return (
    <time
      dateTime={terminal.observedAt}
      title={formatExactTime(terminal.observedAt)}
      className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10px]"
    >
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden="true" />
      {label}
    </time>
  );
}

/** The dot fill that tells the state apart at a glance; the words stay muted. */
type VisitedTerminalDot = "bg-primary" | "bg-muted-foreground";

type VisitedTerminalMarker = {
  readonly label: string;
  readonly dot: VisitedTerminalDot;
};

/**
 * The marker a closed or merged row carries, and its dot. Merged takes the
 * primary hue the Pull requests screen already uses for merged, and closed a
 * grey, as GitHub does; neither is an alert, so the words stay muted. "seen" is the
 * whole claim: three of the four writers of `observedAt` stamp Patchdesk's own
 * clock beside the GitHub read, so the age is when Patchdesk saw the state,
 * not when GitHub reached it. The fourth, `ReviewRecoveryService`, dates a
 * merge from GitHub's own `mergedAt`, so a merge reconciled at boot can read
 * older than Patchdesk's sighting of it. Either way the date never moves
 * again: a Terminal record is not observed a second time.
 */
// oxlint-disable-next-line react/only-export-components -- Shared state-marker rule, tested as a function in tests/renderer/visited-pull-requests.ui.test.tsx.
export function visitedTerminalMarker(
  terminal: NonNullable<SidebarPullRequestRow["terminal"]>,
  now: number = Date.now(),
): VisitedTerminalMarker {
  const seen = `seen ${formatRelativeTime(terminal.observedAt, now)}`;
  return terminal.state === "merged"
    ? { label: `merged, ${seen}`, dot: "bg-primary" }
    : { label: `closed, ${seen}`, dot: "bg-muted-foreground" };
}

type VisitedRowLabels = {
  readonly title: string;
  readonly reference: string;
};

/**
 * The label a visited row shows and the reference printed under it. A Review
 * opened before the route stored titles has none, so its reference becomes the
 * label; printing the reference again underneath would repeat the number, so
 * that row leaves the age standing alone. The separator belongs to the age, so
 * a row with no recorded open ends its reference at the number. A local
 * row is named by its repository, whatever the scope, plus the folder of a
 * linked worktree (#489), and marked "local" where a pull request prints its
 * number; it names no branch, which the checkout can change after the column
 * loaded (#479).
 */
// oxlint-disable-next-line react/only-export-components -- Shared row-label rule, tested as a function in tests/renderer/visited-pull-requests.ui.test.tsx.
export function visitedRowLabels(
  row:
    | Pick<
        SidebarPullRequestRow,
        "title" | "owner" | "repo" | "number" | "lastOpenedAt"
      >
    | Pick<
        SidebarLocalRepositoryRow,
        "owner" | "repo" | "reviewIds" | "lastOpenedAt" | "checkoutName"
      >,
  scope: VisitedLabelScope,
): VisitedRowLabels {
  const separator = row.lastOpenedAt === undefined ? "" : " · ";
  if ("reviewIds" in row)
    return {
      title:
        row.checkoutName === undefined
          ? `${row.owner}/${row.repo}`
          : `${row.owner}/${row.repo} · ${row.checkoutName}`,
      reference: `local${separator}`,
    };
  const repository = visitedRepositoryLabel(row, scope);
  if (row.title === undefined)
    return { title: `${repository}#${row.number}`, reference: "" };
  return {
    title: row.title,
    reference: `${repository}#${row.number}${separator}`,
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
