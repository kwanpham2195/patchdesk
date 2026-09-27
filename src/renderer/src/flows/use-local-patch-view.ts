import { useCallback, useEffect, useRef, useState } from "react";
import * as v from "valibot";

import type {
  LocalPatchView,
  StoredLocalPatchView,
} from "../../../domain/local-patch-view";
import { requestJson } from "../api-client";
import type { WorkbenchResponse } from "../renderer-contracts";

/** The patch the diff shows: one view of one session. */
type ShownLocalPatch = {
  readonly sessionId: string;
  readonly view: LocalPatchView;
  readonly patch: string | undefined;
  /** The view's stored Viewed marks when the patch was read. */
  readonly viewedPaths: ReadonlyArray<string> | undefined;
};

/** The patch view a shared local Review shows, and the switch between views. */
export type LocalPatchViewSelection = {
  /** The view the maintainer picked; Combined on open, kept across Refresh. */
  readonly selected: LocalPatchView;
  /** Combined until the selected view's patch is read; the workbench shows `status` in place of a patch still loading. */
  readonly shown: ShownLocalPatch;
  readonly status: "ready" | "loading" | "failed";
  readonly select: (view: LocalPatchView) => void;
};

type FetchedPatch = ShownLocalPatch & { readonly view: StoredLocalPatchView };

type FailedRead = {
  readonly sessionId: string;
  readonly view: StoredLocalPatchView;
};

const localPatchViewResponseSchema = v.looseObject({
  sessionId: v.string(),
  view: v.picklist(["committed", "uncommitted"]),
  patch: v.string(),
  viewedPaths: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
});

/**
 * Owns the patch view of a shared local Review (ADR 0050). Combined comes from
 * the projection; Committed and Uncommitted are read from the session's stored
 * files, and a response for a view or session no longer requested is dropped.
 * Undefined on a Review without patch views.
 */
export function useLocalPatchView({
  workbench,
}: {
  readonly workbench: Pick<
    WorkbenchResponse,
    "session" | "review" | "fullPatch" | "viewedPaths" | "patchViews"
  >;
}): LocalPatchViewSelection | undefined {
  const hasViews = workbench.patchViews !== undefined;
  const profileId = workbench.session.key.profileId;
  const reviewId = workbench.review.id;
  const sessionId = workbench.session.id;
  const [selected, setSelected] = useState<LocalPatchView>("combined");
  const [fetched, setFetched] = useState<FetchedPatch | undefined>(undefined);
  const [failed, setFailed] = useState<FailedRead | undefined>(undefined);
  // Only the latest request may land, so a Committed answer after a switch to Uncommitted is dropped.
  const token = useRef(0);
  useEffect(() => {
    const requestToken = token.current + 1;
    token.current = requestToken;
    if (!hasViews || selected === "combined") return;
    void requestJson("/v1/reviews/local-patch-view", {
      method: "POST",
      body: { profileId, reviewId, sessionId, view: selected },
    })
      .then((value) => {
        if (token.current !== requestToken) return;
        const parsed = v.safeParse(localPatchViewResponseSchema, value);
        if (
          !parsed.success ||
          parsed.output.sessionId !== sessionId ||
          parsed.output.view !== selected
        )
          throw new Error("invalid local patch view response");
        setFetched({
          sessionId,
          view: selected,
          patch: parsed.output.patch,
          viewedPaths: parsed.output.viewedPaths,
        });
      })
      .catch(() => {
        if (token.current === requestToken)
          setFailed({ sessionId, view: selected });
      });
    return () => {
      if (token.current === requestToken) token.current += 1;
    };
  }, [hasViews, profileId, reviewId, selected, sessionId]);
  // A switch drops the last read patch, so a return to a view reads it, and its Viewed marks, again.
  const select = useCallback(
    (view: LocalPatchView): void => {
      if (view === selected) return;
      setFetched(undefined);
      setFailed(undefined);
      setSelected(view);
    },
    [selected],
  );
  if (!hasViews) return undefined;

  const combined: ShownLocalPatch = {
    sessionId,
    view: "combined",
    patch: workbench.fullPatch,
    viewedPaths: workbench.viewedPaths,
  };
  if (selected === "combined")
    return { selected, shown: combined, status: "ready", select };
  if (fetched?.sessionId === sessionId && fetched.view === selected)
    return { selected, shown: fetched, status: "ready", select };
  return {
    selected,
    shown: combined,
    status:
      failed?.sessionId === sessionId && failed.view === selected
        ? "failed"
        : "loading",
    select,
  };
}
