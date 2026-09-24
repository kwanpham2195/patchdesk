import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  InsightStore,
  parseInsightRecord,
} from "../../src/adapters/storage/insight-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  parseIsoTimestamp,
  parseReviewId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { setAnalysisVerificationStep } from "../../src/domain/insight-record";

const currentRecord = {
  schemaVersion: 2 as const,
  reviewId: "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
  type: "walkthrough" as const,
  nextToken: 3,
  retained: {
    runId:
      "insight-walkthrough-2-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
    revision: {
      sessionId:
        "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca",
      headSha: "a".repeat(40),
      patchHash: "b".repeat(64),
    },
    generatedAt: "2026-08-01T00:00:00.000Z",
    provenance: {
      provider: "pi" as const,
      model: "model",
      reasoning: "medium" as const,
    },
    value: { title: "Walkthrough" },
  },
  walkthroughProgress: {
    reviewedSectionIds: ["section-1", "section-2"],
    supportReviewed: true,
    currentSectionId: "section-2",
  },
  replacementFailure: {
    runId:
      "insight-walkthrough-1-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
    reason: "failed" as const,
    category: "execution_failed" as const,
    provider: "pi" as const,
    model: "model",
    reasoning: "medium" as const,
    retryable: true,
    failedAt: "2026-07-31T00:00:00.000Z",
  },
  updatedAt: "2026-08-01T00:01:00.000Z",
};

describe("InsightStore schema", () => {
  it("rejects schema 1 records", () => {
    expect(parseInsightRecord({ schemaVersion: 1 })._tag).toBe("err");
  });
  it("round-trips every current schema-2 retained and progress field", () => {
    expect(parseInsightRecord(currentRecord)).toEqual({
      _tag: "ok",
      value: currentRecord,
    });
  });

  it("accepts both existing runtime failures and the new worktree category", () => {
    const runtimeRecord = {
      ...currentRecord,
      replacementFailure: {
        ...currentRecord.replacementFailure,
        category: "runtime_unavailable" as const,
      },
    };
    const worktreeRecord = {
      ...currentRecord,
      replacementFailure: {
        ...currentRecord.replacementFailure,
        category: "review_worktree_unavailable" as const,
      },
    };

    expect(parseInsightRecord(runtimeRecord)).toEqual({
      _tag: "ok",
      value: runtimeRecord,
    });
    expect(parseInsightRecord(worktreeRecord)).toEqual({
      _tag: "ok",
      value: worktreeRecord,
    });
  });

  it("round-trips a Brief record", () => {
    const briefRecord = {
      schemaVersion: 2 as const,
      reviewId: "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
      type: "brief" as const,
      nextToken: 2,
      retained: {
        runId:
          "insight-brief-1-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
        revision: currentRecord.retained.revision,
        generatedAt: "2026-08-01T00:00:00.000Z",
        provenance: {
          provider: "pi" as const,
          model: "model",
          reasoning: "medium" as const,
        },
        value: { goal: [{ text: "Guards recovery.", citations: ["h1"] }] },
      },
      updatedAt: "2026-08-01T00:01:00.000Z",
    };
    expect(parseInsightRecord(briefRecord)).toEqual({
      _tag: "ok",
      value: briefRecord,
    });
  });

  it("rejects duplicate Walkthrough progress IDs instead of normalizing them", () => {
    expect(
      parseInsightRecord({
        ...currentRecord,
        walkthroughProgress: {
          ...currentRecord.walkthroughProgress,
          reviewedSectionIds: ["section-1", "section-1"],
        },
      })._tag,
    ).toBe("err");
  });

  it("rejects a record that is both running and failed", () => {
    const { replacementFailure, ...withoutFailure } = currentRecord;
    const running = {
      ...withoutFailure,
      activeRun: {
        id: "insight-walkthrough-3-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
        type: "walkthrough" as const,
        revision: currentRecord.retained.revision,
        token: 3,
        provider: "pi" as const,
        model: "model",
        reasoning: "medium" as const,
        status: "running" as const,
        startedAt: "2026-08-01T00:02:00.000Z",
      },
    };

    expect(parseInsightRecord(running)._tag).toBe("ok");
    expect(parseInsightRecord({ ...running, replacementFailure })).toEqual({
      _tag: "err",
      error: expect.objectContaining({ reason: "invalid_stored_value" }),
    });
  });

  it("rejects historical unavailable provenance", () => {
    expect(
      parseInsightRecord({
        schemaVersion: 2,
        provenance: { provider: "pi", configuration: "un" + "available" },
      })._tag,
    ).toBe("err");
  });
});

it("rejects schema-2 records without current failure provenance", () => {
  expect(
    parseInsightRecord({
      schemaVersion: 2,
      reviewId: "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
      type: "analysis",
      nextToken: 1,
      replacementFailure: {
        runId:
          "insight-analysis-1-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
        reason: "failed",
        retryable: true,
        failedAt: "2026-08-01T00:00:00.000Z",
      },
    })._tag,
  ).toBe("err");
});

describe("InsightStore Analysis Verification ticks", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });
  const profile = parseWorkspaceProfileId("acme");
  const review = parseReviewId(currentRecord.reviewId);
  const at = parseIsoTimestamp("2026-08-01T00:02:00.000Z");
  if (profile._tag === "err" || review._tag === "err" || at._tag === "err")
    throw new Error("invalid fixture ids");
  const { walkthroughProgress: _walkthroughOnly, ...walkthroughFree } =
    currentRecord;
  void _walkthroughOnly;
  const seed = { ...walkthroughFree, type: "analysis" as const };

  it("writes ticks atomically beside the retained Analysis and reads them back", async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-insight-store-"));
    const paths = PatchdeskPaths.forTest(root);
    const store = new InsightStore(paths);
    const seeded = parseInsightRecord(seed);
    if (seeded._tag === "err") throw new Error("invalid seed record");
    await store.save(profile.value, seeded.value);

    const saved = await store.mutate({
      profileId: profile.value,
      reviewId: review.value,
      type: "analysis",
      now: at.value,
      operation: (record) =>
        setAnalysisVerificationStep(
          record,
          { index: 1, count: 2 },
          true,
          at.value,
        ),
    });

    expect(saved).toMatchObject({
      _tag: "ok",
      value: { analysisVerification: { checkedStepIndexes: [1] } },
    });
    const file = paths.insightFile(profile.value, review.value, "analysis");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      analysisVerification: { checkedStepIndexes: [1] },
    });
    expect(await readdir(join(file, ".."))).toEqual(["analysis.json"]);
  });

  it("reads a record with duplicate ticked steps as invalid", async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-insight-store-"));
    const paths = PatchdeskPaths.forTest(root);
    const store = new InsightStore(paths);
    const seeded = parseInsightRecord(seed);
    if (seeded._tag === "err") throw new Error("invalid seed record");
    await store.save(profile.value, seeded.value);
    const file = paths.insightFile(profile.value, review.value, "analysis");
    await writeFile(
      file,
      JSON.stringify({
        ...seed,
        analysisVerification: { checkedStepIndexes: [0, 0] },
      }),
      "utf8",
    );

    expect(
      await store.load(profile.value, review.value, "analysis"),
    ).toMatchObject({
      _tag: "err",
      error: { reason: "invalid_stored_value" },
    });
  });
});
