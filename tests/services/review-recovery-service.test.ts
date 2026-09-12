import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { ReviewLifecycleGate } from "../../src/services/review-lifecycle-gate";
import { ReviewRecoveryService } from "../../src/services/review-recovery-service";
import { createReview, type ReviewIdentity } from "../../src/domain/review";
import {
  createReviewId,
  createReviewSessionId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { ok, err, type Result } from "../../src/domain/result";

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}

const storedIdentity: ReviewIdentity = {
  profileId: must(parseWorkspaceProfileId("cfw")),
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
};
const storedReviewId = createReviewId(storedIdentity);
const storedHeadSha = must(parseGitSha("1".repeat(40)));
const storedSessionId = createReviewSessionId({
  ...storedIdentity,
  headSha: storedHeadSha,
  baseSha: must(parseGitSha("b".repeat(40))),
});
const storedCreatedAt = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const mergedAt = must(parseIsoTimestamp("2026-08-01T00:05:00.000Z"));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
const now = "2026-08-01T00:00:00.000Z" as never;
const reviewId =
  // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
  "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa" as never;
// SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
const operation = {
  operationId: "merge-1",
  profileId: "cfw",
  reviewId,
  sessionId:
    "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-00000000__439aa21713b5",
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
// SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
const review = {
  id: reviewId,
  status: { _tag: "Open" },
  updatedAt: reviewUpdatedAt,
} as never;

function service(save = vi.fn(async () => ok(undefined))) {
  const remove = vi.fn(async () => ok(undefined));
  const reviews = { load: vi.fn(async () => ok(review)), save };
  const recovery = new ReviewRecoveryService(
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
    {
      list: async () => ok([{ id: "cfw" }]),
      load: async () => ok({}),
    } as never,
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
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
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
      {
        list: async () => ok([{ id: "cfw" }, { id: "other" }]),
        load: async () => ok({}),
      } as never,
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
      {
        scanSessionEntries: async (profileId: string) => {
          started.push(profileId);
          await new Promise<void>((resolve) => complete.push(resolve));
          return ok({ sessions: [], invalidEntries: [] });
        },
      } as never,
      () => now,
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
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
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
    const otherOperation = {
      operationId: "merge-2",
      profileId: "cfw",
      reviewId:
        "github.com__centraldigital__patchdesk__pr-43__review-bbbbbbbbbbbb",
      sessionId:
        "github.com__centraldigital__patchdesk__pr-43__sha-bcdef123__base-00000000__439aa21713b5",
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
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
      {
        list: async () => ok([{ id: "cfw" }]),
        load: async () => ok({}),
      } as never,
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
      {
        scanSessionEntries: async () =>
          ok({ sessions: [], invalidEntries: [] }),
      } as never,
      () => now,
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
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
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
      {
        list: async () => ok([{ id: "cfw" }]),
        load: async () => ok({}),
      } as never,
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
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
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
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
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
    const value = service(vi.fn(async () => err({ reason: "io" } as never)));
    await expect(value.recovery.reconcile()).resolves.toEqual({
      recovered: 0,
      failed: 1,
    });
    expect(value.remove).not.toHaveBeenCalled();
  });

  it("converges when removing the merge evidence fails once", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-review-recovery-"));
    roots.push(root);
    const store = new ReviewStore(PatchdeskPaths.forTest(root));
    await expect(
      store.save(
        createReview({
          identity: storedIdentity,
          currentSessionId: storedSessionId,
          headSha: storedHeadSha,
          createdAt: storedCreatedAt,
        }),
      ),
    ).resolves.toMatchObject({ _tag: "ok" });

    let pending = [
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
      {
        operationId: "merge-1",
        profileId: storedIdentity.profileId,
        reviewId: storedReviewId,
        sessionId: storedSessionId,
        pr: {
          host: storedIdentity.host,
          owner: storedIdentity.owner,
          repo: storedIdentity.repo,
          number: storedIdentity.prNumber,
        },
        expectedHeadSha: storedHeadSha,
        method: "squash",
        acknowledgedWarningCodes: [],
        startedAt: storedCreatedAt,
        state: { _tag: "OutcomeUnknown" },
      } as never,
    ];
    let attempts = 0;
    const remove = vi.fn(async () => {
      attempts += 1;
      // The real store reports a failed unlink as `err`; it does not throw.
      if (attempts === 1) {
        return err({
          _tag: "StorageFailure",
          operation: "write",
          reason: "io",
        } as const);
      }
      pending = [];
      return ok(undefined);
    });
    const recovery = new ReviewRecoveryService(
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
      {
        list: async () => ok([{ id: storedIdentity.profileId }]),
        load: async () => ok({}),
      } as never,
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
      {
        scanSessionEntries: async () =>
          ok({ sessions: [], invalidEntries: [] }),
      } as never,
      () => now,
      {
        operationCoordinator: new ReviewOperationCoordinator(),
        reviews: store,
        mergeOperations: {
          listPending: async () => ok(pending),
          removeAfterSessionReceipt: remove,
        },
        github: {
          getMergeOutcome: async () => ok({ state: "merged", mergedAt }),
        },
      },
    );

    await expect(recovery.reconcile()).resolves.toEqual({
      recovered: 0,
      failed: 1,
    });
    const afterFirst = await store.load(
      storedIdentity.profileId,
      storedReviewId,
    );
    expect(afterFirst).toMatchObject({
      _tag: "ok",
      value: {
        status: { _tag: "Terminal", state: "merged", observedAt: mergedAt },
      },
    });
    const terminalUpdatedAt = must(afterFirst).updatedAt;
    expect(pending).toHaveLength(1);
    expect(remove).toHaveBeenCalledTimes(1);

    await expect(recovery.reconcile()).resolves.toEqual({
      recovered: 1,
      failed: 0,
    });
    expect(pending).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(
      must(await store.load(storedIdentity.profileId, storedReviewId))
        .updatedAt,
    ).toBe(terminalUpdatedAt);

    await expect(recovery.reconcile()).resolves.toEqual({
      recovered: 0,
      failed: 0,
    });
  });
});

it("keeps an uncertain merge locked when GitHub still reports the pull request open", async () => {
  const value = service();
  const recovery = new ReviewRecoveryService(
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
    {
      list: async () => ok([{ id: "cfw" }]),
      load: async () => ok({}),
    } as never,
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
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
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
    recovery.reconcileReview("cfw" as never, reviewId),
  ).resolves.toEqual({ recovered: 0, failed: 1 });
  expect(value.reviews.save).not.toHaveBeenCalled();
  expect(value.remove).not.toHaveBeenCalled();
});

it("terminalizes a confirmed closed-unmerged Review before removing the operation", async () => {
  const value = service();
  const recovery = new ReviewRecoveryService(
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
    {
      list: async () => ok([{ id: "cfw" }]),
      load: async () => ok({}),
    } as never,
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
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
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
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
