import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InsightStore } from "../../src/adapters/storage/insight-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import type { ReviewStore } from "../../src/adapters/storage/review-store";
import {
  createReviewSessionId,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseInsightRunId,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
  type ReviewId,
} from "../../src/domain/ids";
import type {
  InsightRecord,
  InsightType,
  RetainedInsightEnvelope,
} from "../../src/domain/insight-record";
import { createReview, type ReviewIdentity } from "../../src/domain/review";
import { err, ok, type Result } from "../../src/domain/result";
import { InsightRecovery } from "../../src/services/insight-recovery";
import type { ReviewDiagnosticService } from "../../src/services/review-diagnostic-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";

type ListResult = Awaited<ReturnType<ReviewStore["list"]>>;
type InsightLoadResult = Awaited<ReturnType<InsightStore["load"]>>;
type InsightMutateResult = Awaited<ReturnType<InsightStore["mutate"]>>;
type DiagnosticInput = Parameters<ReviewDiagnosticService["record"]>[0];
type DiagnosticResult = Awaited<ReturnType<ReviewDiagnosticService["record"]>>;

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}

const profileId = must(parseWorkspaceProfileId("cfw"));
const headSha = must(parseGitSha("1".repeat(40)));
const baseSha = must(parseGitSha("b".repeat(40)));
const patchHash = must(parseContentHash("a".repeat(64)));
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const identity: ReviewIdentity = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
};
const readable = createReview({
  identity,
  currentSessionId: createReviewSessionId({ ...identity, headSha, baseSha }),
  headSha,
  createdAt: now,
});
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A record whose run the crash left active, so recovery has work to do. */
function activeRun(
  reviewId: ReviewId,
  type: InsightType,
): InsightRecord<RetainedInsightEnvelope> {
  return {
    schemaVersion: 2,
    reviewId,
    type,
    nextToken: 2,
    activeRun: {
      id: must(parseInsightRunId(`insight-${type}-1-${"a".repeat(12)}-run`)),
      type,
      revision: {
        sessionId: readable.currentSessionId,
        headSha,
        patchHash,
      },
      token: 1,
      provider: "pi",
      model: "model",
      reasoning: "medium",
      status: "queued",
      startedAt: now,
    },
    updatedAt: now,
  };
}

async function fixture(listing: ListResult) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-insight-recovery-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  await mkdir(join(paths.dataProfilesDirectory(), profileId), {
    recursive: true,
  });

  const mutated: Array<{ reviewId: ReviewId; type: InsightType }> = [];
  const recorded: DiagnosticInput[] = [];
  const record = vi.fn(
    async (input: DiagnosticInput): Promise<DiagnosticResult> => {
      recorded.push(input);
      return err({ _tag: "ReviewDiagnosticStorageFailed" });
    },
  );
  const recovery = new InsightRecovery(
    {
      async list(): Promise<ListResult> {
        return listing;
      },
    },
    {
      async load(_profileId, reviewId, type): Promise<InsightLoadResult> {
        return ok(activeRun(reviewId, type));
      },
      async mutate(input): Promise<InsightMutateResult> {
        mutated.push({ reviewId: input.reviewId, type: input.type });
        return ok(activeRun(input.reviewId, input.type));
      },
    },
    paths,
    new ReviewOperationCoordinator(),
    new Map(),
    () => now,
    { record },
  );
  return { recovery, mutated, recorded };
}

describe("InsightRecovery.recoverAll", () => {
  it("reports an unreadable Review and still recovers the readable ones", async () => {
    const value = await fixture(ok({ reviews: [readable], unreadable: 1 }));

    await value.recovery.recoverAll();

    expect(value.recorded).toEqual([
      {
        profileId,
        category: "recovery",
        phase: "insight-recovery-failed",
        retryable: true,
        detail: "review_list_failed",
      },
    ]);
    expect(value.mutated).toEqual([
      { reviewId: readable.id, type: "analysis" },
      { reviewId: readable.id, type: "walkthrough" },
      { reviewId: readable.id, type: "brief" },
    ]);
  });

  it("records nothing when every Review in the profile is readable", async () => {
    const value = await fixture(ok({ reviews: [readable], unreadable: 0 }));

    await value.recovery.recoverAll();

    expect(value.recorded).toEqual([]);
    expect(value.mutated).toHaveLength(3);
  });

  it("reports a failed listing and recovers nothing in that profile", async () => {
    const value = await fixture(
      err({ _tag: "StorageFailure", operation: "read", reason: "io" }),
    );

    await value.recovery.recoverAll();

    expect(value.recorded).toMatchObject([{ detail: "review_list_failed" }]);
    expect(value.mutated).toEqual([]);
  });
});
