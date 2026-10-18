import { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import { ReviewOperationCoordinator } from "#src/services/review-operation-coordinator";
import { afterEach, describe, expect, it } from "vitest";
import { InsightStore } from "#src/adapters/storage/insight-store";
import { parseRetainedGuide } from "#src/domain/guide";
import { ok } from "#src/domain/result";
import {
  cleanupRoots,
  fixture,
  must,
  profileId,
  settled,
} from "./insight-run-fixture";

const output = {
  groups: [
    {
      title: "Restore request",
      explanation: "Restores pending state.",
      files: [{ fileId: "f1", relevance: "Restores the pending request." }],
    },
  ],
};
afterEach(cleanupRoots);

describe("retained Guide cancellation ordering", () => {
  it("preserves the old Guide and reading state when cancellation holds the lock before completion", async () => {
    let providerReady = (): void => undefined;
    let releaseProvider = (): void => undefined;
    let cancellationEntered = (): void => undefined;
    let releaseCancellation = (): void => undefined;
    let terminalQueued = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      providerReady = resolve;
    });
    const providerWait = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      cancellationEntered = resolve;
    });
    const cancellationWait = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const queued = new Promise<void>((resolve) => {
      terminalQueued = resolve;
    });
    let cancellationHoldsLock = false;
    class ObservedOperations extends ReviewOperationCoordinator {
      override withReviewLock<T>(
        profile: string,
        review: string,
        operation: () => Promise<T>,
      ): Promise<T> {
        if (cancellationHoldsLock) terminalQueued();
        return super.withReviewLock(profile, review, operation);
      }
    }
    class PausedCancellationStore extends InsightStore {
      override async save(
        ...input: Parameters<InsightStore["save"]>
      ): ReturnType<InsightStore["save"]> {
        if (input[1].activeRun?.status === "cancelling") {
          cancellationHoldsLock = true;
          cancellationEntered();
          await cancellationWait;
        }
        return super.save(...input);
      }
    }
    let attempt = 0;
    const value = await fixture(
      {
        async invoke() {
          attempt += 1;
          if (attempt === 2) {
            providerReady();
            await providerWait;
          }
          return ok(output);
        },
      },
      {
        operations: new ObservedOperations(),
        insightStore: (paths) =>
          new PausedCancellationStore(paths, readBoundedInsightArtifactFile),
      },
    );
    const input = {
      profileId,
      reviewId: value.review.id,
      type: "guide" as const,
      model: "model",
      reasoning: "medium" as const,
      language: "en" as const,
    };
    const first = must(await value.coordinator.start(input));
    await settled(value.coordinator, value.review.id, first.runId, "guide");
    must(
      await value.coordinator.updateGuideReadingState({
        profileId,
        reviewId: value.review.id,
        runId: first.runId,
        sessionId: value.session.id,
        expectedStateVersion: 0,
        state: {
          reviewedGroupIds: ["g1"],
          expandedAppearances: [{ groupId: "g1", fileId: "f1" }],
          anchor: { kind: "file", groupId: "g1", fileId: "f1", offset: 18 },
        },
      }),
    );
    const second = must(await value.coordinator.start(input));
    await ready;
    const cancelling = value.coordinator.cancel({
      profileId,
      reviewId: value.review.id,
      type: "guide",
      runId: second.runId,
    });
    await entered;
    releaseProvider();
    await queued;
    cancellationHoldsLock = false;
    releaseCancellation();
    expect(await cancelling).toMatchObject({
      _tag: "ok",
      value: { status: "cancelling" },
    });
    expect(
      await settled(value.coordinator, value.review.id, second.runId, "guide"),
    ).toMatchObject({ status: "cancelled", failureReason: "cancelled" });
    const after = must(
      await value.insights.loadTyped(
        profileId,
        value.review.id,
        "guide",
        parseRetainedGuide,
      ),
    );
    expect(after.retained?.runId).toBe(first.runId);
    expect(after.guideReadingState?.version).toBe(1);
    expect(after.guideReadingState?.reviewedGroupIds).toEqual(["g1"]);
    expect(after.guideReadingState?.expandedAppearances).toEqual([
      { groupId: "g1", fileId: "f1" },
    ]);
    expect(after.guideReadingState?.anchor).toEqual({
      kind: "file",
      groupId: "g1",
      fileId: "f1",
      offset: 18,
    });
  });

  it("keeps a replacement that completed before the cancellation request", async () => {
    const value = await fixture({ invoke: async () => ok(output) });
    const input = {
      profileId,
      reviewId: value.review.id,
      type: "guide" as const,
      model: "model",
      reasoning: "medium" as const,
      language: "en" as const,
    };
    const first = must(await value.coordinator.start(input));
    await settled(value.coordinator, value.review.id, first.runId, "guide");
    const replacement = must(await value.coordinator.start(input));
    await settled(
      value.coordinator,
      value.review.id,
      replacement.runId,
      "guide",
    );
    expect(
      await value.coordinator.cancel({
        profileId,
        reviewId: value.review.id,
        type: "guide",
        runId: replacement.runId,
      }),
    ).toMatchObject({
      _tag: "ok",
      value: { runId: replacement.runId, status: "completed" },
    });
    const after = must(
      await value.insights.loadTyped(
        profileId,
        value.review.id,
        "guide",
        parseRetainedGuide,
      ),
    );
    expect(after.retained?.runId).toBe(replacement.runId);
    expect(after.replacementFailure).toBeUndefined();
  });
});
