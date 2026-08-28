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
import type {
  AnalysisMergePolicy,
  WorkspaceProfileConfig,
} from "../../src/domain/workspace-profile";
import type { StorageFailure } from "../../src/adapters/storage/json-file";
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

/**
 * One retained Analysis, described by the only things the merge gate reads:
 * the severity of its single Finding, whether that Finding was dismissed, and
 * whether the Analysis belongs to the revision being merged.
 */
type AnalysisFixture = {
  readonly severity: "P0" | "P1" | "P2" | "P3";
  readonly dismissed?: boolean;
  readonly patchHash?: string;
  readonly readFailure?: StorageFailure["reason"];
};

const analysisFindingId = "finding-1";

function analysisInsights(analysis: AnalysisFixture | undefined) {
  const loadTyped = async () => {
    if (analysis === undefined)
      return err({
        _tag: "StorageFailure",
        operation: "read",
        reason: "not_found",
      });
    if (analysis.readFailure !== undefined)
      return err({
        _tag: "StorageFailure",
        operation: "read",
        reason: analysis.readFailure,
      });
    const record = {
      schemaVersion: 2,
      reviewId,
      type: "analysis",
      nextToken: 1,
      retained: {
        runId: "insight-analysis-1-aaaaaaaaaaaa-x",
        revision: {
          sessionId,
          headSha: values.headSha,
          patchHash: analysis.patchHash ?? patchHash,
        },
        generatedAt: at,
        provenance: {
          provider: "pi",
          model: "test-model",
          reasoning: "medium",
        },
        value: {
          changeSummary: "one change",
          verdict: "comment",
          summary: "one finding",
          findings: [
            {
              id: analysisFindingId,
              severity: analysis.severity,
              title: "A finding",
              explanation: "why",
              confidence: "high",
              mappingStatus: "mapped",
            },
          ],
          validationPlan: [],
          assumptions: [],
        },
      },
      updatedAt: at,
    };
    return ok(
      analysis.dismissed === true
        ? {
            ...record,
            dismissals: [
              {
                findingId: analysisFindingId,
                reason: "not a real problem",
                dismissedAt: at,
              },
            ],
          }
        : record,
    );
  };
  // SAFETY: cast `as never` for the same reason the projection tests cast
  // their own `loadTyped` stand-ins: the real method is generic over the
  // caller's value parser, which this stub does not need -- it hands back an
  // already-shaped record, exactly as the store would after parsing.
  return { loadTyped } as never;
}

function fixture(
  options: {
    readonly saveReview?: SaveResult;
    readonly mergeResult?: GatewayMergeResult;
    readonly mergeability?: MergePolicySnapshot["mergeability"];
    readonly analysis?: AnalysisFixture;
    readonly analysisMergePolicy?: AnalysisMergePolicy;
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
  const profile: WorkspaceProfileConfig =
    options.analysisMergePolicy === undefined
      ? values.profile
      : { ...values.profile, analysisMergePolicy: options.analysisMergePolicy };
  const writeGate = new RecordingReviewWriteGate(
    profile,
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
    { reviews, insights: analysisInsights(options.analysis) },
    coordinator,
  );
  return {
    controller,
    coordinator,
    gateway,
    operations,
    profile,
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

  // The gate only ever saw an empty Finding list, because this controller --
  // the one production caller of `mergePullRequest` -- did not pass `result`.
  // Every Analysis merge rule the profile configures decided on nothing.
  it("refuses the merge when the profile blocks on an open high-severity Finding", async () => {
    const current = fixture({
      analysis: { severity: "P0" },
      analysisMergePolicy: "block",
    });
    await expect(current.controller.merge(request())).resolves.toEqual({
      _tag: "err",
      error: { reason: "merge_blocked" },
    });
    expect(current.gateway.mergeRequests).toHaveLength(0);
    expect(current.operations.rejected[0]?.state).toEqual({
      _tag: "Rejected",
      reason: "merge_blocked",
    });
  });

  // The badge counts a dismissed Finding as gone; the gate must agree, or the
  // maintainer is offered a merge that is then refused with an unexplained
  // failure.
  it("allows the merge when the only high-severity Finding was dismissed", async () => {
    const current = fixture({
      analysis: { severity: "P0", dismissed: true },
      analysisMergePolicy: "block",
    });
    await expect(current.controller.merge(request())).resolves.toMatchObject({
      _tag: "ok",
      value: { review: { status: { _tag: "Terminal", state: "merged" } } },
    });
    expect(current.gateway.mergeRequests).toHaveLength(1);
  });

  // Controls. Neither of the two rules above may fire for a reason it does not
  // own: a P2 is not high severity, and an Analysis from another patch is not
  // this merge's Analysis.
  it("allows the merge when the only open Finding is below high severity", async () => {
    const current = fixture({
      analysis: { severity: "P2" },
      analysisMergePolicy: "block",
    });
    await expect(current.controller.merge(request())).resolves.toMatchObject({
      _tag: "ok",
    });
    expect(current.gateway.mergeRequests).toHaveLength(1);
  });

  it("allows the merge when the open high-severity Finding is from another revision", async () => {
    const current = fixture({
      analysis: { severity: "P0", patchHash: "b".repeat(64) },
      analysisMergePolicy: "block",
    });
    await expect(current.controller.merge(request())).resolves.toMatchObject({
      _tag: "ok",
    });
    expect(current.gateway.mergeRequests).toHaveLength(1);
  });

  it("refuses to guess at Findings when the Analysis record cannot be read", async () => {
    const current = fixture({
      analysis: { severity: "P0", readFailure: "io" },
      analysisMergePolicy: "block",
    });
    await expect(current.controller.merge(request())).resolves.toEqual({
      _tag: "err",
      error: { reason: "storage_failed" },
    });
    expect(current.operations.begun).toHaveLength(0);
    expect(current.gateway.mergeRequests).toHaveLength(0);
  });

  it("reads a corrupt Analysis record as no Analysis, exactly as the Workbench does", async () => {
    const current = fixture({
      analysis: { severity: "P0", readFailure: "invalid_stored_value" },
      analysisMergePolicy: "block",
    });
    await expect(current.controller.merge(request())).resolves.toMatchObject({
      _tag: "ok",
    });
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
