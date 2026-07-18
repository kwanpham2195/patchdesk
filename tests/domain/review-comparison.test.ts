import { describe, expect, it } from "vitest";

import { parseReviewScope } from "../../src/domain/review-comparison";

const sessionId = "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab";
const sha = "abcdef1234567890abcdef1234567890abcdef12";

describe("review comparison domain", () => {
  it("parses a complete incremental scope with only app-owned absolute paths", () => {
    const scope = parseReviewScope({
      kind: "incremental",
      baseSessionId: sessionId,
      baseHeadSha: sha,
      headSha: sha,
      comparisonPatchPath: "/tmp/comparison.diff",
      comparisonMetadataPath: "/tmp/comparison.json",
      previousFindingsPath: "/tmp/previous-findings.json",
      lifecyclePath: "/tmp/finding-lifecycle.json",
    });

    expect(scope).toMatchObject({ _tag: "ok", value: { kind: "incremental" } });
    if (scope._tag === "err") return;
    if (scope.value.kind !== "incremental") return;
    expect(scope.value.baseSessionId).toBe(sessionId);
    expect(scope.value.comparisonPatchPath).toBe("/tmp/comparison.diff");
    expect(scope.value.baseHeadSha).toBe(sha);
  });

  it("rejects relative artifact paths and missing incremental fields", () => {
    expect(parseReviewScope({ kind: "incremental", baseSessionId: sessionId })).toMatchObject({ _tag: "err" });
    expect(parseReviewScope({
      kind: "incremental",
      baseSessionId: sessionId,
      baseHeadSha: sha,
      headSha: sha,
      comparisonPatchPath: "comparison.diff",
      comparisonMetadataPath: "/tmp/comparison.json",
      previousFindingsPath: "/tmp/previous-findings.json",
      lifecyclePath: "/tmp/finding-lifecycle.json",
    })).toMatchObject({ _tag: "err" });
  });

  it("accepts a full scope without comparison artifacts", () => {
    expect(parseReviewScope({ kind: "full" })).toEqual({ _tag: "ok", value: { kind: "full" } });
  });
});
