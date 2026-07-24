import { describe, expect, it } from "vitest";

import { parseWorkbenchResponse } from "../../src/renderer/src/renderer-contracts";

const sessionProjection = {
  id: "github.com__centraldigital__patchdesk__pr-42__sha-22222222__abcdef123456",
  key: {
    profileId: "cfw",
    host: "github.com",
    owner: "centraldigital",
    repo: "patchdesk",
    prNumber: 42,
    headSha: "2222222222222222222222222222222222222222",
  },
};

const completedProjection = {
  state: "completed",
  session: sessionProjection,
  result: { summary: "ok" },
  draft: { state: { _tag: "LocalDraft" } },
  comments: { threads: [] },
  checks: { overall: "passing", checks: [] },
  history: [],
  mergeReadiness: { _tag: "Blocked", blockers: ["stale_head"], warnings: [] },
  reviewScope: { kind: "full" },
  comparisonAvailability: "not_requested",
  reviewedHeadSha: "2222222222222222222222222222222222222222",
  freshness: "fresh",
  refreshedAt: "2026-07-18T00:00:00.000Z",
};

describe("parseWorkbenchResponse", () => {
  it("accepts the renderer-safe prepared and completed projections", () => {
    const prepared = parseWorkbenchResponse({
      state: "review_started",
      session: sessionProjection,
      reviewedHeadSha: "2222222222222222222222222222222222222222",
      freshness: "fresh",
      refreshedAt: "2026-07-18T00:00:00.000Z",
      checks: { overall: "unknown", checks: [] },
    });
    expect(prepared?.state).toBe("review_started");
    const completed = parseWorkbenchResponse(completedProjection);
    expect(completed?.state).toBe("completed");
  });

  it("accepts an incremental scope that carries no artifact paths", () => {
    const parsed = parseWorkbenchResponse({
      ...completedProjection,
      reviewScope: {
        kind: "incremental",
        baseSessionId: "github.com__centraldigital__patchdesk__pr-42__sha-11111111__000000000000",
        baseHeadSha: "1111111111111111111111111111111111111111",
        headSha: "2222222222222222222222222222222222222222",
      },
    });
    expect(parsed?.state).toBe("completed");
  });

  it("rejects every artifact-path-bearing field", () => {
    const pathFields = [
      "patchPath",
      "worktree",
      "comparisonPatchPath",
      "comparisonMetadataPath",
      "previousFindingsPath",
      "lifecyclePath",
    ];
    for (const field of pathFields) {
      const withSessionLeak = {
        ...completedProjection,
        session: { ...sessionProjection, [field]: "/tmp/secret" },
      };
      expect(parseWorkbenchResponse(withSessionLeak), field).toBeUndefined();
      const withScopeLeak = {
        ...completedProjection,
        reviewScope: {
          kind: "incremental",
          baseSessionId: "base",
          baseHeadSha: "1111111111111111111111111111111111111111",
          headSha: "2222222222222222222222222222222222222222",
          [field]: "/tmp/secret",
        },
      };
      expect(parseWorkbenchResponse(withScopeLeak), field).toBeUndefined();
    }
  });

  it("rejects a session that carries durable internals", () => {
    const withDraftContent = {
      ...completedProjection,
      session: { ...sessionProjection, draftContent: { state: { _tag: "LocalDraft" } } },
    };
    expect(parseWorkbenchResponse(withDraftContent)).toBeUndefined();
    const withState = {
      ...completedProjection,
      session: { ...sessionProjection, state: { _tag: "ReviewCompleted" } },
    };
    expect(parseWorkbenchResponse(withState)).toBeUndefined();
  });
});
