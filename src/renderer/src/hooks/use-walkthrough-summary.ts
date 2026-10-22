import { useCallback, useEffect, useState } from "react";
import type { WalkthroughSummary } from "#src/domain/walkthrough-progress";
import { requestJson } from "#src/renderer/src/api-client";
import { parseWalkthroughSummaryReply } from "#src/renderer/src/walkthrough-contracts";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import type { InsightRunController } from "./use-insight-run";

/** One summary shared by the reader, navigation and regeneration controls. */
export type WalkthroughSummaryState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "loaded"; readonly summary: WalkthroughSummary };
type WalkthroughNavigationStatus = {
  readonly status: WorkbenchResponse["insights"]["walkthrough"]["status"];
  readonly label: string | undefined;
  readonly activeStatus: InsightRunController["status"] | undefined;
};
type WalkthroughSummaryControls = {
  readonly state: WalkthroughSummaryState;
  readonly refresh: () => void;
};

/** The summary's bound snapshot, not the legacy record, decides current-revision authoring. */
export function walkthroughRevisionMatches(
  workbench: WorkbenchResponse,
  summary: Extract<WalkthroughSummary, { _tag: "ready" }>,
): boolean {
  return (
    summary.sessionId === workbench.session.id &&
    summary.revision.headSha === workbench.revision.reviewedHeadSha &&
    summary.revision.patchHash === workbench.revision.patchHash
  );
}

/** Tab, header and Brief navigation use the published summary even during replacement. */
export function walkthroughSummaryStatus(
  workbench: WorkbenchResponse,
  state: WalkthroughSummaryState,
  run: Pick<InsightRunController, "busy" | "status">,
): WalkthroughNavigationStatus {
  if (run.busy)
    return { status: "running", label: undefined, activeStatus: run.status };
  if (state.status !== "loaded")
    return {
      status: state.status === "failed" ? "failed" : "current",
      label: state.status === "failed" ? "Unavailable" : "Loading",
      activeStatus: undefined,
    };
  const summary = state.summary;
  if (summary.run !== null)
    return {
      status: "running",
      label: summary.run.status === "paused" ? "Paused" : undefined,
      activeStatus:
        summary.run.status === "paused" ? undefined : summary.run.status,
    };
  const failure = summary.failure;
  if (failure !== null)
    return {
      status:
        failure.reason === "cancelled" || failure.reason === "superseded"
          ? "current"
          : "failed",
      label:
        failure.reason === "cancelled"
          ? "Cancelled"
          : failure.reason === "superseded"
            ? "Superseded"
            : "Failed",
      activeStatus: undefined,
    };
  return {
    status:
      summary._tag === "none"
        ? "not_generated"
        : walkthroughRevisionMatches(workbench, summary)
          ? "current"
          : "outdated",
    label: undefined,
    activeStatus: undefined,
  };
}

/** Ignores late reads after Review changes and polls only an active durable run. */
export function useWalkthroughSummary(
  workbench: WorkbenchResponse,
  run: Pick<InsightRunController, "busy" | "status">,
  reading: boolean,
): WalkthroughSummaryControls {
  const profileId = workbench.session.key.profileId;
  const reviewId = workbench.review.id;
  const scope = JSON.stringify([profileId, reviewId]);
  const key = JSON.stringify([
    profileId,
    reviewId,
    workbench.session.id,
    workbench.revision.patchHash,
    run.busy,
    run.status,
    reading,
  ]);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  const [snapshot, setSnapshot] = useState<{
    readonly key: string;
    readonly scope: string;
    readonly state: WalkthroughSummaryState;
  }>({ key: "", scope: "", state: { status: "loading" } });
  useEffect(() => {
    let cancelled = false;
    void requestJson("/v1/reviews/insights/walkthrough/summary", {
      method: "POST",
      body: { profileId, reviewId },
    })
      .then((body) => {
        if (cancelled) return;
        const summary = parseWalkthroughSummaryReply(body);
        setSnapshot({
          key,
          scope,
          state:
            summary === undefined
              ? { status: "failed" }
              : { status: "loaded", summary },
        });
      })
      .catch(() => {
        if (!cancelled)
          setSnapshot({ key, scope, state: { status: "failed" } });
      });
    return () => {
      cancelled = true;
    };
  }, [key, profileId, reviewId, scope, nonce]);
  const state: WalkthroughSummaryState =
    snapshot.key === key || snapshot.scope === scope
      ? snapshot.state
      : { status: "loading" };
  const active = state.status === "loaded" ? state.summary.run : null;
  useEffect(() => {
    if (active === null || active.status === "paused") return;
    const timer = setTimeout(refresh, 5000);
    return () => clearTimeout(timer);
  }, [active, refresh]);
  return { state, refresh };
}
