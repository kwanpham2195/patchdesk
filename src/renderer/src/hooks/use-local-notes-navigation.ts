import { useCallback, useMemo } from "react";

import type { LocalPatchViewSelection } from "../flows/use-local-patch-view";
import {
  localNotePlacementInput,
  type InlineLocalDraftPlacement,
  type LocalDraftPlacementContext,
} from "../local-draft-placement";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { ReviewWorkbenchPositionState } from "./use-review-workbench-position";

/** Where the Notes list and the diff place Local drafts, and how a Notes row reveals its lines. */
export type LocalNotesNavigation = {
  readonly placement: LocalDraftPlacementContext;
  /** Shows an inline draft's lines in the diff, clearing a Scope filter that hid its file (#557). */
  readonly reveal: (place: InlineLocalDraftPlacement) => void;
};

/**
 * Owns the Notes section's link to the diff. A row reveals its lines the way
 * a Threads row does, and also drops any Scope bucket and commit slice, so
 * the file the row names is always in the shown diff.
 */
export function useLocalNotesNavigation({
  model,
  localPatchView,
  reviewPatch,
  analysis,
  position,
  clearScopeBucket,
}: {
  readonly model: Pick<WorkbenchResponse, "session" | "patchViews">;
  readonly localPatchView: LocalPatchViewSelection | undefined;
  /** The shown view's patch; absent while it loads. */
  readonly reviewPatch: string | undefined;
  /** The current Analysis's run and mapped Findings; an empty list when none is current. */
  readonly analysis: Pick<
    LocalDraftPlacementContext,
    "analysisRunId" | "findings"
  >;
  readonly position: Pick<
    ReviewWorkbenchPositionState,
    | "selectSection"
    | "commitWorkbenchPosition"
    | "setSelectedRange"
    | "setSelectedThreadId"
    | "setActivePath"
  >;
  readonly clearScopeBucket: () => void;
}): LocalNotesNavigation {
  const sessionId = model.session.id;
  const { patchViews } = model;
  const selectedView = localPatchView?.selected;
  const shownView = localPatchView?.shown.view;
  const { analysisRunId, findings } = analysis;
  const placement = useMemo(
    () => ({
      sessionId,
      view: selectedView,
      notes:
        patchViews === undefined ||
        shownView === undefined ||
        reviewPatch === undefined
          ? undefined
          : localNotePlacementInput(patchViews, shownView, reviewPatch),
      analysisRunId,
      findings,
    }),
    [
      analysisRunId,
      findings,
      patchViews,
      reviewPatch,
      selectedView,
      sessionId,
      shownView,
    ],
  );
  const {
    selectSection,
    commitWorkbenchPosition,
    setSelectedRange,
    setSelectedThreadId,
    setActivePath,
  } = position;
  const reveal = useCallback(
    (place: InlineLocalDraftPlacement): void => {
      clearScopeBucket();
      selectSection("notes");
      setSelectedThreadId(undefined);
      setSelectedRange({
        start: place.startLine,
        end: place.line,
        side: place.side,
      });
      commitWorkbenchPosition({
        activeTab: "diff",
        section: "notes",
        selectedPath: place.path,
      });
      setActivePath(place.path);
    },
    [
      clearScopeBucket,
      commitWorkbenchPosition,
      selectSection,
      setActivePath,
      setSelectedRange,
      setSelectedThreadId,
    ],
  );
  return { placement, reveal };
}
