import { ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { definedProps } from "../../../domain/defined-props";
import {
  briefReachMethodLine,
  briefReachRows,
  type BriefReach,
  type BriefReachRow,
} from "../brief-contracts";

/** The chip classes for a surface the change crosses and one it does not. */
const LIT_SURFACE =
  "inline-flex items-center gap-1.5 rounded-md border bg-accent px-2 py-0.5 text-xs";
const UNLIT_SURFACE =
  "inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground";

const SURFACES_LABEL = "Surfaces crossed";

/** A list row as one entry of the Reach block, marked empty when it names nothing. */
function listSection(row: BriefReachRow) {
  return {
    label: row.label,
    empty: row.items.length === 0,
    node: <ReachListRow key={row.label} row={row} />,
  };
}

/**
 * The Reach block: what depends on the changed code, one hop out. Every count
 * came from a `git grep` in the main process, and the footer says so, because a
 * name match is not a call graph.
 */
export function ReachBlock({
  reach,
  headSha,
}: {
  readonly reach: BriefReach;
  readonly headSha: string;
}): React.JSX.Element {
  const rows = useMemo(() => briefReachRows(reach), [reach]);
  const [emptyExpanded, setEmptyExpanded] = useState(false);
  const surfacesRow = (
    <ReachRow
      key="surfaces"
      label={SURFACES_LABEL}
      hint="each flag cites its path"
    >
      <div className="flex flex-wrap gap-1.5">
        {reach.surfaces.map((surface) => (
          <span
            key={surface.surface}
            className={surface.path === undefined ? UNLIT_SURFACE : LIT_SURFACE}
          >
            {surface.surface}
            {surface.path === undefined ? null : (
              <span className="font-mono text-[10px] text-muted-foreground">
                {surface.path}
              </span>
            )}
          </span>
        ))}
      </div>
    </ReachRow>
  );
  const sections = [
    listSection(rows.contracts),
    {
      label: SURFACES_LABEL,
      empty: reach.surfaces.every((surface) => surface.path === undefined),
      node: surfacesRow,
    },
    listSection(rows.untested),
    listSection(rows.removed),
  ];
  const empty = sections.filter((section) => section.empty);
  return (
    <section aria-label="Reach" className="flex min-w-0 flex-col gap-2">
      {/* The method line at the foot of this block already states the hop
          count and that the counts came from a text search. */}
      <h3 className="text-sm font-medium">Reach</h3>
      {sections
        .filter((section) => !section.empty)
        .map((section) => section.node)}
      {/* A row that found nothing still costs a full card, so they fold into one line until asked for. */}
      {empty.length === 0 ? null : (
        <button
          type="button"
          aria-expanded={emptyExpanded}
          onClick={() => setEmptyExpanded((expanded) => !expanded)}
          className="flex items-center gap-1.5 self-start rounded-sm text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={`size-3.5 shrink-0 transition-transform ${emptyExpanded ? "rotate-90" : ""}`}
          />
          Nothing found: {empty.map((section) => section.label).join(" · ")}
        </button>
      )}
      {emptyExpanded ? empty.map((section) => section.node) : null}
      <p className="text-[11px] text-muted-foreground">
        {briefReachMethodLine(reach, headSha)}
      </p>
    </section>
  );
}

/** One list row: each name beside the count Patchdesk made for it, when it has one, then where. */
function ReachListRow({
  row,
}: {
  readonly row: BriefReachRow;
}): React.JSX.Element {
  return (
    <ReachRow label={row.label} {...definedProps({ hint: row.hint })}>
      {row.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{row.empty}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {row.items.map((item) => (
            <li
              key={item.name}
              className="flex flex-wrap items-baseline gap-x-3"
            >
              <span
                className={`font-mono text-xs ${item.count === undefined && item.hot ? "text-[var(--status-warning)]" : ""}`}
              >
                {item.name}
              </span>
              {item.count === undefined ? null : (
                <span
                  className={`font-mono text-[11px] tabular-nums ${item.hot ? "text-[var(--status-warning)]" : "text-muted-foreground"}`}
                >
                  {item.count}
                </span>
              )}
              {item.paths.length === 0 ? null : (
                <span className="basis-full pl-3 font-mono text-[11px] text-muted-foreground">
                  {item.paths.join(" · ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </ReachRow>
  );
}

/** One row of the Reach block: its own labelled region, so each is reachable by name. */
function ReachRow({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-label={label}
      className="grid min-w-0 gap-x-4 gap-y-1.5 rounded-md border p-3 md:grid-cols-[10rem_minmax(0,1fr)]"
    >
      <h4 className="text-xs font-medium">
        {label}
        {hint === undefined ? null : (
          <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
            {hint}
          </span>
        )}
      </h4>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
