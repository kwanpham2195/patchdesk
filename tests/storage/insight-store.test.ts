import { describe, expect, it } from "vitest";
import { parseInsightRecord } from "../../src/adapters/storage/insight-store";

const currentRecord = {
  schemaVersion: 2 as const,
  reviewId: "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
  type: "walkthrough" as const,
  nextToken: 3,
  retained: {
    runId:
      "insight-walkthrough-2-aaaaaaaaaaaa-github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
    revision: {
      sessionId:
        "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__b48f8e2e76ca",
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
      "insight-walkthrough-1-aaaaaaaaaaaa-github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
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
      reviewId:
        "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
      type: "analysis",
      nextToken: 1,
      replacementFailure: {
        runId:
          "insight-analysis-1-aaaaaaaaaaaa-github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
        reason: "failed",
        retryable: true,
        failedAt: "2026-08-01T00:00:00.000Z",
      },
    })._tag,
  ).toBe("err");
});
