import { useEffect, useState } from "react";

import { requestJson } from "@/api-client";
import { parseSidebarReviewsResponse } from "@/renderer-contracts";
import type { SidebarReviewRow } from "@/sidebar-contracts";

export type VisitedPullRequestRows =
  | { readonly kind: "idle" }
  | { readonly kind: "loaded"; readonly rows: ReadonlyArray<SidebarReviewRow> }
  | { readonly kind: "failed" };

/**
 * The pull requests the maintainer has opened in the active workspace, in the
 * order `GET /v1/sidebar/reviews` returns them.
 *
 * The route reads local Review records only, so this reaches GitHub for
 * nothing. It is also not polled: the list is re-read when the workspace
 * changes or `reloadKey` moves, and never on a timer (ADR 0032).
 */
export function useVisitedPullRequestRows(
  /** Empty while a workspace switch is in flight, which loads nothing. */
  profileId: string,
  /** Moves on every Review open, so a just-opened pull request appears without a relaunch. */
  reloadKey: number,
): VisitedPullRequestRows {
  const [state, setState] = useState<VisitedPullRequestRows>({ kind: "idle" });

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

  return state;
}
