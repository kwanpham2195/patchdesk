import { describe, expect, it } from "vitest";

import { markMergeOutcomeUnknown, parseMergeOperation, requestMergeOperation } from "../../src/domain/merge-operation";

const operation = {
  operationId: "merge-20260801000000000",
  profileId: "cfw",
  reviewId: "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
  sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab",
  pr: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 },
  expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
  method: "squash",
  acknowledgedWarningCodes: [],
  startedAt: "2026-08-01T00:00:00.000Z",
};

describe("MergeOperation", () => {
  it("binds uncertain merge evidence to the owning Review", () => {
    const requested = requestMergeOperation(operation);
    expect(requested).toMatchObject({ _tag: "ok", value: { reviewId: operation.reviewId, state: { _tag: "Requested" } } });
    if (requested._tag === "ok") expect(markMergeOutcomeUnknown(requested.value)).toMatchObject({ _tag: "ok", value: { state: { _tag: "OutcomeUnknown" } } });
  });

  it("rejects old evidence without Review ownership", () => {
    expect(parseMergeOperation({ ...operation, reviewId: undefined })).toMatchObject({ _tag: "err" });
  });
});
