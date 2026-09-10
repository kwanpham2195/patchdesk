import { useEffect, useState } from "react";

import { requestJson } from "@/api-client";
import { formatRelativeTime } from "@/lib/relative-time";
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
  watchedRepoCount,
}: {
  /** Empty while a workspace switch is in flight, which draws the frame alone. */
  readonly profileId: string;
  readonly destination: AppDestination;
  readonly onNavigate: (destination: AppDestination) => void;
  /** Moves on every Review open, so a just-opened pull request appears without a relaunch. */
  readonly reloadKey: number;
  /** `owner/repo` on every row is noise when the workspace watches one repository. */
  readonly watchedRepoCount: number;
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

  return (
    <aside
      aria-label="Pull requests you have opened"
      className="mr-1 flex w-[252px] shrink-0 flex-col overflow-hidden rounded-t-lg border border-b-0 bg-card"
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
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
                showRepo={watchedRepoCount > 1}
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
  // A Review opened before the route stored titles has none.
  const title = row.title ?? `${row.owner}/${row.repo}#${row.number}`;
  const repo = showRepo ? `${row.owner}/${row.repo} ` : "";
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      title={title}
      // The row already showing is where navigation would land, so it does nothing.
      onClick={selected ? undefined : onOpen}
      className={cn(
        "ui-state-transition relative flex w-full min-w-0 items-start gap-1.5 py-1.5 pr-3 pl-2.5 text-left outline-none",
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
          {repo}#{row.number} · {formatRelativeTime(row.openedAt)}
        </span>
      </span>
    </button>
  );
}
