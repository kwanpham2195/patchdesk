import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { RefreshOperationStore } from "../../src/adapters/storage/refresh-operation-store";
import type { ReviewRemoteSnapshot } from "../../src/adapters/storage/review-remote-store";
import { createReview } from "../../src/domain/review";
import type { RefreshOperation } from "../../src/domain/refresh-operation";
import type { ReviewSession } from "../../src/domain/review-session";
import {
  createReviewSessionId,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import type {
  PreparedReviewRefresh,
  ReviewRefreshService,
} from "../../src/services/review-refresh-service";
import { RefreshOperationService } from "../../src/services/refresh-operation-service";

function must<Value>(result: Result<Value, unknown>): Value {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}

const profileId = must(parseWorkspaceProfileId("acme"));
const identity = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("octo")),
  repo: must(parseGitHubRepoName("widgets")),
  prNumber: must(parsePullRequestNumber(7)),
};
const headSha = must(parseGitSha("a".repeat(40)));
const review = createReview({
  identity,
  currentSessionId: createReviewSessionId({
    ...identity,
    headSha,
    baseSha: must(parseGitSha("b".repeat(40))),
  }),
  headSha,
  createdAt: must(parseIsoTimestamp("2026-09-17T09:00:00.000Z")),
});
const nextReview = {
  ...review,
  updatedAt: must(parseIsoTimestamp("2026-09-17T10:00:00.000Z")),
};
const prepared: PreparedReviewRefresh = {
  expectedUpdatedAt: review.updatedAt,
  nextReview,
  sessionId: review.currentSessionId,
  snapshotHash: must(parseContentHash("d".repeat(64))),
  // SAFETY: this service test's refresh double never reads in-memory projection inputs after preparation; only the durable next Review fields are under test.
  snapshot: {} as ReviewRemoteSnapshot,
  // SAFETY: as above, the fake commit path does not project the selected session.
  selectedSession: {} as ReviewSession,
  refreshedAt: nextReview.updatedAt,
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-refresh-operation-"));
  roots.push(root);
  const operationStore = new RefreshOperationStore(
    PatchdeskPaths.forTest(root),
  );
  let rejectNextTerminalSave = false;
  const operations = {
    acknowledge: operationStore.acknowledge.bind(operationStore),
    begin: operationStore.begin.bind(operationStore),
    listReviewIds: operationStore.listReviewIds.bind(operationStore),
    load: operationStore.load.bind(operationStore),
    save: async (operation: RefreshOperation) => {
      if (
        rejectNextTerminalSave &&
        operation.state._tag !== "Requested" &&
        operation.state._tag !== "Prepared"
      ) {
        rejectNextTerminalSave = false;
        return err({
          _tag: "StorageFailure" as const,
          operation: "write" as const,
          reason: "io" as const,
        });
      }
      return operationStore.save(operation);
    },
  };
  let currentReview = review;
  const saves: Array<{ expected: string | undefined }> = [];
  const reviews = {
    load: async () => ok(currentReview),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- mirrors ReviewStore.save's JSON parser boundary.
    save: async (value: unknown, expected?: typeof review.updatedAt) => {
      if (expected !== currentReview.updatedAt)
        return err({
          _tag: "ReviewConflict" as const,
          reason: "stale_revision" as const,
        });
      // SAFETY: the service passes the already validated PreparedReviewRefresh.nextReview to this ReviewStore test double.
      currentReview = value as typeof review;
      saves.push({ expected });
      return ok(undefined);
    },
  };
  const launches: Array<() => Promise<void>> = [];
  let prepareResult: Result<
    PreparedReviewRefresh,
    { readonly reason: "github_read" }
  > = ok(prepared);
  const refresh = {
    prepareUnlocked: async () => prepareResult,
    reconcilePendingReviewUnlocked: async () => undefined,
    savePreparedReviewUnlocked: async (value: PreparedReviewRefresh) => {
      const saved = await reviews.save(
        value.nextReview,
        value.expectedUpdatedAt,
      );
      return saved._tag === "ok" ? saved : err({ reason: "conflict" as const });
    },
  } satisfies Pick<
    ReviewRefreshService,
    | "prepareUnlocked"
    | "reconcilePendingReviewUnlocked"
    | "savePreparedReviewUnlocked"
  >;
  const service = new RefreshOperationService({
    operations,
    reviews,
    refresh,
    coordinator: new ReviewOperationCoordinator(),
    now: () => must(parseIsoTimestamp("2026-09-17T09:30:00.000Z")),
    createOperationId: () => "refresh-7",
    launch: (run) => launches.push(run),
  });
  return {
    service,
    operations,
    launches,
    saves,
    currentReview: () => currentReview,
    failPreparation: () => {
      prepareResult = err({ reason: "github_read" });
    },
    failNextTerminalSave: () => {
      rejectNextTerminalSave = true;
    },
  };
}

describe("RefreshOperationService", () => {
  it("returns Requested before the worker persists Prepared, CAS, and Completed", async () => {
    const fixture = await harness();

    await expect(
      fixture.service.begin({ profileId, reviewId: review.id }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { operationId: "refresh-7", state: "requested" },
    });
    expect(fixture.saves).toEqual([]);

    await fixture.launches[0]?.();

    expect(fixture.saves).toEqual([{ expected: review.updatedAt }]);
    expect(fixture.currentReview()).toEqual(nextReview);
    await expect(
      fixture.service.poll({
        profileId,
        reviewId: review.id,
        operationId: "refresh-7",
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: { operationId: "refresh-7", state: "completed" },
    });
  });

  it("returns the same active operation without launching duplicate work", async () => {
    const fixture = await harness();

    const [first, second] = await Promise.all([
      fixture.service.begin({ profileId, reviewId: review.id }),
      fixture.service.begin({ profileId, reviewId: review.id }),
    ]);

    expect(first).toEqual(second);
    expect(fixture.launches).toHaveLength(1);
  });

  it("reports a terminal result when persisting that terminal transition fails", async () => {
    const fixture = await harness();
    fixture.failNextTerminalSave();
    await fixture.service.begin({ profileId, reviewId: review.id });

    await fixture.launches[0]?.();

    await expect(
      fixture.service.poll({
        profileId,
        reviewId: review.id,
        operationId: "refresh-7",
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { state: "completed" },
    });
    await expect(
      fixture.service.acknowledge({
        profileId,
        reviewId: review.id,
        operationId: "refresh-7",
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
  });

  it("retains a typed failure and permits acknowledgment only after settlement", async () => {
    const fixture = await harness();
    fixture.failPreparation();
    await fixture.service.begin({ profileId, reviewId: review.id });

    await expect(
      fixture.service.acknowledge({
        profileId,
        reviewId: review.id,
        operationId: "refresh-7",
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "operation_active" },
    });
    await fixture.launches[0]?.();
    await expect(
      fixture.service.poll({
        profileId,
        reviewId: review.id,
        operationId: "refresh-7",
      }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        operationId: "refresh-7",
        state: "failed",
        reason: "github_read",
      },
    });
    await expect(
      fixture.service.acknowledge({
        profileId,
        reviewId: review.id,
        operationId: "refresh-7",
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
  });

  it("reconciles Requested as Interrupted without running remote work", async () => {
    const fixture = await harness();
    await fixture.service.begin({ profileId, reviewId: review.id });

    await expect(fixture.service.reconcileProfile(profileId)).resolves.toEqual({
      _tag: "ok",
      value: undefined,
    });
    await expect(
      fixture.service.poll({
        profileId,
        reviewId: review.id,
        operationId: "refresh-7",
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { state: "interrupted" },
    });
    expect(fixture.saves).toEqual([]);
  });

  it("reconciles Prepared by CAS-saving its exact next Review", async () => {
    const fixture = await harness();
    await fixture.operations.save({
      operationId: "refresh-7",
      profileId,
      reviewId: review.id,
      expectedUpdatedAt: review.updatedAt,
      startedAt: must(parseIsoTimestamp("2026-09-17T09:30:00.000Z")),
      state: {
        _tag: "Prepared",
        nextReview,
        sessionId: prepared.sessionId,
        snapshotHash: prepared.snapshotHash,
      },
    });

    await fixture.service.reconcileProfile(profileId);

    expect(fixture.currentReview()).toEqual(nextReview);
    expect(fixture.saves).toEqual([{ expected: review.updatedAt }]);
    await expect(
      fixture.service.poll({
        profileId,
        reviewId: review.id,
        operationId: "refresh-7",
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { state: "completed" },
    });
  });
});
