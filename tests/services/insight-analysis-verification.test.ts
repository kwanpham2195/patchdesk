import { afterEach, describe, expect, it } from "vitest";

import { markReviewTerminal } from "../../src/domain/review";
import { ok } from "../../src/domain/result";
import type { InsightRunCoordinator } from "../../src/services/insight-run-coordinator";
import {
  analysisResult,
  cleanupRoots,
  fixture,
  now,
  profileId,
  settled,
} from "./insight-run-fixture";

afterEach(cleanupRoots);

const twoStepAnalysis = {
  ...analysisResult,
  validationPlan: ["Run the unit tests.", "Open the Review in the app."],
};

async function completedAnalysis(
  coordinator: InsightRunCoordinator,
  reviewId: Parameters<InsightRunCoordinator["start"]>[0]["reviewId"],
) {
  const started = await coordinator.start({
    profileId,
    reviewId,
    type: "analysis",
    model: "model",
    reasoning: "medium",
  });
  if (started._tag === "err") throw new Error("expected an Analysis run");
  await settled(coordinator, reviewId, started.value.runId);
  return started.value.runId;
}

describe("InsightRunCoordinator Analysis Verification ticks", () => {
  it("stores ticks for the retained Analysis and starts a regenerated one unticked", async () => {
    const value = await fixture({ invoke: async () => ok(twoStepAnalysis) });
    const firstRunId = await completedAnalysis(
      value.coordinator,
      value.review.id,
    );

    const ticked = await value.coordinator.updateAnalysisVerification({
      profileId,
      reviewId: value.review.id,
      runId: firstRunId,
      stepIndex: 1,
      checked: true,
    });
    expect(ticked).toEqual({ _tag: "ok", value: { checkedStepIndexes: [1] } });
    expect(
      await value.insights.load(profileId, value.review.id, "analysis"),
    ).toMatchObject({
      _tag: "ok",
      value: { analysisVerification: { checkedStepIndexes: [1] } },
    });

    await completedAnalysis(value.coordinator, value.review.id);
    const regenerated = await value.insights.load(
      profileId,
      value.review.id,
      "analysis",
    );
    if (regenerated._tag === "err") throw new Error("expected a record");
    expect(regenerated.value.analysisVerification).toBeUndefined();
    expect(
      await value.coordinator.updateAnalysisVerification({
        profileId,
        reviewId: value.review.id,
        runId: firstRunId,
        stepIndex: 0,
        checked: true,
      }),
    ).toEqual({ _tag: "err", error: "not_available" });
  });

  it("refuses a step outside the retained validation plan", async () => {
    const value = await fixture({ invoke: async () => ok(twoStepAnalysis) });
    const runId = await completedAnalysis(value.coordinator, value.review.id);

    expect(
      await value.coordinator.updateAnalysisVerification({
        profileId,
        reviewId: value.review.id,
        runId,
        stepIndex: 2,
        checked: true,
      }),
    ).toEqual({ _tag: "err", error: "not_available" });
  });

  it("keeps ticks editable after the pull request closes", async () => {
    const value = await fixture({ invoke: async () => ok(twoStepAnalysis) });
    const runId = await completedAnalysis(value.coordinator, value.review.id);
    await value.reviews.save(markReviewTerminal(value.review, "closed", now));

    expect(
      await value.coordinator.updateAnalysisVerification({
        profileId,
        reviewId: value.review.id,
        runId,
        stepIndex: 0,
        checked: true,
      }),
    ).toEqual({ _tag: "ok", value: { checkedStepIndexes: [0] } });
  });
});
