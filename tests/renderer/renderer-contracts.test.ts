import { describe, expect, it } from "vitest";

import {
  parseInsightProviderCatalog,
  parseModelCatalog,
} from "../../src/renderer/src/insight-catalog-contracts";
import {
  parseCommitDiffResponse,
  parseInboxResponse,
  parseMergeReceipt,
  parseRepositoryLabelListResponse,
  parseWorkbenchResponse,
} from "../../src/renderer/src/renderer-contracts";

const sessionProjection = {
  id: "github.com__centraldigital__patchdesk__pr-42__sha-22222222__base-00000000__abcdef123456",
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
  viewerLogin: "fixture",
  review: {
    id: "github.com__centraldigital__patchdesk__pr-42__review-abcdef123456",
    status: "open",
  },
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

describe("parseInboxResponse", () => {
  const response = {
    profile: {
      id: "cfw",
      label: "Profile",
      githubHost: "github.com",
      ghAccount: "fixture",
    },
    inbox: {
      state: "merged" as const,
      pageSize: 25 as const,
      rows: [],
      repositories: [],
      dataFreshness: "fresh" as const,
      // GitHub's repository-wide match count (`issueCount`), distinct from
      // `rows.length`. `inboxResponseSchema` is a `v.strictObject`, so this
      // field is silently dropped at parse time if it is ever removed from
      // the schema — that trap is exactly what this test guards.
      matchCount: 237,
    },
  };

  it("carries matchCount, GitHub's repository-wide match count, across the IPC boundary", () => {
    const parsed = parseInboxResponse(response);
    expect(parsed?.inbox.matchCount).toBe(237);
  });

  it("omits matchCount when the source response has none, rather than inventing a value", () => {
    const { matchCount, ...inboxWithoutMatchCount } = response.inbox;
    void matchCount;
    const parsed = parseInboxResponse({
      ...response,
      inbox: inboxWithoutMatchCount,
    });
    expect(parsed).toBeDefined();
    expect(parsed?.inbox.matchCount).toBeUndefined();
  });

  it("carries a watched repository's localPath across the IPC boundary", () => {
    const parsed = parseInboxResponse({
      ...response,
      profile: {
        ...response.profile,
        repos: [
          {
            host: "github.com",
            owner: "centraldigital",
            repo: "cfw-sales-crm-api",
            localPath: "/Users/kwanpham/Work/cfw/cfw-sales-crm-api",
          },
        ],
      },
    });
    expect(parsed?.profile.repos?.[0]?.localPath).toBe(
      "/Users/kwanpham/Work/cfw/cfw-sales-crm-api",
    );
  });

  it("still parses a watched repository with no localPath, the main process's shape for a repo with no local checkout", () => {
    const parsed = parseInboxResponse({
      ...response,
      profile: {
        ...response.profile,
        repos: [
          {
            host: "github.com",
            owner: "centraldigital",
            repo: "cfw-bo-customer-management-service",
          },
        ],
      },
    });
    expect(parsed?.profile.repos?.[0]?.localPath).toBeUndefined();
  });

  const insightRow = {
    remoteState: "open" as const,
    identity: {
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number: 42,
    },
    title: "Guard duplicate input",
    author: "author",
    baseBranch: "sit",
    headBranch: "feature/duplicate-guard",
    currentHeadSha: "2222222222222222222222222222222222222222",
    isDraft: false,
    updatedAt: "2026-07-18T00:00:00.000Z",
    changeStats: {},
    checks: { overall: "passing" as const, checks: [] },
    reviewState: "none" as const,
    mergeability: "unknown" as const,
    labels: [],
    categories: [],
    recommendedAction: { kind: "run_review" as const },
    dataFreshness: "fresh" as const,
  };

  it("carries every Insight kind's readiness across the IPC boundary", () => {
    const parsed = parseInboxResponse({
      ...response,
      inbox: {
        ...response.inbox,
        rows: [
          {
            ...insightRow,
            insights: {
              brief: "ready",
              analysis: "outdated",
              walkthrough: "ready",
            },
          },
        ],
      },
    });
    expect(parsed?.inbox.rows[0]?.insights).toEqual({
      brief: "ready",
      analysis: "outdated",
      walkthrough: "ready",
    });
  });

  it("refuses a row whose Insight readiness names a state Patchdesk does not have", () => {
    const parsed = parseInboxResponse({
      ...response,
      inbox: {
        ...response.inbox,
        rows: [{ ...insightRow, insights: { brief: "running" } }],
      },
    });
    expect(parsed).toBeUndefined();
  });
});

describe("parseRepositoryLabelListResponse", () => {
  it("reaches the renderer with a successful fetch's labels and total intact", () => {
    const parsed = parseRepositoryLabelListResponse({
      state: "ready",
      labels: [
        { id: "LA_bug", name: "bug", color: "d73a4a" },
        { id: "LA_docs", name: "documentation", color: "0075ca" },
      ],
      totalCount: 2,
    });
    expect(parsed).toEqual({
      state: "ready",
      labels: [
        { id: "LA_bug", name: "bug", color: "d73a4a" },
        { id: "LA_docs", name: "documentation", color: "0075ca" },
      ],
      totalCount: 2,
    });
  });

  it("conveys truncation via totalCount rather than dropping it", () => {
    const parsed = parseRepositoryLabelListResponse({
      state: "ready",
      labels: [{ id: "LA_bug", name: "bug", color: "d73a4a" }],
      totalCount: 150,
    });
    expect(parsed?.totalCount).toBe(150);
    expect(parsed?.labels).toHaveLength(1);
  });

  it("surfaces a forbidden read's specific reason", () => {
    const parsed = parseRepositoryLabelListResponse({
      state: "github_forbidden",
      forbiddenReason: "saml",
    });
    expect(parsed).toEqual({
      state: "github_forbidden",
      forbiddenReason: "saml",
    });
  });

  it("surfaces a rate-limited read's resume time", () => {
    const parsed = parseRepositoryLabelListResponse({
      state: "github_rate_limited",
      resumeAt: "2026-01-01T01:00:00.000Z",
    });
    expect(parsed).toEqual({
      state: "github_rate_limited",
      resumeAt: "2026-01-01T01:00:00.000Z",
    });
  });

  it("rejects an unrecognized state and unknown fields", () => {
    expect(
      parseRepositoryLabelListResponse({ state: "not_a_real_state" }),
    ).toBeUndefined();
    expect(
      parseRepositoryLabelListResponse({
        state: "ready",
        labels: [],
        totalCount: 0,
        extra: "nope",
      }),
    ).toBeUndefined();
  });
});

describe("commit diff response", () => {
  it("parses provider catalogs and rejects paths or raw diagnostics", () => {
    expect(
      parseInsightProviderCatalog({
        providers: [
          {
            id: "codex-cli-account",
            label: "Codex CLI account",
            available: true,
            guidance: "Load models explicitly.",
          },
        ],
        models: [
          {
            provider: "codex-cli-account",
            id: "fixture",
            label: "Fixture",
            reasoning: ["low"],
            defaultReasoning: "low",
          },
        ],
      }),
    ).toBeDefined();
    expect(
      parseInsightProviderCatalog({
        providers: [
          {
            id: "codex-cli-account",
            label: "Codex CLI account",
            available: true,
            guidance: "/Users/private",
          },
        ],
        models: [],
      }),
    ).toBeUndefined();
  });

  it("parses bounded data and rejects unknown fields", () => {
    const valid = parseCommitDiffResponse({
      commit: {
        sha: "1".repeat(40),
        message: "Commit",
        author: "Author",
        authoredAt: "2026-08-01T00:00:00.000Z",
        isHead: true,
      },
      position: 1,
      total: 1,
      patch: "diff --git a/file.ts b/file.ts",
      fileCount: 1,
      additions: 1,
      deletions: 0,
    });
    expect(valid?.position).toBe(1);
    expect(
      parseCommitDiffResponse({
        commit: {
          sha: "1".repeat(40),
          message: "Commit",
          author: "Author",
          authoredAt: "2026-08-01T00:00:00.000Z",
          isHead: true,
          prompt: "secret",
        },
        position: 1,
        total: 1,
        patch: "",
        fileCount: 0,
        additions: 0,
        deletions: 0,
      }),
    ).toBeUndefined();
  });
});

describe("parseWorkbenchResponse", () => {
  it("accepts one strict review projection", () => {
    expect(parseWorkbenchResponse(reviewProjection)).toMatchObject({
      state: "review",
    });
  });

  it("requires a bounded safe GitHub login for viewerLogin", () => {
    const maximum = "a".repeat(39);
    expect(
      parseWorkbenchResponse({ ...reviewProjection, viewerLogin: maximum }),
    ).toMatchObject({ viewerLogin: maximum });
    expect(
      parseWorkbenchResponse({
        ...reviewProjection,
        viewerLogin: `${maximum}a`,
      }),
    ).toBeUndefined();
    expect(
      parseWorkbenchResponse({
        ...reviewProjection,
        viewerLogin: "invalid/login",
      }),
    ).toBeUndefined();
  });

  it("strictly parses bounded remote-write recovery", () => {
    expect(
      parseWorkbenchResponse({
        ...reviewProjection,
        remoteWriteRecovery: {
          operation: "DeleteComment",
          resolution: "manual_resolution_required",
        },
      })?.remoteWriteRecovery,
    ).toEqual({
      operation: "DeleteComment",
      resolution: "manual_resolution_required",
    });
    for (const operation of [
      "EditPublishedComment",
      "DeletePublishedComment",
      "DismissPublishedReview",
    ] as const) {
      expect(
        parseWorkbenchResponse({
          ...reviewProjection,
          remoteWriteRecovery: { operation, resolution: "check_required" },
        })?.remoteWriteRecovery,
      ).toEqual({ operation, resolution: "check_required" });
    }
    for (const remoteWriteRecovery of [
      { operation: "UnknownWrite", resolution: "check_required" },
      { operation: "Reply", resolution: "retry_allowed" },
      {
        operation: "Reply",
        resolution: "check_required",
        rawError: "secret",
      },
    ]) {
      expect(
        parseWorkbenchResponse({
          ...reviewProjection,
          remoteWriteRecovery,
        }),
      ).toBeUndefined();
    }
  });

  it("accepts a pull request summary carrying a GraphQL nodeId", () => {
    const projection = {
      ...reviewProjection,
      pullRequest: {
        ref: {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
          number: 42,
        },
        title: "Add nodeId to the pull request domain type",
        nodeId: "PR_kwDOOxMYd87hgCZR",
        author: "octocat",
        headBranch: "feature",
        baseBranch: "main",
        headSha: sessionProjection.key.headSha,
        isDraft: false,
        isOpen: true,
        reviewState: "none" as const,
        mergeability: "mergeable" as const,
        labels: [],
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    };
    const parsed = parseWorkbenchResponse(projection);
    expect(parsed).toBeDefined();
    expect(parsed?.pullRequest?.nodeId).toBe("PR_kwDOOxMYd87hgCZR");
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
              findings: [
                {
                  id: "finding-1",
                  severity: "P1" as const,
                  title: "Guard",
                  explanation: "Missing guard.",
                  confidence: "high" as const,
                  mappingStatus: "mapped" as const,
                  disposition: "dismissed" as const,
                },
              ],
              validationPlan: [],
              assumptions: [],
            },
          },
        },
      },
    };
    expect(
      parseWorkbenchResponse(projection)?.insights.analysis.retained?.value
        .findings[0]?.disposition,
    ).toBe("dismissed");
  });

  it("rejects paths, worktree data, provider events, prompt text, and raw errors", () => {
    for (const field of [
      "patchPath",
      "worktree",
      "contextPath",
      "providerEvent",
      "prompt",
      "errorDetail",
    ]) {
      expect(
        parseWorkbenchResponse({ ...reviewProjection, [field]: "/tmp/secret" }),
        field,
      ).toBeUndefined();
    }
    expect(
      parseWorkbenchResponse({
        ...reviewProjection,
        session: { ...sessionProjection, worktree: "/tmp/secret" },
      }),
    ).toBeUndefined();
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

    expect(
      parseWorkbenchResponse({
        ...reviewProjection,
        checks: {
          overall: "passing",
          checks: [{ ...legalCheck, providerEvent: "raw" }],
        },
      }),
    ).toBeUndefined();
    expect(
      parseWorkbenchResponse({
        ...reviewProjection,
        conversation: {
          prDescription: "",
          entries: [
            {
              _tag: "GeneralThread",
              thread: {
                ...legalThread,
                comments: [{ ...legalComment, prompt: "secret" }],
              },
            },
          ],
        },
      }),
    ).toBeUndefined();
    expect(
      parseWorkbenchResponse({
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
      }),
    ).toBeUndefined();
    expect(
      parseWorkbenchResponse({
        ...reviewProjection,
        draft: {
          ...legalDraft,
          items: [
            {
              _tag: "ThreadReply",
              id: "item-1",
              provenance: { _tag: "human" },
              threadId: "thread-1",
              body: "reply",
              include: true,
              localPath: "/tmp/secret",
            },
          ],
        },
      }),
    ).toBeUndefined();
    expect(
      parseWorkbenchResponse({
        ...reviewProjection,
        conversation: {
          prDescription: "",
          entries: [
            {
              _tag: "IssueComment",
              comment: { ...legalComment, prompt: "secret" },
            },
          ],
        },
      }),
    ).toBeUndefined();

    expect(
      parseWorkbenchResponse({
        ...reviewProjection,
        conversation: {
          prDescription: "",
          entries: [
            {
              _tag: "ReviewComment",
              comment: {
                ...legalComment,
                reviewId: "review-1",
                canEdit: true,
                canDelete: false,
              },
            },
            {
              _tag: "IssueComment",
              comment: { ...legalComment, canEdit: true, canDelete: false },
            },
          ],
        },
      }),
    ).toBeDefined();

    expect(
      parseWorkbenchResponse({
        ...reviewProjection,
        checks: { overall: "passing", checks: [legalCheck] },
        conversation: {
          prDescription: "A PR description",
          entries: [{ _tag: "IssueComment", comment: { ...legalComment } }],
        },
        commits: [
          {
            sha: sessionProjection.key.headSha,
            message: "A legal commit",
            author: "author",
            authoredAt: "2026-07-18T00:00:00.000Z",
            isHead: true,
          },
        ],
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
      }),
    ).toBeDefined();
  });
});

describe("parseMergeReceipt", () => {
  const receipt = {
    readiness: { _tag: "Ready", blockers: [], warnings: [] },
    mergeCommitSha: "c".repeat(40),
  };

  it("accepts only a strict confirmed merge receipt", () => {
    expect(parseMergeReceipt(receipt)).toEqual(receipt);
    expect(
      parseMergeReceipt({ ...receipt, mergeCommitSha: "short" }),
    ).toBeUndefined();
    expect(parseMergeReceipt({ ...receipt, response: "raw" })).toBeUndefined();
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
      parseModelCatalog({
        models: [{ id: "model-a", label: "l".repeat(201) }],
      }),
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
