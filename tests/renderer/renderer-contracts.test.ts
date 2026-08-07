import { describe, expect, it } from "vitest";

import {
  parseCommitDiffResponse,
  parseModelCatalog,
  parseWalkthroughProjection,
  parseWorkbenchResponse,
} from "../../src/renderer/src/renderer-contracts";
import { normalizeNarrativeWalkthrough } from "../../src/domain/narrative-walkthrough";
import {
  parseContentHash,
  parseGitSha,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";

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

const reviewProjection = {
  state: "review",
  review: { id: "github.com__centraldigital__patchdesk__pr-42__review-abcdef123456", status: "open" },
  session: sessionProjection,
  revision: {
    reviewedHeadSha: "2222222222222222222222222222222222222222",
    freshness: "fresh",
    refreshedAt: "2026-07-18T00:00:00.000Z",
  },
  commits: [],
  insights: {
    analysis: { status: "not_generated" },
    walkthrough: { status: "not_generated" },
  },
  conversation: { prDescription: "", entries: [] },
  checks: { overall: "passing", checks: [] },
  mergeReadiness: { _tag: "Blocked", blockers: ["stale_head"], warnings: [] },
};

function must<T>(
  result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" },
): T {
  if (result._tag === "err") throw new Error("fixture parse failed");
  return result.value;
}

describe("commit diff response", () => {
  it("parses bounded data and rejects unknown fields", () => {
    const valid = parseCommitDiffResponse({
      commit: { sha: "1".repeat(40), message: "Commit", author: "Author", authoredAt: "2026-08-01T00:00:00.000Z", isHead: true },
      position: 1,
      total: 1,
      patch: "diff --git a/file.ts b/file.ts",
      fileCount: 1,
      additions: 1,
      deletions: 0,
    });
    expect(valid?.position).toBe(1);
    expect(parseCommitDiffResponse({
      commit: { sha: "1".repeat(40), message: "Commit", author: "Author", authoredAt: "2026-08-01T00:00:00.000Z", isHead: true, prompt: "secret" },
      position: 1,
      total: 1,
      patch: "",
      fileCount: 0,
      additions: 0,
      deletions: 0,
    })).toBeUndefined();
  });
});

describe("parseWorkbenchResponse", () => {
  it("accepts one strict review projection", () => {
    expect(parseWorkbenchResponse(reviewProjection)).toMatchObject({ state: "review" });
  });

  it("accepts Patchdesk-owned Finding dispositions", () => {
    const projection = {
      ...reviewProjection,
      insights: {
        ...reviewProjection.insights,
        analysis: {
          status: "current" as const,
          retained: {
            runId: "insight-analysis-1-aaaaaaaaaaaa-review-abcdef123456",
            sessionId: sessionProjection.id,
            headSha: sessionProjection.key.headSha,
            generatedAt: "2026-07-18T00:00:00.000Z",
            value: {
              changeSummary: "A change",
              verdict: "comment" as const,
              summary: "A finding",
              findings: [{ id: "finding-1", severity: "P1" as const, title: "Guard", explanation: "Missing guard.", confidence: "high" as const, mappingStatus: "mapped" as const, disposition: "dismissed" as const }],
              validationPlan: [],
              assumptions: [],
            },
          },
        },
      },
    };
    expect(parseWorkbenchResponse(projection)?.insights.analysis.retained?.value.findings[0]?.disposition).toBe("dismissed");
  });

  it("rejects paths, worktree data, provider events, prompt text, and raw errors", () => {
    for (const field of ["patchPath", "worktree", "contextPath", "providerEvent", "prompt", "errorDetail"]) {
      expect(parseWorkbenchResponse({ ...reviewProjection, [field]: "/tmp/secret" }), field).toBeUndefined();
    }
    expect(parseWorkbenchResponse({
      ...reviewProjection,
      session: { ...sessionProjection, worktree: "/tmp/secret" },
    })).toBeUndefined();
  });

  it("rejects forbidden or unknown fields at every nested projection boundary", () => {
    const legalCheck = {
      name: "CI",
      required: true,
      status: "completed",
      conclusion: "success",
    };
    const legalComment = {
      id: "comment-1",
      author: "reviewer",
      body: "Looks good",
      createdAt: "2026-07-18T00:00:00.000Z",
    };
    const legalThread = {
      id: "thread-1",
      state: "open",
      comments: [legalComment],
    };
    const legalResult = {
      changeSummary: "A safe change",
      verdict: "comment",
      summary: "One comment",
      findings: [],
      validationPlan: [],
      assumptions: [],
    };
    const legalDraft = {
      sessionId: sessionProjection.id,
      state: { _tag: "Local" },
      summaryBody: "Draft",
      suggestedEvent: "COMMENT",
      items: [],
      receipts: [],
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    };

    expect(parseWorkbenchResponse({
      ...reviewProjection,
      checks: { overall: "passing", checks: [{ ...legalCheck, providerEvent: "raw" }] },
    })).toBeUndefined();
    expect(parseWorkbenchResponse({
      ...reviewProjection,
      conversation: { prDescription: "", entries: [{ _tag: "GeneralThread", thread: { ...legalThread, comments: [{ ...legalComment, prompt: "secret" }] } }] },
    })).toBeUndefined();
    expect(parseWorkbenchResponse({
      ...reviewProjection,
      insights: {
        analysis: {
          status: "current",
          retained: {
            sessionId: sessionProjection.id,
            headSha: sessionProjection.key.headSha,
            generatedAt: "2026-07-18T00:00:00.000Z",
            value: { ...legalResult, error: { stack: "secret" } },
          },
        },
        walkthrough: { status: "not_generated" },
      },
    })).toBeUndefined();
    expect(parseWorkbenchResponse({
      ...reviewProjection,
      draft: { ...legalDraft, items: [{ _tag: "ThreadReply", id: "item-1", provenance: { _tag: "human" }, threadId: "thread-1", body: "reply", include: true, localPath: "/tmp/secret" }] },
    })).toBeUndefined();
    expect(parseWorkbenchResponse({
      ...reviewProjection,
      conversation: {
        prDescription: "",
        entries: [{ _tag: "IssueComment", comment: { ...legalComment, prompt: "secret" } }],
      },
    })).toBeUndefined();

    expect(parseWorkbenchResponse({
      ...reviewProjection,
      checks: { overall: "passing", checks: [legalCheck] },
      conversation: {
        prDescription: "A PR description",
        entries: [{ _tag: "IssueComment", comment: { ...legalComment } }],
      },
      commits: [{
        sha: sessionProjection.key.headSha,
        message: "A legal commit",
        author: "author",
        authoredAt: "2026-07-18T00:00:00.000Z",
        isHead: true,
      }],
      insights: {
        analysis: {
          status: "current",
          retained: {
            sessionId: sessionProjection.id,
            headSha: sessionProjection.key.headSha,
            generatedAt: "2026-07-18T00:00:00.000Z",
            value: legalResult,
          },
        },
        walkthrough: { status: "not_generated" },
      },
      draft: legalDraft,
    })).toBeDefined();
  });
});

const walkthroughSnapshot = {
  profileId: "cfw",
  sessionId:
    "github.com__centraldigital__patchdesk__pr-42__sha-22222222__abcdef123456",
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
  citationVersion: 2,
  citationStatus: "verified",
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
      {
        lifecycle: "ready",
        noticeKey: "walkthrough-ready",
        walkthrough: walkthroughProjectionFixture,
      },
      {
        lifecycle: "failed",
        noticeKey: "walkthrough-failed",
        actionKey: "walkthrough-retry",
      },
      {
        lifecycle: "failed",
        noticeKey: "walkthrough-failed",
        actionKey: "walkthrough-retry",
        incidentId: "incident-1",
      },
      {
        lifecycle: "stale",
        noticeKey: "walkthrough-stale",
        actionKey: "walkthrough-regenerate",
      },
    ]) {
      expect(parseWalkthroughProjection(projection)).toBeDefined();
    }
  });

  it("accepts a ready projection emitted from a valid long repository path", () => {
    const path = `src/${"x".repeat(1_000)}.ts`;
    const snapshot = {
      profileId: must(parseWorkspaceProfileId("cfw")),
      sessionId: must(
        parseReviewSessionId(
          "github.com__centraldigital__patchdesk__pr-42__sha-22222222__abcdef123456",
        ),
      ),
      headSha: must(parseGitSha("2222222222222222222222222222222222222222")),
      patchHash: must(parseContentHash("a".repeat(64))),
    };
    const patch = [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,1 +1,1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const normalized = normalizeNarrativeWalkthrough(
      {
        title: "Long path walkthrough",
        focus: "The walkthrough still reaches the renderer.",
        snapshot,
        chapters: [
          {
            title: "Change",
            sections: [
              {
                title: "Update",
                prose: "A legal patch changes one line.",
                hunkIds: ["h1"],
              },
            ],
          },
        ],
      },
      patch,
      snapshot,
    );

    expect(normalized._tag).toBe("ok");
    if (normalized._tag === "err") return;
    expect(
      parseWalkthroughProjection({
        lifecycle: "ready",
        noticeKey: "walkthrough-ready",
        walkthrough: normalized.value,
      }),
    ).toBeDefined();
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
                hunks: [
                  {
                    ...walkthroughHunk,
                    attemptId: "attempt-1",
                    patchPath: "/tmp/leak",
                  },
                ],
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

  it("accepts an intentional empty catalog for provider guidance", () => {
    expect(parseModelCatalog({ models: [] })).toEqual({ models: [] });
  });

  it("accepts the complete universal catalog without a small count cap", () => {
    const models = Array.from({ length: 269 }, (_, index) => ({
      id: `openai/universal-model-${index}`,
      label: `Universal model ${index}`,
    }));
    const catalog = parseModelCatalog({ models });
    expect(catalog?.models).toHaveLength(269);
    expect(catalog?.models.at(-1)).toEqual(models.at(-1));
  });

  it("keeps model entries strict and rejects credential fields", () => {
    expect(
      parseModelCatalog({
        models: [{ id: "model-a", label: "Model A", apiKey: "secret" }],
      }),
    ).toBeUndefined();
    expect(
      parseModelCatalog({ models: [{ id: "i".repeat(201), label: "Model" }] }),
    ).toBeUndefined();
    expect(
      parseModelCatalog({ models: [{ id: "model-a", label: "l".repeat(201) }] }),
    ).toBeUndefined();
  });

  it("rejects a catalog that includes non-string model ids", () => {
    expect(
      parseModelCatalog({ models: [{ id: 42, label: "Model" }] }),
    ).toBeUndefined();
  });

  it("rejects a catalog that includes an out-of-range reasoning value", () => {
    expect(
      parseModelCatalog({
        models: [{ id: "model-a", label: "Model A" }],
        defaultReasoning: "extreme",
      }),
    ).toBeUndefined();
  });
});
