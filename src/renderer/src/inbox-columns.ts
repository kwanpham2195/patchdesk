import type { CSSProperties } from "react";

import type { InboxRow } from "./renderer-contracts";

/** Which optional desktop columns the Pull requests table draws for the loaded page. */
export type InboxColumnVisibility = {
  readonly labels: boolean;
  readonly changes: boolean;
};

const ALL_INBOX_COLUMNS: InboxColumnVisibility = {
  labels: true,
  changes: true,
};

/**
 * A column drops out only when every row on the page has nothing in it; an
 * empty page keeps them all so the loading placeholders line up with the header.
 */
export function inboxColumnVisibility(
  rows: ReadonlyArray<Pick<InboxRow, "labels" | "changeStats" | "scope">>,
): InboxColumnVisibility {
  if (rows.length === 0) return ALL_INBOX_COLUMNS;
  return {
    labels: rows.some((row) => row.labels.length > 0),
    changes: rows.some(
      (row) =>
        row.scope !== undefined ||
        row.changeStats.additions !== undefined ||
        row.changeStats.deletions !== undefined ||
        row.changeStats.changedFiles !== undefined,
    ),
  };
}

type InboxGridStyle = CSSProperties & { readonly "--inbox-columns": string };

/**
 * The desktop grid template, set on the header and on every row so they stay
 * aligned. Author takes most of a hidden Labels column's width, since full
 * author names were the first thing cut.
 */
export function inboxGridStyle(columns: InboxColumnVisibility): InboxGridStyle {
  const template = [
    "minmax(10rem,1fr)",
    columns.labels ? "8rem" : undefined,
    columns.labels ? "6rem" : "10rem",
    columns.changes ? "8rem" : undefined,
    "1.75rem",
    "2.75rem",
  ]
    .filter((track): track is string => track !== undefined)
    .join(" ");
  return { "--inbox-columns": template };
}
