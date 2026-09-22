import { useMemo } from "react";

import { buildInsightReaders } from "../../components/insight-readers";
import { parseUnifiedPatch } from "../../../../domain/patch";
import type { WorkbenchResponse } from "../../renderer-contracts";
import {
  analysisFixtureData,
  analysisFixtureReviewActions,
  canonicalWorkbenchModel,
} from "./workbench-fixture-data";

/**
 * The Analysis reader as the Insights slot builds it, so the suggestion
 * preview and its action label are verifiable without a provider run. Every
 * action is a no-op: the fixture records nothing on GitHub.
 */
export function AnalysisFixture(): React.ReactNode {
  const workbench: WorkbenchResponse = useMemo(
    () => ({
      ...canonicalWorkbenchModel(analysisFixtureData),
      analysisReviewActions: analysisFixtureReviewActions,
    }),
    [],
  );
  const patchFiles = useMemo(
    () => parseUnifiedPatch(analysisFixtureData.fullPatch),
    [],
  );
  return (
    <div className="mx-auto max-w-4xl overflow-auto p-6">
      {buildInsightReaders({
        workbench,
        patchFiles,
        selectedInsight: "analysis",
        profileId: "fixture",
        reviewId: "fixture-review",
        addFinding: async () => undefined,
        dismissFinding: async () => undefined,
        walkthroughFocused: false,
        setWalkthroughFocused: () => undefined,
        onRegenerateBrief: () => undefined,
        onOpenWalkthrough: () => undefined,
        runEnabled: false,
      })}
    </div>
  );
}
