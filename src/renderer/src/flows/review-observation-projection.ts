import {
  parseWorkbenchResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";

/** What a detect-updates `Reconciled` observation carries for the workbench. */
export type ReconciledProjection =
  | { readonly _tag: "absent" }
  | { readonly _tag: "parsed"; readonly workbench: WorkbenchResponse }
  | { readonly _tag: "invalid" };

/**
 * Parses the projection of a `Reconciled` observation. The server omits it
 * while GitHub has not yet surfaced every recent write, so `absent` is an
 * ordinary outcome and never reaches `parseWorkbenchResponse`, which logs
 * only for a present projection it rejects.
 */
export function reconciledProjection({
  projection,
}: {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the projection is the unparsed detect-updates payload this function hands to the boundary parser.
  readonly projection?: unknown;
}): ReconciledProjection {
  if (projection === undefined) return { _tag: "absent" };
  const workbench = parseWorkbenchResponse(projection);
  return workbench === undefined
    ? { _tag: "invalid" }
    : { _tag: "parsed", workbench };
}
