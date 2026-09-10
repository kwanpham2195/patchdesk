import { useEffect, useState } from "react";

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
  // The count is over the rows on screen rather than the watchlist, so a column
  // listing one repository labels its rows bare even when the workspace watches
  // several: the label is there to tell apart what is visible.
  const showRepo =
    state.kind === "loaded" && distinctRepositoryCount(state.rows) > 1;

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
          ? state.rows.map((row) => (
              <VisitedRow
                key={row.reviewId}
                row={row}
                selected={row.reviewId === openReviewId}
                showRepo={showRepo}
                onOpen={() =>
                  onNavigate({ kind: "workbench", reviewId: row.reviewId })
                }
              />
            ))
          : null}
      </div>
    </aside>
  );
}

function distinctRepositoryCount(
  rows: ReadonlyArray<Pick<SidebarReviewRow, "owner" | "repo">>,
): number {
  return new Set(rows.map((row) => `${row.owner}/${row.repo}`)).size;
}

function VisitedRow({
  row,
  selected,
  showRepo,
  onOpen,
}: {
  readonly row: SidebarReviewRow;
  readonly selected: boolean;
  readonly showRepo: boolean;
  readonly onOpen: () => void;
}): React.JSX.Element {
  const { title, reference } = visitedRowLabels(row, showRepo);
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
        {/* The age is computed once per render; nothing ticks it. */}
        <span className="min-w-0 truncate tabular-nums text-[11px] text-muted-foreground">
          {reference}
          <time dateTime={row.openedAt} title={formatExactTime(row.openedAt)}>
            {formatCompactRelativeTime(row.openedAt)}
          </time>
        </span>
      </span>
    </button>
  );
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
  showRepo: boolean,
): VisitedRowLabels {
  const repository = showRepo ? `${row.owner}/${row.repo}` : "";
  if (row.title === undefined)
    return { title: `${repository}#${row.number}`, reference: "" };
  return {
    title: row.title,
    reference: `${repository === "" ? "" : `${repository} `}#${row.number} · `,
  };
}
