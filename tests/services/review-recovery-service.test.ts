import { describe, expect, it, vi } from "vitest";

import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { ReviewLifecycleGate } from "../../src/services/review-lifecycle-gate";
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

  it("reconciles independent profiles concurrently behind their profile locks", async () => {
    const started: string[] = [];
    const complete: Array<() => void> = [];
    const recovery = new ReviewRecoveryService(
      {
        list: async () => ok([{ id: "cfw" }, { id: "other" }]),
        load: async () => ok({}),
      } as never,
      {
        scanSessionEntries: async (profileId: string) => {
          started.push(profileId);
          await new Promise<void>((resolve) => complete.push(resolve));
          return ok({ sessions: [], invalidEntries: [] });
        },
      } as never,
      () => now,
      {
        lifecycleGate: new ReviewLifecycleGate(),
        operationCoordinator: new ReviewOperationCoordinator(),
        reviews: {
          load: async () => ok(review),
          save: async () => ok(undefined),
        },
        mergeOperations: {
          listPending: async () => ok([]),
          removeAfterSessionReceipt: async () => ok(undefined),
        },
        github: { getMergeOutcome: async () => ok({ state: "open" }) },
      },
    );

    const reconciled = recovery.reconcile();
    await vi.waitFor(() => expect(started).toEqual(["cfw", "other"]));
    for (const resolve of complete) resolve();
    await expect(reconciled).resolves.toEqual({ recovered: 0, failed: 0 });
  });

  it("checks independent merge operations concurrently while retaining Review locks", async () => {
    const otherOperation = {
      operationId: "merge-2",
      profileId: "cfw",
      reviewId:
        "github.com__centraldigital__patchdesk__pr-43__review-bbbbbbbbbbbb",
      sessionId:
        "github.com__centraldigital__patchdesk__pr-43__sha-bcdef123__439aa21713b5",
      pr: {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 43,
      },
      expectedHeadSha: "a".repeat(40),
      method: "squash",
      acknowledgedWarningCodes: [],
      startedAt: now,
      state: { _tag: "OutcomeUnknown" },
    } as never;
    const started: string[] = [];
    const complete: Array<() => void> = [];
    const recovery = new ReviewRecoveryService(
      {
        list: async () => ok([{ id: "cfw" }]),
        load: async () => ok({}),
      } as never,
      {
        scanSessionEntries: async () =>
          ok({ sessions: [], invalidEntries: [] }),
      } as never,
      () => now,
      {
        operationCoordinator: new ReviewOperationCoordinator(),
        reviews: {
          load: async () => ok(review),
          save: async () => ok(undefined),
        },
        mergeOperations: {
          listPending: async () => ok([operation, otherOperation]),
          removeAfterSessionReceipt: async () => ok(undefined),
        },
        github: {
          getMergeOutcome: async ({ pr }) => {
            started.push(String(pr.number));
            await new Promise<void>((resolve) => complete.push(resolve));
            return ok({ state: "merged", mergedAt: now });
          },
        },
      },
    );

    const reconciled = recovery.reconcile();
    await vi.waitFor(() => expect(started).toEqual(["42", "43"]));
    for (const resolve of complete) resolve();
    await expect(reconciled).resolves.toEqual({ recovered: 2, failed: 0 });
  });

  it("quarantines distinct fixed scan entries concurrently", async () => {
    const started: string[] = [];
    const complete: Array<() => void> = [];
    const recovery = new ReviewRecoveryService(
      {
        list: async () => ok([{ id: "cfw" }]),
        load: async () => ok({}),
      } as never,
      {
        scanSessionEntries: async () =>
          ok({
            sessions: [],
            invalidEntries: [
              { entryName: "invalid-one" },
              { entryName: "invalid-two" },
            ],
          }),
      } as never,
      () => now,
      {
        artifacts: {
          quarantineInvalidEntry: async (
            _profileId: string,
            entryName: string,
          ) => {
            started.push(entryName);
            await new Promise<void>((resolve) => complete.push(resolve));
            return ok({ entryName });
          },
        },
        operationCoordinator: new ReviewOperationCoordinator(),
        reviews: {
          load: async () => ok(review),
          save: async () => ok(undefined),
        },
        mergeOperations: {
          listPending: async () => ok([]),
          removeAfterSessionReceipt: async () => ok(undefined),
        },
        github: { getMergeOutcome: async () => ok({ state: "open" }) },
      } as never,
    );

    const reconciled = recovery.reconcile();
    await vi.waitFor(() =>
      expect(started).toEqual(["invalid-one", "invalid-two"]),
    );
    for (const resolve of complete) resolve();
    await expect(reconciled).resolves.toEqual({ recovered: 2, failed: 0 });
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
