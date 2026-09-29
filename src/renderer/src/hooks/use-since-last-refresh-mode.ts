import { useCallback, useState } from "react";

import type { LocalPatchView } from "../../../domain/local-patch-view";
import type { NarrowedDiffControl } from "../components/review-diff-changes-menu";
import type { WorkbenchResponse } from "../renderer-contracts";
import type { SinceLastRefreshDiffResponse } from "../review-diff-contracts";
import {
  useNarrowedPatchRequest,
  type NarrowedPatchState,
} from "./use-narrowed-patch-request";

export type SinceLastRefreshMode = {
  /** Absent on a Review without Patch views, and while a commit slice owns the diff. */
  readonly control: NarrowedDiffControl | undefined;
  /** Set only while the mode is on; the patch from the previous session's Local snapshot to this one's. */
  readonly state: NarrowedPatchState;
};

/**
 * Owns Since last Refresh on a shared local Review (#604) and its patch
 * request, discarding a response for another session. The patch's new side is
 * the Local snapshot, so turning it on also shows Combined, the view whose
 * lines a note started there is numbered in.
 */
export function useSinceLastRefreshMode({
  model,
  commitSliceActive,
  loadSinceLastRefreshDiff,
  selectPatchView,
}: {
  readonly model: Pick<WorkbenchResponse, "session" | "sinceLastRefresh">;
  readonly commitSliceActive: boolean;
  readonly loadSinceLastRefreshDiff: (
    sessionId: string,
  ) => Promise<SinceLastRefreshDiffResponse>;
  readonly selectPatchView: (view: LocalPatchView) => void;
}): SinceLastRefreshMode {
  const availability = model.sinceLastRefresh;
  const sessionId = model.session.id;
  const [requested, setRequested] = useState(false);
  const active =
    requested && availability === "available" && !commitSliceActive;
  const state = useNarrowedPatchRequest({
    active,
    requestKey: sessionId,
    load: () =>
      loadSinceLastRefreshDiff(sessionId).then((response) =>
        response.sessionId === sessionId ? response.patch : undefined,
      ),
  });
  const onChange = useCallback(
    (next: boolean) => {
      if (next) selectPatchView("combined");
      setRequested(next);
    },
    [selectPatchView],
  );
  const control: NarrowedDiffControl | undefined =
    availability === undefined || commitSliceActive
      ? undefined
      : {
          active,
          loading: active && state._tag === "Loading",
          disabledReason:
            availability === "none"
              ? "Available after a Refresh that changes the diff"
              : availability === "base_moved"
                ? "The merge base moved in the last Refresh"
                : undefined,
          onChange,
        };
  return { control, state };
}
