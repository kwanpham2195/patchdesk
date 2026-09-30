import {
  indexPatchHunks,
  placeInView,
  type LocalPatchView,
  type LocalPatchViewPaths,
  type PatchHunkIndex,
} from "../../domain/local-patch-view";
import type {
  AgentExplanationEntry,
  LocalDraftEntry,
} from "./local-draft-contracts";
import type { WorkbenchResponse } from "./renderer-contracts";

/** The shown patch view of a shared local Review, which places notes across views (ADR 0051). */
export type LocalNotePlacementInput = {
  readonly view: LocalPatchView;
  readonly paths: LocalPatchViewPaths;
  readonly shownHunks: PatchHunkIndex;
};

/** The placement input for `patch` shown as `view`, from the projection's per-view touched paths. */
export function localNotePlacementInput(
  patchViews: NonNullable<WorkbenchResponse["patchViews"]>,
  view: LocalPatchView,
  patch: string,
): LocalNotePlacementInput {
  return {
    view,
    paths: {
      combined: patchViews.combined.paths,
      committed: patchViews.committed.paths,
      uncommitted: patchViews.uncommitted.paths,
    },
    shownHunks: indexPatchHunks(patch),
  };
}

/** A Finding of the current Analysis as the diff places it; only a `mapped` one renders inline. */
type CurrentFinding = {
  readonly id: string;
  readonly file?: string | undefined;
  readonly lineStart?: number | undefined;
  readonly lineEnd?: number | undefined;
  readonly diffSide?: "new" | "old" | undefined;
};

/** What the diff shows now, which decides where each Local draft renders inline. */
export type LocalDraftPlacementContext = {
  /** The session the diff shows; a draft of another session has lines numbered for another patch. */
  readonly sessionId: string;
  /** The patch view a shared Review shows; absent on a Review without views. */
  readonly view: LocalPatchView | undefined;
  /** Absent on a Review without views and while the shown view's patch loads; a note then shows at its stored lines. */
  readonly notes: LocalNotePlacementInput | undefined;
  /** The run of the current Analysis; absent when none is current. */
  readonly analysisRunId: string | undefined;
  /** The current Analysis's mapped Findings, the ones the Combined diff renders inline. */
  readonly findings: ReadonlyArray<CurrentFinding>;
};

/** Why a Local draft has no inline place in the shown diff. */
export type LocalDraftPlacementReason =
  | "earlier_session"
  | "tree_not_in_view"
  | "outside_hunk"
  | "finding_off_combined"
  | "finding_not_current";

/** Where a Local draft renders inline in the shown diff. */
export type InlineLocalDraftPlacement = {
  readonly placement: "inline";
  readonly path: string;
  readonly side: "new" | "old";
  readonly startLine: number;
  readonly line: number;
};

/** Where a Local draft renders inline, or why it does not. */
export type LocalDraftPlacement =
  | InlineLocalDraftPlacement
  | {
      readonly placement: "not_inline";
      readonly reason: LocalDraftPlacementReason;
    };

/**
 * Place one Local draft in the shown diff (#557). The diff's note cards and
 * the Notes list both read this, so they never disagree. A note follows
 * `placeInView` (ADR 0051); a drafted Finding is inline only where the
 * current Analysis renders it, which is the Combined view.
 */
export function placeLocalDraft(
  entry: LocalDraftEntry,
  context: LocalDraftPlacementContext,
): LocalDraftPlacement {
  if (entry.sessionId !== context.sessionId)
    return { placement: "not_inline", reason: "earlier_session" };
  if (entry.kind === "finding") return placeDraftedFinding(entry, context);
  const inView =
    context.notes === undefined
      ? {
          placement: "inline" as const,
          side: entry.side,
          startLine: entry.startLine,
          line: entry.line,
        }
      : placeInView(entry, context.notes.view, context.notes);
  return inView.placement === "inline"
    ? { ...inView, path: entry.path }
    : { placement: "not_inline", reason: inView.reason };
}

function placeDraftedFinding(
  entry: Extract<LocalDraftEntry, { readonly kind: "finding" }>,
  context: LocalDraftPlacementContext,
): LocalDraftPlacement {
  if (context.view !== undefined && context.view !== "combined")
    return { placement: "not_inline", reason: "finding_off_combined" };
  const finding =
    context.analysisRunId === entry.analysisRunId
      ? context.findings.find((current) => current.id === entry.findingId)
      : undefined;
  if (
    finding?.file === undefined ||
    finding.lineStart === undefined ||
    finding.diffSide === undefined
  )
    return { placement: "not_inline", reason: "finding_not_current" };
  return {
    placement: "inline",
    path: finding.file,
    side: finding.diffSide,
    startLine: finding.lineStart,
    line: finding.lineEnd ?? finding.lineStart,
  };
}

/**
 * Where an Agent explanation renders inline (#665): as a note written in
 * Combined, on the session it names, in the Combined view only, so its Reply
 * opens the note composer there. Undefined when it has no inline place.
 */
export function placeAgentExplanation(
  entry: AgentExplanationEntry,
  context: LocalDraftPlacementContext,
): InlineLocalDraftPlacement | undefined {
  const shownView = context.notes?.view ?? context.view;
  if (
    entry.sessionId !== context.sessionId ||
    (shownView !== undefined && shownView !== "combined")
  )
    return undefined;
  if (
    context.notes !== undefined &&
    placeInView(entry, "combined", context.notes).placement !== "inline"
  )
    return undefined;
  return {
    placement: "inline",
    path: entry.path,
    side: entry.side,
    startLine: entry.startLine,
    line: entry.line,
  };
}
