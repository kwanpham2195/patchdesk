import { describe, expect, it, vi } from "vitest";

import {
  FakeGitHubAdapter,
  type FakeGitHubAdapterValues,
} from "../../src/adapters/github/fake-github-adapter";
import type { GitHubMergeWriter } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  parseContentHash,
  parseGitSha,
  type InvalidDomainValue,
  type WorkspaceProfileId,
} from "../../src/domain/ids";
import type { MergePolicySnapshot } from "../../src/domain/github-context";
import type { ReviewRemoteSnapshot } from "../../src/adapters/storage/review-remote-store";
import type { MergeOperation } from "../../src/domain/merge-operation";
import { err, ok, type Result } from "../../src/domain/result";
import type { Review } from "../../src/domain/review";
import {
  createReviewSession,
  type ReviewSession,
} from "../../src/domain/review-session";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { MergeOperationStore } from "../../src/adapters/storage/merge-operation-store";
import { MergeWriteController } from "../../src/services/merge-write-controller";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import type { ReviewStore } from "../../src/adapters/storage/review-store";
import { ReviewWriteGate } from "../../src/services/review-write-gate";
import {
  createReviewRefreshFixtureValues,
  type ReviewRefreshFixtureValues,
} from "./review-refresh-fixture";

const patch =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const unusedStoreRoot = "/tmp/patchdesk-merge-controller-store";

type MergeRequest = Parameters<GitHubMergeWriter["mergePullRequest"]>[0];
type GatewayMergeResult = Awaited<
  ReturnType<GitHubMergeWriter["mergePullRequest"]>
>;
type FreshResult = Awaited<ReturnType<ReviewWriteGate["requireFresh"]>>;
type SaveResult = Awaited<ReturnType<ReviewStore["save"]>>;
type TerminalWriteEffect = "review_saved" | "merge_receipt_removed";

const values = createReviewRefreshFixtureValues();
const profileId = values.profileId;
const reviewId = values.review.id;
const sessionId = values.session.id;
const at = values.at;
const patchHash = value(parseContentHash("a".repeat(64)));
const invalidBaseSha = value(parseGitSha("c".repeat(40)));

function value<T>(result: Result<T, InvalidDomainValue>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}

class RecordingMergeOperationStore extends MergeOperationStore {
  readonly begun: MergeOperation[] = [];
  readonly markedUnknown: MergeOperation[] = [];
  readonly confirmed: MergeOperation[] = [];
  readonly rejected: MergeOperation[] = [];
  readonly removed: Array<{
    readonly profileId: WorkspaceProfileId;
    readonly sessionId: MergeOperation["sessionId"];
  }> = [];

  constructor(private readonly terminalWriteEffects: TerminalWriteEffect[]) {
    super(PatchdeskPaths.forTest(unusedStoreRoot));
  }

  override async begin(
    operation: MergeOperation,
  ): Promise<Awaited<ReturnType<MergeOperationStore["begin"]>>> {
    this.begun.push(operation);
    return ok(undefined);
  }

  override async markOutcomeUnknown(
    operation: MergeOperation,
  ): Promise<Awaited<ReturnType<MergeOperationStore["markOutcomeUnknown"]>>> {
    this.markedUnknown.push(operation);
    return ok(undefined);
  }

  override async confirm(
    operation: MergeOperation,
  ): Promise<Awaited<ReturnType<MergeOperationStore["confirm"]>>> {
    this.confirmed.push(operation);
    return ok(undefined);
  }

  override async reject(
    operation: MergeOperation,
  ): Promise<Awaited<ReturnType<MergeOperationStore["reject"]>>> {
    this.rejected.push(operation);
    return ok(undefined);
  }

  override async removeAfterSessionReceipt(
    profileId: WorkspaceProfileId,
    sessionId: MergeOperation["sessionId"],
  ): Promise<
    Awaited<ReturnType<MergeOperationStore["removeAfterSessionReceipt"]>>
  > {
    this.removed.push({ profileId, sessionId });
    this.terminalWriteEffects.push("merge_receipt_removed");
    return ok(undefined);
  }
}

class RecordingGitHubAdapter extends FakeGitHubAdapter {
  readonly mergeRequests: MergeRequest[] = [];

  constructor(
    values: Partial<FakeGitHubAdapterValues>,
    private readonly mergeResult: GatewayMergeResult,
  ) {
    super(values);
  }

  override async mergePullRequest(
    input: MergeRequest,
  ): Promise<GatewayMergeResult> {
    this.mergeRequests.push(input);
    return this.mergeResult;
  }
}

class RecordingReviewWriteGate extends ReviewWriteGate {
  requireFreshCalls = 0;

  constructor(
    profile: WorkspaceProfileConfig,
    review: Review,
    session: ReviewSession,
    snapshot: ReviewRemoteSnapshot,
  ) {
    super(
      { load: async () => ok(profile) },
      { load: async () => ok(review) },
      { load: async () => ok(session) },
      { load: async () => ok(snapshot) },
      { load: async () => ok(undefined) },
    );
    this.profileValue = profile;
    this.reviewValue = review;
    this.sessionValue = session;
    this.snapshotValue = snapshot;
  }

  override async requireFresh(
    _profileId: WorkspaceProfileId,
    _reviewId: Review["id"],
    _expected?: Parameters<ReviewWriteGate["requireFresh"]>[2],
  ): Promise<FreshResult> {
    this.requireFreshCalls += 1;
    return ok({
      profile: this.profile,
      review: this.review,
      session: this.session,
      snapshot: this.snapshot,
    });
  }

  private get profile(): WorkspaceProfileConfig {
    return this.profileValue;
  }

  private get review(): Review {
    return this.reviewValue;
  }

  private get session(): ReviewSession {
    return this.sessionValue;
  }

  private get snapshot(): ReviewRemoteSnapshot {
    return this.snapshotValue;
  }

  private readonly profileValue: WorkspaceProfileConfig;
  private readonly reviewValue: Review;
  private readonly sessionValue: ReviewSession;
  private readonly snapshotValue: ReviewRemoteSnapshot;
}

function createMergePolicy(
  fixtureValues: ReviewRefreshFixtureValues,
  mergeability: MergePolicySnapshot["mergeability"],
): MergePolicySnapshot {
  return {
    pr: {
      host: fixtureValues.identity.host,
      owner: fixtureValues.identity.owner,
      repo: fixtureValues.identity.repo,
      number: fixtureValues.identity.prNumber,
    },
    headSha: fixtureValues.headSha,
    baseSha: fixtureValues.baseSha,
    isOpen: true,
    isDraft: false,
    mergeability,
    reviewDecision: "approved",
    checks: { overall: "passing", checks: [] },
    complete: true,
  };
}

function request() {
  return {
    profileId,
    reviewId,
    sessionId,
    expectedHeadSha: values.headSha,
    expectedBaseSha: values.baseSha,
    expectedPatchHash: patchHash,
    expectedRevision: at,
    method: "squash",
    acknowledgedWarnings: {
      revision: {
        headSha: values.headSha,
        baseSha: values.baseSha,
        patchHash,
      },
      warningCodes: [],
    },
  };
}

function fixture(
  options: {
    readonly saveReview?: SaveResult;
    readonly mergeResult?: GatewayMergeResult;
    readonly mergeability?: MergePolicySnapshot["mergeability"];
  } = {},
) {
  const session = createReviewSession({
    key: values.session.key,
    pr: values.session.pr,
    patchPath: values.session.patchPath,
    worktree: values.session.worktree,
    createdAt: values.session.createdAt,
  });
  const review: Review = {
    ...values.review,
    currentSessionId: session.id,
    freshness: { _tag: "Fresh" },
  };
  const terminalWriteEffects: TerminalWriteEffect[] = [];
  const operations = new RecordingMergeOperationStore(terminalWriteEffects);
  const loadReview = vi.fn(async () => ok(review));
  const saveReview = vi.fn(async (): Promise<SaveResult> => {
    terminalWriteEffects.push("review_saved");
    return options.saveReview ?? ok(undefined);
  });
  const reviews: Pick<ReviewStore, "load" | "save"> = {
    load: loadReview,
    save: saveReview,
  };
  const writeGate = new RecordingReviewWriteGate(
    values.profile,
    review,
    session,
    values.snapshot,
  );
  const currentPullRequest = {
    ...values.snapshot.pullRequest,
    changedFileCount: 1,
  };
  const gateway = new RecordingGitHubAdapter(
    {
      pullRequest: currentPullRequest,
      diff: patch,
      mergePolicy: createMergePolicy(
        values,
        options.mergeability ?? "mergeable",
      ),
    },
    options.mergeResult ?? ok({ mergeCommitSha: values.headSha }),
  );
  const coordinator = new ReviewOperationCoordinator();
  const controller = new MergeWriteController(
    gateway,
    ["squash"],
    () => at,
    operations,
    writeGate,
    reviews,
    coordinator,
  );
  return {
    controller,
    coordinator,
    gateway,
    operations,
    profile: values.profile,
    reviews,
    saveReview,
    session,
    terminalWriteEffects,
    headSha: values.headSha,
    writeGate,
  };
}

describe("MergeWriteController", () => {
  it("rejects malformed input before acquiring the shared write boundary", async () => {
    const current = fixture();
    await expect(
      current.controller.merge({ method: "delete" }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "invalid_input" } });
    expect(current.writeGate.requireFreshCalls).toBe(0);
    expect(current.operations.begun).toHaveLength(0);
    expect(current.gateway.mergeRequests).toHaveLength(0);
  });

  it("binds acknowledgement to the exact represented base, head, and patch", async () => {
    const current = fixture();
    const invalid = {
      ...request(),
      acknowledgedWarnings: {
        revision: {
          headSha: values.headSha,
          baseSha: invalidBaseSha,
          patchHash,
        },
        warningCodes: [],
      },
    };
    await expect(current.controller.merge(invalid)).resolves.toEqual({
      _tag: "err",
      error: { reason: "invalid_input" },
    });
    expect(current.operations.begun).toHaveLength(0);
    expect(current.gateway.mergeRequests).toHaveLength(0);
  });

  it("rejects a stale represented revision before persisting intent or writing", async () => {
    const current = fixture();
    await expect(
      current.controller.merge({
        ...request(),
        expectedRevision: "2026-08-01T00:01:00.000Z",
      }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "stale" } });
    expect(current.operations.begun).toHaveLength(0);
    expect(current.gateway.mergeRequests).toHaveLength(0);
  });

  it("keeps uncertain remote outcomes durable and does not reject or replay them", async () => {
    const mergeUnavailable: GatewayMergeResult = err({
      _tag: "GitHubWriteFailure",
      category: "unavailable",
      message: "merge unavailable",
    });
    const current = fixture({ mergeResult: mergeUnavailable });
    await expect(current.controller.merge(request())).resolves.toEqual({
      _tag: "err",
      error: { reason: "merge_outcome_unknown" },
    });
    expect(current.operations.begun).toHaveLength(1);
    expect(current.operations.markedUnknown).toHaveLength(1);
    expect(current.operations.rejected).toHaveLength(0);
    expect(current.operations.removed).toHaveLength(0);
    expect(current.gateway.mergeRequests).toHaveLength(1);
  });

  it("records finite rejection but retains no uncertain evidence", async () => {
    const current = fixture({ mergeability: "blocked" });
    await expect(current.controller.merge(request())).resolves.toEqual({
      _tag: "err",
      error: { reason: "merge_blocked" },
    });
    expect(current.operations.rejected[0]?.state).toEqual({
      _tag: "Rejected",
      reason: "merge_blocked",
    });
    expect(current.operations.removed).toHaveLength(0);
    expect(current.gateway.mergeRequests).toHaveLength(0);
  });

  it("saves a terminal Review before deleting confirmed merge evidence", async () => {
    const current = fixture();
    await expect(current.controller.merge(request())).resolves.toMatchObject({
      _tag: "ok",
      value: { review: { status: { _tag: "Terminal", state: "merged" } } },
    });
    expect(current.operations.confirmed).toHaveLength(1);
    expect(current.operations.removed).toHaveLength(1);
    expect(current.terminalWriteEffects).toEqual([
      "review_saved",
      "merge_receipt_removed",
    ]);
    expect(current.gateway.mergeRequests[0]).toMatchObject({
      profile: current.profile,
      pr: {
        host: current.session.key.host,
        owner: current.session.key.owner,
        repo: current.session.key.repo,
        number: current.session.key.prNumber,
      },
      headSha: current.headSha,
      method: "squash",
    });
  });

  it("retains confirmed evidence if terminal Review persistence fails", async () => {
    const saveFailure: SaveResult = err({
      _tag: "ReviewConflict",
      reason: "stale_revision",
    });
    const current = fixture({ saveReview: saveFailure });
    await expect(current.controller.merge(request())).resolves.toEqual({
      _tag: "err",
      error: { reason: "merge_outcome_unknown" },
    });
    expect(current.operations.confirmed).toHaveLength(1);
    expect(current.operations.removed).toHaveLength(0);
    expect(current.gateway.mergeRequests).toHaveLength(1);
  });

  it("rejects a concurrent merge under the same Review coordinator", async () => {
    const current = fixture();
    const key = `${profileId}:${reviewId}`;
    expect(current.coordinator.acquire(key)).toBe(true);
    await expect(current.controller.merge(request())).resolves.toEqual({
      _tag: "err",
      error: { reason: "merge_in_progress" },
    });
    current.coordinator.release(key);
    expect(current.writeGate.requireFreshCalls).toBe(0);
    expect(current.gateway.mergeRequests).toHaveLength(0);
  });
});
