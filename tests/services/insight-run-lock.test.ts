import { afterEach, describe, expect, it } from "vitest";

import { err } from "../../src/domain/result";
import type { InsightInvoker } from "../../src/services/insight-run-coordinator";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import {
  barrier,
  profileId,
  withinDeadline,
} from "./review-invariant-fixtures";
import { cleanupRoots, fixture, settled } from "./insight-run-fixture";

describe("Insight terminal persistence lock", () => {
  it("waits for the Review lock before persisting an invocation failure", async () => {
    class ObservableReviewOperationCoordinator extends ReviewOperationCoordinator {
      private nextLockRequest: (() => void) | undefined;

      watchNextLockRequest(): Promise<void> {
        return new Promise((resolve) => {
          this.nextLockRequest = resolve;
        });
      }

      override withReviewLock<T>(
        lockProfileId: string,
        lockReviewId: string,
        operation: () => Promise<T>,
      ): Promise<T> {
        this.nextLockRequest?.();
        this.nextLockRequest = undefined;
        return super.withReviewLock(lockProfileId, lockReviewId, operation);
      }
    }

    type InvocationResult = Awaited<ReturnType<InsightInvoker["invoke"]>>;
    let finishInvocation!: (result: InvocationResult) => void;
    const invocationResult = new Promise<InvocationResult>((resolve) => {
      finishInvocation = resolve;
    });
    const invocationStarted = barrier();
    const operations = new ObservableReviewOperationCoordinator();
    const value = await fixture(
      {
        async invoke() {
          invocationStarted.release();
          return invocationResult;
        },
      },
      { operations },
    );
    const started = await value.coordinator.start({
      profileId,
      reviewId: value.review.id,
      type: "analysis",
      model: "model",
      reasoning: "medium",
    });
    if (started._tag === "err") throw new Error("expected an active run");

    const holder = barrier();
    const lockEntered = barrier();
    const held = operations.withReviewLock(
      profileId,
      value.review.id,
      async () => {
        lockEntered.release();
        await holder.wait;
      },
    );

    let terminal: Awaited<ReturnType<typeof settled>> | undefined;
    try {
      await invocationStarted.wait;
      await lockEntered.wait;
      const terminalLockRequested = operations.watchNextLockRequest();
      finishInvocation(err({ reason: "execution_failed" }));
      await withinDeadline(
        terminalLockRequested,
        1000,
        "Insight terminal persistence lock",
      );

      const record = await value.insights.load(
        profileId,
        value.review.id,
        "analysis",
      );
      expect(record).toMatchObject({
        _tag: "ok",
        value: { activeRun: { id: started.value.runId } },
      });
      if (record._tag === "ok")
        expect(record.value.replacementFailure).toBeUndefined();
    } finally {
      holder.release();
      await held;
      terminal = await settled(
        value.coordinator,
        value.review.id,
        started.value.runId,
      ).catch(() => undefined);
    }

    expect(terminal).toMatchObject({
      status: "failed",
      failureReason: "failed",
      failureCategory: "execution_failed",
    });
  });
});

afterEach(cleanupRoots);
