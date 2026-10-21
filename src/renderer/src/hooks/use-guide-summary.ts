import { useCallback, useEffect, useState } from "react";

import type { GuideRunStatus, GuideSummary } from "#src/domain/guide-progress";
import { parseGuideSummaryReply } from "#src/renderer/src/guide-contracts";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import { publishedGuideRevisionMatches } from "#src/renderer/src/components/guide-review-controls";
import type { InsightRunController } from "./use-insight-run";
import { requestGuideJson } from "./guide-request-scheduler";

/** One strictly parsed summary shared by navigation, run controls and the paged reader. */
export type GuideSummaryState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "loaded"; readonly summary: GuideSummary };

type GuideSummaryControls = {
  readonly state: GuideSummaryState;
  readonly activeRun: GuideRunStatus;
  readonly refresh: () => void;
};
type GuideNavigationStatus = {
  readonly status: WorkbenchResponse["insights"]["guide"]["status"];
  readonly label: string | undefined;
  readonly activeStatus: InsightRunController["status"] | undefined;
};

/** The summary owner aborts stale reads and schedules the next active-run read only after the previous one settles. */
export function useGuideSummary(
  workbench: WorkbenchResponse,
  controller: Pick<InsightRunController, "busy" | "status">,
  reading: boolean,
): GuideSummaryControls {
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  const profileId = workbench.session.key.profileId;
  const reviewId = workbench.review.id;
  const scope = JSON.stringify([profileId, reviewId]);
  const key = JSON.stringify([
    profileId,
    reviewId,
    workbench.session.id,
    workbench.revision.reviewedHeadSha,
    workbench.revision.patchHash,
    controller.busy,
    controller.status,
    workbench.insights.guide.activeRun?.runId,
    reading,
  ]);
  const [snapshot, setSnapshot] = useState<{
    readonly key: string;
    readonly scope: string;
    readonly state: GuideSummaryState;
    readonly activeRun: GuideRunStatus;
  }>({ key: "", scope: "", state: { status: "loading" }, activeRun: null });
  useEffect(() => {
    const controller = new AbortController();
    // Record a committed exit before another entry can reuse its earlier summary.
    setSnapshot((current) =>
      current.key === key
        ? current
        : {
            key,
            scope,
            state: { status: "loading" },
            activeRun: current.scope === scope ? current.activeRun : null,
          },
    );
    void requestGuideJson(
      "/v1/reviews/insights/guide/summary",
      { method: "POST", body: { profileId, reviewId } },
      { signal: controller.signal },
    )
      .then((reply) => {
        if (controller.signal.aborted) return;
        const summary = parseGuideSummaryReply(reply);
        setSnapshot((current) => ({
          key,
          scope,
          activeRun:
            summary === undefined
              ? current.scope === scope
                ? current.activeRun
                : null
              : summary.run,
          state:
            summary === undefined
              ? { status: "failed" }
              : { status: "loaded", summary },
        }));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setSnapshot((current) => ({
            key,
            scope,
            state: { status: "failed" },
            activeRun: current.scope === scope ? current.activeRun : null,
          }));
      });
    return () => controller.abort();
  }, [profileId, reviewId, key, scope, nonce]);
  const state: GuideSummaryState =
    snapshot.key === key ? snapshot.state : { status: "loading" };
  const run = state.status === "loaded" ? state.summary.run : null;
  useEffect(() => {
    if (run === null || run.status === "paused") return;
    const timer = setTimeout(refresh, 5_000);
    return () => clearTimeout(timer);
  }, [run, refresh]);
  return {
    state,
    refresh,
    activeRun: snapshot.scope === scope ? snapshot.activeRun : null,
  };
}

/** New Guide navigation never infers a result from legacy retained state. */
export function guideSummaryStatus(
  workbench: WorkbenchResponse,
  state: GuideSummaryState,
  run: Pick<InsightRunController, "busy" | "status">,
): GuideNavigationStatus {
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
  if (summary.failure !== null) {
    const reason = summary.failure.reason;
    return {
      status:
        reason === "cancelled" || reason === "superseded"
          ? "current"
          : "failed",
      label:
        reason === "cancelled"
          ? "Cancelled"
          : reason === "superseded"
            ? "Superseded"
            : "Failed",
      activeStatus: undefined,
    };
  }
  return {
    status:
      summary._tag === "none"
        ? "not_generated"
        : workbench.revision.patchHash !== undefined &&
            !publishedGuideRevisionMatches(workbench, summary)
          ? "outdated"
          : "current",
    label: undefined,
    activeStatus: undefined,
  };
}
