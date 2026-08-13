import { describe, expect, it, vi } from "vitest";

import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { ReviewRecoveryService } from "../../src/services/review-recovery-service";
import { ok, err } from "../../src/domain/result";

const now = "2026-08-01T00:00:00.000Z" as never;
const reviewId =
  "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa" as never;
const operation = {
  operationId: "merge-1",
  profileId: "cfw",
  reviewId,
  sessionId:
    "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__439aa21713b5",
  pr: {
    host: "github.com",
    owner: "centraldigital",
    repo: "patchdesk",
    number: 42,
  },
  expectedHeadSha: "a".repeat(40),
  method: "squash",
  acknowledgedWarningCodes: [],
  startedAt: now,
  state: { _tag: "OutcomeUnknown" },
} as never;
const reviewUpdatedAt = now;
const review = {
  id: reviewId,
  status: { _tag: "Open" },
  updatedAt: reviewUpdatedAt,
} as never;

function service(save = vi.fn(async () => ok(undefined))) {
  const remove = vi.fn(async () => ok(undefined));
  const reviews = { load: vi.fn(async () => ok(review)), save };
  const recovery = new ReviewRecoveryService(
    {
      list: async () => ok([{ id: "cfw" }]),
      load: async () => ok({}),
    } as never,
    {
      scanSessionEntries: async () => ok({ sessions: [], invalidEntries: [] }),
    } as never,
    () => now,
    {
      operationCoordinator: new ReviewOperationCoordinator(),
      reviews,
      mergeOperations: {
        listPending: async () => ok([operation]),
        removeAfterSessionReceipt: remove,
      },
      github: {
        getMergeOutcome: async () => ok({ state: "merged", mergedAt: now }),
      },
    },
  );
  return { recovery, reviews, remove };
}

describe("ReviewRecoveryService", () => {
  it("loads the operation owning Review, saves its terminal state before removing evidence", async () => {
    const value = service();
    await expect(value.recovery.reconcile()).resolves.toEqual({
      recovered: 1,
      failed: 0,
    });
    expect(value.reviews.load).toHaveBeenCalledWith("cfw", reviewId);
    expect(value.reviews.save.mock.invocationCallOrder[0]).toBeLessThan(
      value.remove.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(value.reviews.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({ _tag: "Terminal", state: "merged" }),
      }),
      reviewUpdatedAt,
    );
  });

  it("retains merge evidence when the terminal Review save fails", async () => {
    const value = service(vi.fn(async () => err({ reason: "io" } as never)));
    await expect(value.recovery.reconcile()).resolves.toEqual({
      recovered: 0,
      failed: 1,
    });
    expect(value.remove).not.toHaveBeenCalled();
  });
});

it("keeps an uncertain merge locked when GitHub still reports the pull request open", async () => {
  const value = service();
  const recovery = new ReviewRecoveryService(
    {
      list: async () => ok([{ id: "cfw" }]),
      load: async () => ok({}),
    } as never,
    {
      scanSessionEntries: async () => ok({ sessions: [], invalidEntries: [] }),
    } as never,
    () => now,
    {
      operationCoordinator: new ReviewOperationCoordinator(),
      reviews: value.reviews,
      mergeOperations: {
        listPending: async () => ok([operation]),
        removeAfterSessionReceipt: value.remove,
      },
      github: { getMergeOutcome: async () => ok({ state: "open" }) },
    },
  );
  await expect(
    recovery.reconcileReview("cfw" as never, reviewId),
  ).resolves.toEqual({ recovered: 0, failed: 1 });
  expect(value.reviews.save).not.toHaveBeenCalled();
  expect(value.remove).not.toHaveBeenCalled();
});

it("terminalizes a confirmed closed-unmerged Review before removing the operation", async () => {
  const value = service();
  const recovery = new ReviewRecoveryService(
    {
      list: async () => ok([{ id: "cfw" }]),
      load: async () => ok({}),
    } as never,
    {
      scanSessionEntries: async () => ok({ sessions: [], invalidEntries: [] }),
    } as never,
    () => now,
    {
      operationCoordinator: new ReviewOperationCoordinator(),
      reviews: value.reviews,
      mergeOperations: {
        listPending: async () => ok([operation]),
        removeAfterSessionReceipt: value.remove,
      },
      github: { getMergeOutcome: async () => ok({ state: "closed_unmerged" }) },
    },
  );
  await expect(
    recovery.reconcileReview("cfw" as never, reviewId),
  ).resolves.toEqual({ recovered: 1, failed: 0 });
  expect(value.reviews.save).toHaveBeenCalledWith(
    expect.objectContaining({
      status: expect.objectContaining({ state: "closed" }),
    }),
    reviewUpdatedAt,
  );
  expect(value.reviews.save.mock.invocationCallOrder[0]).toBeLessThan(
    value.remove.mock.invocationCallOrder[0] ?? Infinity,
  );
});
