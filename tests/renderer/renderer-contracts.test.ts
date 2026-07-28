import { describe, expect, it } from "vitest";

import {
  parseModelCatalog,
  parseWalkthroughProjection,
  parseWorkbenchResponse,
} from "../../src/renderer/src/renderer-contracts";

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
  it("rejects lifecycle and attempt fields from the renderer recovery projection", () => {
    const prepared = parseWorkbenchResponse({
      state: "review_started",
      session: { ...sessionProjection, state: "ReviewFailed", lastRunFailure: "The review workflow did not complete.", currentAttemptId: "attempt-1" },
      recoveryView: { noticeKey: "review_failed", tone: "warning", actionKey: "try_again" },
      reviewedHeadSha: "2222222222222222222222222222222222222222",
      freshness: "fresh",
      refreshedAt: "2026-07-18T00:00:00.000Z",
      checks: { overall: "unknown", checks: [] },
    });
    expect(prepared).toBeUndefined();
  });

  it("accepts a display-safe recovery view", () => {
    const prepared = parseWorkbenchResponse({
      state: "review_started",
      session: sessionProjection,
      recoveryView: { noticeKey: "review_interrupted", tone: "warning", actionKey: "start_again" },
      reviewedHeadSha: "2222222222222222222222222222222222222222",
      freshness: "fresh",
      refreshedAt: "2026-07-18T00:00:00.000Z",
      checks: { overall: "unknown", checks: [] },
    });
    expect(prepared?.recoveryView).toEqual({ noticeKey: "review_interrupted", tone: "warning", actionKey: "start_again" });
  });

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

const walkthroughSnapshot = {
  profileId: "cfw",
  sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-22222222__abcdef123456",
  headSha: "2222222222222222222222222222222222222222",
  patchHash: "0000000000000000000000000000000000000000",
};

const walkthroughHunk = {
  id: "h1",
  path: "src/services/recovery/projection.ts",
  header: "@@ -42,7 +42,9 @@",
  raw: "@@ -42,7 +42,9 @@\n a\n-b\n+c\n+x\n",
  oldStart: 42,
  oldLines: 7,
  newStart: 42,
  newLines: 9,
};

const walkthroughProjectionFixture = {
  snapshot: walkthroughSnapshot,
  title: "Read-only walkthrough",
  focus: "What this change means for reviewers",
  chapters: [
    {
      id: "context",
      title: "Context",
      sections: [
        {
          id: "context-1",
          title: "Why this snapshot matters",
          prose: "Background context for the change.",
          hunkIds: ["h1"],
          hunks: [walkthroughHunk],
        },
      ],
    },
  ],
  support: { id: "support", title: "Support", hunkIds: [], hunks: [] },
};

describe("parseWalkthroughProjection", () => {
  it("accepts every renderer-safe lifecycle projection", () => {
    for (const projection of [
      { lifecycle: "idle", noticeKey: "walkthrough-idle" },
      { lifecycle: "generating", noticeKey: "walkthrough-generating" },
      { lifecycle: "ready", noticeKey: "walkthrough-ready", walkthrough: walkthroughProjectionFixture },
      { lifecycle: "failed", noticeKey: "walkthrough-failed", actionKey: "walkthrough-retry" },
      { lifecycle: "failed", noticeKey: "walkthrough-failed", actionKey: "walkthrough-retry", incidentId: "incident-1" },
      { lifecycle: "stale", noticeKey: "walkthrough-stale", actionKey: "walkthrough-regenerate" },
    ]) {
      expect(parseWalkthroughProjection(projection)).toBeDefined();
    }
  });

  it("rejects walkthrough projections whose hunk ids are not alphanumeric", () => {
    const projection = {
      lifecycle: "ready",
      noticeKey: "walkthrough-ready",
      walkthrough: {
        ...walkthroughProjectionFixture,
        chapters: [
          {
            id: "context",
            title: "Context",
            sections: [
              {
                id: "context-1",
                title: "Why this snapshot matters",
                prose: "Background",
                hunkIds: ["h1; DROP TABLE"],
                hunks: [walkthroughHunk],
              },
            ],
          },
        ],
      },
    };
    expect(parseWalkthroughProjection(projection)).toBeUndefined();
  });

  it("rejects walkthrough projections whose paths escape the repo", () => {
    const projection = {
      lifecycle: "ready",
      noticeKey: "walkthrough-ready",
      walkthrough: {
        ...walkthroughProjectionFixture,
        chapters: [
          {
            id: "context",
            title: "Context",
            sections: [
              {
                id: "context-1",
                title: "Why this snapshot matters",
                prose: "Background",
                hunkIds: ["h1"],
                hunks: [{ ...walkthroughHunk, path: "/etc/passwd" }],
              },
            ],
          },
        ],
      },
    };
    expect(parseWalkthroughProjection(projection)).toBeUndefined();
  });

  it("rejects walkthrough projections with non-integer or out-of-range line coordinates", () => {
    const projection = {
      lifecycle: "ready",
      noticeKey: "walkthrough-ready",
      walkthrough: {
        ...walkthroughProjectionFixture,
        chapters: [
          {
            id: "context",
            title: "Context",
            sections: [
              {
                id: "context-1",
                title: "Why this snapshot matters",
                prose: "Background",
                hunkIds: ["h1"],
                hunks: [{ ...walkthroughHunk, oldStart: -1 }],
              },
            ],
          },
        ],
      },
    };
    expect(parseWalkthroughProjection(projection)).toBeUndefined();
  });

  it("rejects walkthrough projections whose snapshot identity is malformed", () => {
    const projection = {
      lifecycle: "ready",
      noticeKey: "walkthrough-ready",
      walkthrough: {
        ...walkthroughProjectionFixture,
        snapshot: { ...walkthroughSnapshot, headSha: "deadbeef" },
      },
    };
    expect(parseWalkthroughProjection(projection)).toBeUndefined();
  });

  it("rejects walkthrough projections that smuggle attempt or path fields", () => {
    const projection = {
      lifecycle: "ready",
      noticeKey: "walkthrough-ready",
      walkthrough: {
        ...walkthroughProjectionFixture,
        chapters: [
          {
            id: "context",
            title: "Context",
            sections: [
              {
                id: "context-1",
                title: "Why this snapshot matters",
                prose: "Background",
                hunkIds: ["h1"],
                hunks: [{ ...walkthroughHunk, attemptId: "attempt-1", patchPath: "/tmp/leak" }],
              },
            ],
          },
        ],
      },
    };
    expect(parseWalkthroughProjection(projection)).toBeUndefined();
  });
});

describe("parseModelCatalog", () => {
  it("accepts a renderer-safe Pi catalog with a default model and reasoning", () => {
    const catalog = parseModelCatalog({
      models: [{ id: "model-a", label: "Model A" }],
      defaultModel: "model-a",
      defaultReasoning: "medium",
      reasoning: ["low", "medium", "high"],
    });
    expect(catalog?.models).toEqual([{ id: "model-a", label: "Model A" }]);
    expect(catalog?.defaultReasoning).toBe("medium");
  });

  it("rejects a catalog with no models", () => {
    expect(parseModelCatalog({ models: [] })).toBeUndefined();
  });

  it("rejects a catalog that includes non-string model ids", () => {
    expect(parseModelCatalog({ models: [{ id: 42, label: "Model" }] })).toBeUndefined();
  });

  it("rejects a catalog that includes an out-of-range reasoning value", () => {
    expect(parseModelCatalog({ models: [{ id: "model-a", label: "Model A" }], defaultReasoning: "extreme" })).toBeUndefined();
  });
});
