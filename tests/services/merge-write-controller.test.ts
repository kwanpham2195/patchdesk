import { describe, expect, it, vi } from "vitest";

import {
  parseContentHash,
  parseGitSha,
  parseIsoTimestamp,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";
import { MergeWriteController } from "../../src/services/merge-write-controller";
import type { mergePullRequest } from "../../src/services/merge-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

const profileId = value(parseWorkspaceProfileId("cfw"));
const reviewId = value(
  parseReviewId(
    "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
  ),
);
const sessionId = value(
  parseReviewSessionId(
    "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__b48f8e2e76ca",
  ),
);
const headSha = value(parseGitSha("a".repeat(40)));
const patchHash = value(parseContentHash("b".repeat(64)));
const at = value(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
type MergeResult = Awaited<ReturnType<typeof mergePullRequest>>;

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}

function request() {
  return {
    profileId,
    reviewId,
    sessionId,
    expectedHeadSha: headSha,
    expectedBaseSha: headSha,
    expectedPatchHash: patchHash,
    expectedRevision: at,
    method: "squash",
    acknowledgedWarnings: {
      revision: { headSha, baseSha: headSha, patchHash },
      warningCodes: [],
    },
  };
}

function fixture(
  options: {
    readonly fresh?: ReturnType<typeof ok> | ReturnType<typeof err>;
    readonly saveReview?: ReturnType<typeof ok> | ReturnType<typeof err>;
    readonly merge?: MergeResult;
  } = {},
) {
  const operations = {
    begin: vi.fn(async () => ok(undefined)),
    markOutcomeUnknown: vi.fn(async () => ok(undefined)),
    confirm: vi.fn(async () => ok(undefined)),
    reject: vi.fn(async () => ok(undefined)),
    removeAfterSessionReceipt: vi.fn(async () => ok(undefined)),
  };
  // SAFETY: this fixture supplies the review fields consumed by the controller's terminal-state path.
  const review = {
    id: reviewId,
    updatedAt: at,
    status: { _tag: "Open" },
    representedRemote: { refreshedAt: at },
  } as never;
  const reviews = {
    load: vi.fn(async () => ok(review)),
    save: vi.fn(async () => options.saveReview ?? ok(undefined)),
  };
  // SAFETY: this fixture supplies the session fields consumed by the controller's merge request.
  const session = {
    id: sessionId,
    key: {
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      prNumber: 42,
      headSha,
    },
    pr: { baseSha: headSha },
  } as never;
  const writeGate = {
    requireFresh: vi.fn(
      async () =>
        options.fresh ??
        ok({ profile: { id: profileId }, session, review, snapshot: {} }),
    ),
  };
  const coordinator = new ReviewOperationCoordinator();
  const merge = vi.fn(
    async (
      _input: Parameters<typeof mergePullRequest>[0],
    ): Promise<MergeResult> =>
      options.merge ?? err({ _tag: "GitHubMergeOutcomeUnknown" }),
  );
  // SAFETY: the fake GitHub gateway is unused because the injected merge executor owns the remote seam.
  const controller = new MergeWriteController(
    // SAFETY: the merge controller test reaches only the injected merge executor, not the gateway shape.
    {} as never,
    ["squash"],
    () => at,
    // SAFETY: these fakes implement the operation methods exercised by this controller test.
    operations as never,
    // SAFETY: this fake returns the fresh session/review fixture above for the tested gate path.
    writeGate as never,
    // SAFETY: this fake implements the review load/save methods exercised by the terminal path.
    reviews as never,
    coordinator,
    merge,
  );
  return { controller, operations, reviews, writeGate, coordinator, merge };
}

describe("MergeWriteController", () => {
  it("rejects malformed input before acquiring the shared write boundary", async () => {
    const value = fixture();
    await expect(value.controller.merge({ method: "delete" })).resolves.toEqual(
      { _tag: "err", error: { reason: "invalid_input" } },
    );
    expect(value.writeGate.requireFresh).not.toHaveBeenCalled();
    expect(value.operations.begin).not.toHaveBeenCalled();
  });

  it("binds acknowledgement to the exact represented base, head, and patch", async () => {
    const value = fixture();
    const invalid = {
      ...request(),
      acknowledgedWarnings: {
        revision: { headSha, baseSha: "c".repeat(40), patchHash },
        warningCodes: [],
      },
    };
    await expect(value.controller.merge(invalid)).resolves.toEqual({
      _tag: "err",
      error: { reason: "invalid_input" },
    });
    expect(value.operations.begin).not.toHaveBeenCalled();
  });

  it("rejects a stale represented revision before persisting intent or writing", async () => {
    const value = fixture();
    await expect(
      value.controller.merge({
        ...request(),
        expectedRevision: "2026-08-01T00:01:00.000Z",
      }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "stale" } });
    expect(value.operations.begin).not.toHaveBeenCalled();
    expect(value.merge).not.toHaveBeenCalled();
  });

  it("keeps uncertain remote outcomes durable and does not reject or replay them", async () => {
    const value = fixture({
      merge: err({ _tag: "GitHubMergeOutcomeUnknown" }),
    });
    await expect(value.controller.merge(request())).resolves.toEqual({
      _tag: "err",
      error: { reason: "merge_outcome_unknown" },
    });
    expect(value.operations.begin).toHaveBeenCalledTimes(1);
    expect(value.operations.markOutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(value.operations.reject).not.toHaveBeenCalled();
    expect(value.operations.removeAfterSessionReceipt).not.toHaveBeenCalled();
  });

  it("records finite rejection but retains no uncertain evidence", async () => {
    const value = fixture({
      merge: err({
        _tag: "MergeBlocked",
        readiness: {
          _tag: "Blocked",
          blockers: ["merge_blocked"],
          warnings: [],
        },
      }),
    });
    await expect(value.controller.merge(request())).resolves.toEqual({
      _tag: "err",
      error: { reason: "merge_blocked" },
    });
    expect(value.operations.reject).toHaveBeenCalledWith(
      expect.objectContaining({
        state: { _tag: "Rejected", reason: "merge_blocked" },
      }),
    );
    expect(value.operations.removeAfterSessionReceipt).not.toHaveBeenCalled();
  });

  it("saves a terminal Review before deleting confirmed merge evidence", async () => {
    const value = fixture({
      merge: ok({
        readiness: { _tag: "Ready", blockers: [], warnings: [] },
        mergeCommitSha: headSha,
      }),
    });
    await expect(value.controller.merge(request())).resolves.toMatchObject({
      _tag: "ok",
      value: { review: { status: { _tag: "Terminal", state: "merged" } } },
    });
    expect(value.operations.confirm).toHaveBeenCalledTimes(1);
    expect(value.reviews.save.mock.invocationCallOrder[0]).toBeLessThan(
      value.operations.removeAfterSessionReceipt.mock.invocationCallOrder[0] ??
        Infinity,
    );
  });

  it("retains confirmed evidence if terminal Review persistence fails", async () => {
    const value = fixture({
      merge: ok({ readiness: { _tag: "Ready", blockers: [], warnings: [] } }),
      // SAFETY: the controller maps this fixture-only storage error to merge_outcome_unknown.
      saveReview: err({ reason: "io" } as never),
    });
    await expect(value.controller.merge(request())).resolves.toEqual({
      _tag: "err",
      error: { reason: "merge_outcome_unknown" },
    });
    expect(value.operations.confirm).toHaveBeenCalledTimes(1);
    expect(value.operations.removeAfterSessionReceipt).not.toHaveBeenCalled();
  });

  it("rejects a concurrent merge under the same Review coordinator", async () => {
    const value = fixture();
    const key = `${profileId}:${reviewId}`;
    expect(value.coordinator.acquire(key)).toBe(true);
    await expect(value.controller.merge(request())).resolves.toEqual({
      _tag: "err",
      error: { reason: "merge_in_progress" },
    });
    value.coordinator.release(key);
    expect(value.writeGate.requireFresh).not.toHaveBeenCalled();
  });
});
