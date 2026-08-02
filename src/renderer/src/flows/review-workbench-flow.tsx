import { useCallback, useEffect, useState } from "react";

import { requestJson } from "../api-client";
import { ReviewWorkbench } from "../components/review-workbench";
import type { WorkbenchResponse } from "../renderer-contracts";
import { parseCommitDiffResponse, parseWorkbenchResponse, type CommitDiffResponse } from "../renderer-contracts";

export type ReviewWorkbenchFlowProps = {
  readonly workbench: WorkbenchResponse;
  readonly initialSection?: "diff" | "checks";
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onWorkbenchPatch: (patch: Partial<WorkbenchResponse>) => void;
  readonly onNavigationStateChange: (state: "clear" | "dirty_draft" | "write_pending") => void;
  readonly onNavigate: (section: "diff" | "checks") => void;
};

/** Owns loopback calls and replacement of the one canonical Review projection. */
export function ReviewWorkbenchFlow({
  workbench,
  initialSection,
  onWorkbenchReplace,
  onWorkbenchPatch,
  onNavigationStateChange,
  onNavigate,
}: ReviewWorkbenchFlowProps): React.JSX.Element {
  void initialSection;
  void onNavigate;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const detectUpdates = useCallback(async (): Promise<void> => {
    if (workbench.review.status !== "open") return;
    try {
      const value = await requestJson("/v1/reviews/detect-updates", {
        method: "POST",
        body: { profileId: workbench.session.key.profileId, reviewId: workbench.review.id },
      });
      if (isDetection(value) && value.updatesAvailable)
        onWorkbenchPatch({ revision: { ...workbench.revision, freshness: "updates_available" } });
    } catch {
      // Detection is advisory and never replaces the represented snapshot.
    }
  }, [onWorkbenchPatch, workbench]);

  useEffect(() => {
    void detectUpdates();
    if (workbench.review.status !== "open") return undefined;
    const timer = window.setInterval(() => void detectUpdates(), 30_000);
    return () => window.clearInterval(timer);
  }, [detectUpdates, workbench.review.status]);

  const refresh = useCallback(async (): Promise<void> => {
    if (workbench.review.status !== "open" || refreshing) return;
    setRefreshing(true);
    setRefreshError(false);
    try {
      const value = await requestJson("/v1/reviews/refresh", {
        method: "POST",
        body: { profileId: workbench.session.key.profileId, reviewId: workbench.review.id },
      });
      const parsed = parseWorkbenchResponse(value);
      if (parsed === undefined) throw new Error("Invalid Review refresh response");
      onWorkbenchReplace(parsed);
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  }, [onWorkbenchReplace, refreshing, workbench]);

  return (
    <>
      <ReviewWorkbench
        model={workbench}
        actions={{
          detectUpdates,
          refresh,
          loadCommitDiff: async (commitSha: string): Promise<CommitDiffResponse> => {
            const value = await requestJson("/v1/reviews/commit-diff", {
              method: "POST",
              body: { profileId: workbench.session.key.profileId, reviewId: workbench.review.id, commitSha },
            });
            const parsed = parseCommitDiffResponse(value);
            if (parsed === undefined) throw new Error("Invalid commit diff response");
            return parsed;
          },
          reportNavigationState: onNavigationStateChange,
        }}
        slots={{
          insights: <InsightsSlot workbench={workbench} />,
          publishedFeedback: <PublishedFeedbackSlot workbench={workbench} />,
          mergeAction: null,
          draftDock: <DraftSlot workbench={workbench} />,
        }}
      />
      {refreshError ? (
        <p role="alert" className="border-t px-4 py-2 text-sm text-destructive">
          GitHub state could not be refreshed. The represented Review remains readable.
        </p>
      ) : null}
      {refreshing ? <span className="sr-only" role="status">Refreshing Review state</span> : null}
    </>
  );
}

function InsightsSlot({ workbench }: { readonly workbench: WorkbenchResponse }): React.JSX.Element {
  const analysis = workbench.insights.analysis;
  const walkthrough = workbench.insights.walkthrough;
  return (
    <section aria-label="Review insights" className="mx-auto w-full max-w-3xl space-y-3">
      <h2 className="text-lg font-semibold">Insights</h2>
      <p className="text-sm text-muted-foreground">
        Analysis: {insightStatusLabel(analysis.status)} · Walkthrough: {insightStatusLabel(walkthrough.status)}
      </p>
      {analysis.retained !== undefined ? <p className="text-sm">Analysis result is available for this snapshot.</p> : null}
      {walkthrough.retained !== undefined ? <p className="text-sm">Walkthrough result is available for this snapshot.</p> : null}
    </section>
  );
}

function PublishedFeedbackSlot({ workbench }: { readonly workbench: WorkbenchResponse }): React.JSX.Element | null {
  const count = workbench.publishedFeedback.reviews.length + workbench.publishedFeedback.comments.length;
  return count === 0 ? null : <p className="border-t px-4 py-2 text-sm text-muted-foreground">Published feedback · {count}</p>;
}

function DraftSlot({ workbench }: { readonly workbench: WorkbenchResponse }): React.JSX.Element | null {
  if (workbench.draft === undefined) return null;
  return <p className="border-t px-4 py-2 text-sm text-muted-foreground">Review draft · {workbench.draft.items.length} items</p>;
}

function insightStatusLabel(status: WorkbenchResponse["insights"]["analysis"]["status"]): string {
  switch (status) {
    case "not_generated": return "Not generated";
    case "running": return "Running";
    case "current": return "Current";
    case "outdated": return "Outdated";
    case "failed": return "Failed";
  }
}

function isDetection(value: unknown): value is { readonly updatesAvailable: boolean } {
  return typeof value === "object" && value !== null && "updatesAvailable" in value && typeof value.updatesAvailable === "boolean";
}
