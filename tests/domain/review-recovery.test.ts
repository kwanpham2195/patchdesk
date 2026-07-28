import { describe, expect, it } from "vitest";

import { decideReviewRecovery, projectReviewRecovery, type ReviewRecoveryInput } from "../../src/domain/review-recovery";

function input(overrides: Partial<ReviewRecoveryInput> = {}): ReviewRecoveryInput {
  return {
    session: { state: { _tag: "Created" } },
    ...overrides,
  };
}

describe("decideReviewRecovery", () => {
  it.each([
    [{ activePreparation: true }, { _tag: "Preparing" }],
    [{ session: { state: { _tag: "Created" } } }, { _tag: "Actionable", action: "run_review" }],
    [{ session: { state: { _tag: "Discarded" } } }, { _tag: "Actionable", action: "run_review" }],
    [{ session: { state: { _tag: "Running" } }, liveRun: true }, { _tag: "Actionable", action: "reconnect" }],
    [{ session: { state: { _tag: "Running" } } }, { _tag: "Actionable", action: "start_again" }],
    [{ latestAttempt: { state: { _tag: "Interrupted" } } }, { _tag: "Actionable", action: "start_again" }],
    [{ latestAttempt: { state: { _tag: "Failed" } } }, { _tag: "Actionable", action: "try_again" }],
    [{ session: { state: { _tag: "Stale", reason: "orphaned_run" } } }, { _tag: "Actionable", action: "prepare_again" }],
    [{ session: { state: { _tag: "Merged", mergedAt: "2026-01-01T00:00:00.000Z" } } }, { _tag: "Unavailable" }],
  ] as const)("maps durable state to one display-safe decision", (overrides, expected) => {
    expect(decideReviewRecovery(input(overrides))).toEqual(expected);
  });

  it("projects every decision into one friendly action slot", () => {
    const cases = [
      [{ _tag: "Preparing" }, { noticeKey: "preparing", tone: "neutral" }],
      [{ _tag: "Actionable", action: "run_review" }, { noticeKey: "ready_to_review", tone: "positive", actionKey: "run_review" }],
      [{ _tag: "Actionable", action: "reconnect" }, { noticeKey: "review_in_progress", tone: "positive", actionKey: "reconnect" }],
      [{ _tag: "Actionable", action: "start_again" }, { noticeKey: "review_interrupted", tone: "warning", actionKey: "start_again" }],
      [{ _tag: "Actionable", action: "try_again" }, { noticeKey: "review_failed", tone: "warning", actionKey: "try_again" }],
      [{ _tag: "Actionable", action: "prepare_again" }, { noticeKey: "needs_preparation", tone: "warning", actionKey: "prepare_again" }],
      [{ _tag: "Unavailable" }, undefined],
    ] as const;
    for (const [decision, expected] of cases) expect(projectReviewRecovery(decision)).toEqual(expected);
  });

  it("does not expose technical fields or copy", () => {
    const decision = decideReviewRecovery(input({ latestAttempt: { state: { _tag: "Failed" } } }));
    expect(decision).toEqual({ _tag: "Actionable", action: "try_again" });
    expect(JSON.stringify(decision)).not.toMatch(/storage|path|session|attempt/i);
  });
});
