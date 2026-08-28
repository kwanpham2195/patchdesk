import { describe, expect, it } from "vitest";

import { PublishedFeedbackService } from "../../src/services/published-feedback-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { ok, type Result } from "../../src/domain/result";
import {
  at,
  barrier,
  lockKey,
  profileId,
  recorder,
  reviewId,
  settle,
  values,
  withinDeadline,
} from "./review-invariant-fixtures";
import { refreshService, writeGate } from "./review-lock-invariant-services";
import { lockRows } from "./review-lock-invariant-rows";

/**
 * One table over EVERY entry point that can touch a single Review, asserting
 * the coordinator lock actually gates it. A Review has exactly one in-process
 * owner (`ReviewOperationCoordinator`); an entry point that reads or writes a
 * Review's durable state outside that owner can interleave with a refresh or a
 * recovery and observe half a transaction.
 *
 * The invariant, one sentence: while a deferred lock holder is active, NO
 * entry point for that Review begins any work.
 *
 * "Began" is observed at each service's OWN first dependency (its journal
 * store, profile store, gate or gateway), not at the coordinator: a service
 * that did work before taking the lock would show no lock acquisition and
 * would still be wrong.
 *
 * THREE ROWS ARE RED AND STAY RED, and they are exactly that shape. The
 * table covers every public Review entry point on `ReviewWorkbenchController`
 * and on the six Review services; three of the controller's do durable-store
 * work before any lock and are `it.todo` with the reason on the row rather
 * than left out of the table:
 *
 * - `load` reads `journals.load` (through `recoverObservation`) and then
 *   `reviews.load`, both unlocked; it takes the lock later, inside the
 *   private `projectStable`. Two sequential locked segments, not one — B3's
 *   report states this is unchanged from `main` and deliberate.
 * - `detectUpdates` reads `recentWrites.load` before delegating to the
 *   locked `observation.observe`.
 * - `commitDiff` takes no Review lock at all; it calls `commits.diff`
 *   directly.
 *
 * No program item covers any of the three. Whether they are product defects
 * is arguable — all three are reads, and `open`/`openMerged`/`refresh` are
 * the paths that write. Their absence from the table would not have been.
 *
 * Two entry points remain outside the table and are reported rather than
 * added: `InsightRunCoordinator` (six sites) and
 * `ReviewRecoveryService.reconcile`, which sweeps every Review rather than
 * one. So this is EVERY entry point for a single Review on the classes the
 * table covers, not every line in the app that can reach a Review.
 */

describe("every Review entry point waits for the coordinator lock", () => {
  for (const row of lockRows) {
    const scenario = row.todo === undefined ? it : it.todo;
    scenario(
      `${row.name} does not begin while a deferred lock holder is active`,
      async () => {
        const coordinator = new ReviewOperationCoordinator();
        const track = recorder();
        const holder = barrier();
        const held = coordinator.withReviewLock(
          profileId,
          reviewId,
          () => holder.wait,
        );
        const invoke = row.build(coordinator, track);

        // The entry point is called with the lock held by someone else.
        // A stub that throws still proves the timing this row asserts, so the
        // outcome is swallowed; `began()` is what says the flow actually ran.
        const running = invoke().catch(() => ({ _tag: "err", error: "threw" }));
        await settle();

        expect(
          track.touched,
          `${row.name} touched a dependency while the lock was held`,
        ).toEqual([]);

        if (row.kind === "refuses") {
          // A command caller must not queue behind another user action.
          await expect(
            withinDeadline(running, 1000, row.name),
          ).resolves.toEqual(row.refusal);
          expect(track.touched).toEqual([]);
          holder.release();
          await held;
          return;
        }

        // A queueing caller must run — and only once the holder releases.
        holder.release();
        await held;
        await withinDeadline(running, 1000, row.name);
        expect(
          track.began(),
          `${row.name} never ran after the lock was released`,
        ).toBe(true);
      },
      2000,
    );
  }
});

/**
 * Fixed by F2. `PublishedFeedbackService.serialized` takes the Review lock
 * through `coordinator.acquire` and releases it in a `finally` once its
 * `operation` settles. The write used to call the injected `refresh` from
 * INSIDE that `operation` (via the old `afterWrite`), and `refresh` is
 * `ReviewRefreshService.refresh`, which takes the SAME key through
 * `withReviewLock`. `KeyedMutex` is not reentrant, so that refresh queued
 * behind a lock its own caller was holding and neither ever completed.
 *
 * The fix keeps the write itself inside `serialized` (`classifyWrite` only
 * classifies the GitHub write's outcome, taking no lock of its own) and
 * moves the refresh to `refreshAfterWrite`, called only after `serialized`
 * returns — i.e. after the lock is already released. `refresh` is otherwise
 * unchanged: it still takes the coordinator lock itself, which is now safe
 * because nothing holds it when `refreshAfterWrite` runs. Three routes reach
 * this shape: comment edit, comment delete, and review dismiss.
 *
 * Cost: releasing before the refresh opens a window where another command
 * can acquire the same key and run before the refresh does. That is
 * acceptable here — the write has already succeeded against GitHub by then,
 * and the refresh is a read reconciliation of local state, not part of the
 * durable write. A user who hits that window sees their edit/delete/dismiss
 * succeed and the local view catch up on the next refresh, exactly as if
 * they had triggered that refresh a moment later by hand.
 *
 * Each row below wires a REAL `ReviewOperationCoordinator` and a REAL
 * `ReviewRefreshService` — sharing one coordinator instance with the service
 * under test, the exact shape that deadlocks if the refresh ever moves back
 * inside `serialized` — and asserts the command settles well inside the
 * deadline instead of hanging.
 */
describe("a published-feedback write does not re-enter the lock it holds", () => {
  const routes: ReadonlyArray<{
    readonly name: string;
    readonly issue: (
      service: PublishedFeedbackService,
    ) => Promise<Result<unknown, unknown>>;
  }> = [
    {
      name: "editComment",
      issue: (service) =>
        service.editComment({
          profileId,
          reviewId,
          commentId: "comment-1",
          body: "edited",
        }),
    },
    {
      name: "deleteComment",
      issue: (service) =>
        service.deleteComment({
          profileId,
          reviewId,
          commentId: "comment-1",
          confirmation: true,
        }),
    },
    {
      name: "dismissReview",
      issue: (service) =>
        service.dismissReview({
          profileId,
          reviewId,
          publishedReviewId: "published-1",
          message: "stale",
          confirmation: true,
        }),
    },
  ];
  /** Feedback the three routes can actually act on, so each reaches its write. */
  const gatewayReachingTheWrite = () => ({
    getPullRequest: async () => ok(values.snapshot.pullRequest),
    getPullRequestComments: async () => ok(values.snapshot.comments),
    getPullRequestPublishedFeedback: async () =>
      ok({
        reviews: [
          {
            id: "published-1",
            author: "fixture",
            body: "",
            event: "APPROVED" as const,
            submittedAt: at,
            canDismiss: true,
          },
        ],
        comments: [
          {
            id: "comment-1",
            author: "fixture",
            body: "old",
            createdAt: at,
            canEdit: true,
            canDelete: true,
          },
        ],
        complete: true,
      }),
    updateReviewComment: async () => ok(undefined),
    deleteReviewComment: async () => ok(undefined),
    dismissReview: async () => ok(undefined),
  });

  for (const route of routes) {
    it(`${route.name} settles instead of deadlocking on its own Review lock`, async () => {
      const coordinator = new ReviewOperationCoordinator();
      const track = recorder();
      const refresh = refreshService(coordinator, track);
      const service = new PublishedFeedbackService(
        // SAFETY: recorded stubs; this row asserts settling, not the outcome.
        writeGate(track) as never,
        gatewayReachingTheWrite() as never,
        coordinator,
        (input) => refresh.refresh(input) as Promise<Result<unknown, unknown>>,
      );
      await expect(
        withinDeadline(route.issue(service), 500, `${route.name} refresh`),
      ).resolves.toBeDefined();
    }, 2000);
  }
});

// `lockKey` documents the exact key both halves of the coordinator use; it is
// asserted here rather than duplicated as a comment in every row above.
describe("the coordinator key", () => {
  it("is profile and Review, so two Reviews never block each other", async () => {
    const coordinator = new ReviewOperationCoordinator();
    const holder = barrier();
    const held = coordinator.withReviewLock(
      profileId,
      reviewId,
      () => holder.wait,
    );
    expect(coordinator.acquire(lockKey)).toBe(false);
    expect(coordinator.acquire(`${profileId}:other-review`)).toBe(true);
    coordinator.release(`${profileId}:other-review`);
    holder.release();
    await held;
    expect(coordinator.acquire(lockKey)).toBe(true);
    coordinator.release(lockKey);
  });
});
