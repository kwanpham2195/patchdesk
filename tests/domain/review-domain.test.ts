import { describe, expect, it } from "vitest";

import {
  allocateNextReviewAttemptId,
  createReviewSessionId,
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseGitHubThreadId,
  parseIsoTimestamp,
  parseLocalReviewItemId,
  parsePullRequestNumber,
  parseReviewAttemptId,
  parseRepoRelativePath,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import {
  hasActiveReviewBatch,
  parseReviewBatch,
} from "../../src/domain/review-batch";
import { parsePullRequestInput } from "../../src/domain/pull-request";
import {
  parseModelReviewResult,
  parseReviewResult,
} from "../../src/domain/review-result";
import {
  completeAttempt,
  createReviewSession,
  discardBatchForRerun,
  discardCurrentAttempt,
  markSessionMerged,
  startNextAttempt,
} from "../../src/domain/review-session";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import {
  parseGitHubPullRequestDto,
  parsePatchdeskConfig,
  parseReviewPrWorkflowInput,
  parseReviewSessionStorageFile,
  parseStartReviewRequest,
} from "../../src/domain/contracts";

function mustParse<T, E>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err"; readonly error: E }): T {
  if (result._tag === "err") {
    throw new Error("Expected domain value to parse");
  }

  return result.value;
}

const ids = {
  profileId: mustParse(parseWorkspaceProfileId("cfw")),
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("centraldigital")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  prNumber: mustParse(parsePullRequestNumber(42)),
  headSha: mustParse(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
};

const times = {
  created: mustParse(parseIsoTimestamp("2026-07-16T00:00:00.000Z")),
  completed: mustParse(parseIsoTimestamp("2026-07-16T00:01:00.000Z")),
  merged: mustParse(parseIsoTimestamp("2026-07-16T00:02:00.000Z")),
};

const sessionContext = {
  pr: { headSha: ids.headSha, isDraft: false, isOpen: true },
  patchPath: mustParse(parseAbsolutePath("/tmp/patch.diff")),
  worktree: {
    path: mustParse(parseAbsolutePath("/tmp/worktree")),
    headSha: ids.headSha,
  },
};

function batchFixture(
  anchor: { readonly startLine: number; readonly line: number } = {
    startLine: 7,
    line: 8,
  },
) {
  const session = createReviewSession({
    key: ids,
    ...sessionContext,
    createdAt: times.created,
  });

  return {
    sessionId: session.id,
    attemptId: mustParse(parseReviewAttemptId("001")),
    state: { _tag: "Local" as const },
    summaryBody: "One review note.",
    suggestedEvent: "COMMENT" as const,
    items: [
      {
        _tag: "InlineComment" as const,
        id: mustParse(parseLocalReviewItemId("finding-1")),
        source: "finding" as const,
        findingId: "finding-1",
        anchor: {
          path: mustParse(parseRepoRelativePath("src/example.ts")),
          ...anchor,
          side: "new" as const,
        },
        body: "Keep this branch explicit.",
        include: true,
        postability: "postable" as const,
      },
      {
        _tag: "ThreadReply" as const,
        id: mustParse(parseLocalReviewItemId("reply-1")),
        threadId: mustParse(parseGitHubThreadId("PRRT_kwDOAAABBB")),
        body: "Fixed in the current patch.",
        include: true,
      },
      {
        _tag: "ThreadState" as const,
        id: mustParse(parseLocalReviewItemId("thread-state-1")),
        threadId: mustParse(parseGitHubThreadId("PRRT_kwDOCCCDDD")),
        action: "resolve" as const,
        include: true,
      },
    ],
    receipts: [],
    createdAt: times.created,
    updatedAt: times.created,
  };
}

describe("Patchdesk review domain", () => {
  it("parses a workspace profile and rejects unknown config keys", () => {
    const valid = parseWorkspaceProfileConfig({
      id: "cfw",
      label: "CFW",
      githubHost: "github.com",
      ghAccount: "pmquan2cfw",
      ownerFilters: ["centraldigital"],
      workspaceRoots: ["/Users/kwanpham/Work/cfw"],
      rulePaths: ["/Users/kwanpham/Work/cfw/AGENTS.md"],
      repos: [{ host: "github.com", owner: "centraldigital", repo: "patchdesk" }],
    });

    expect(valid._tag).toBe("ok");
    expect(
      parseWorkspaceProfileConfig({
        id: "cfw",
        label: "CFW",
        githubHost: "github.com",
        ghAccount: "pmquan2cfw",
        ownerFilters: [],
        workspaceRoots: [],
        rulePaths: [],
        repos: [],
        unexpected: true,
      }),
    ).toMatchObject({ _tag: "err", error: { _tag: "InvalidWorkspaceProfileConfig" } });
  });

  it("parses supported direct pull request input and rejects unsafe input", () => {
    expect(
      parsePullRequestInput("https://github.com/centraldigital/patchdesk/pull/42"),
    ).toMatchObject({
      _tag: "ok",
      value: { owner: "centraldigital", repo: "patchdesk", number: 42 },
    });
    expect(parsePullRequestInput("centraldigital/patchdesk#42")).toMatchObject({
      _tag: "ok",
      value: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 },
    });
    expect(parsePullRequestInput("centraldigital/../patchdesk#42")).toMatchObject({
      _tag: "err",
      error: { _tag: "InvalidPullRequestInput" },
    });
  });

  it("rejects invalid host, owner, repo, PR number, SHA, and finding severity", () => {
    expect(parseGitHubHost("github.com/path")).toMatchObject({ _tag: "err" });
    expect(parseGitHubOwner("../centraldigital")).toMatchObject({ _tag: "err" });
    expect(parseGitHubRepoName("patchdesk/extra")).toMatchObject({ _tag: "err" });
    expect(parsePullRequestNumber(0)).toMatchObject({ _tag: "err" });
    expect(parseGitSha("ABCDEF1234567890abcdef1234567890abcdef12")).toMatchObject({ _tag: "err" });
    expect(
      parseModelReviewResult({
        changeSummary: "Adds parsing.",
        verdict: "comment",
        summary: "One note.",
        findings: [{
          id: "finding-1",
          severity: "critical",
          title: "Invalid severity",
          explanation: "The value is outside the contract.",
          confidence: "high",
        }],
        validationPlan: [],
        assumptions: [],
      }),
    ).toMatchObject({ _tag: "err", error: { _tag: "InvalidModelReviewResult" } });
  });

  it("creates a stable path-safe session ID whose collision hash distinguishes profiles", () => {
    const key = {
      profileId: ids.profileId,
      host: ids.host,
      owner: ids.owner,
      repo: ids.repo,
      prNumber: ids.prNumber,
      headSha: ids.headSha,
    };

    const first = createReviewSessionId(key);
    const second = createReviewSessionId(key);
    const otherProfile = createReviewSessionId({
      ...key,
      profileId: mustParse(parseWorkspaceProfileId("other-profile")),
    });

    expect(first).toBe(second);
    expect(first).toMatch(
      /^github\.com__centraldigital__patchdesk__pr-42__sha-abcdef12__[a-f0-9]{12}$/,
    );
    expect(first).not.toContain("/");
    expect(first).not.toBe(otherProfile);
  });

  it("allocates the next sequential attempt ID from supplied folder names", () => {
    expect(allocateNextReviewAttemptId(["001", "002", "notes"])).toEqual({
      _tag: "ok",
      value: "003",
    });
  });

  it("rejects model-controlled mapping status and invalid review values", () => {
    const modelResult = {
      changeSummary: "Adds strict review parsing.",
      verdict: "request_changes",
      summary: "A validation path is missing.",
      findings: [
        {
          id: "finding-1",
          severity: "P1",
          title: "Validate input",
          explanation: "Unvalidated input enters the service.",
          confidence: "high",
          mappingStatus: "mapped",
        },
      ],
      validationPlan: ["pnpm test -- --run domain"],
      assumptions: [],
    };

    expect(parseModelReviewResult(modelResult)).toMatchObject({
      _tag: "err",
      error: { _tag: "InvalidModelReviewResult" },
    });
    expect(
      parseReviewResult({
        ...modelResult,
        findings: [{ ...modelResult.findings[0], mappingStatus: "unsafe" }],
      }),
    ).toMatchObject({ _tag: "err", error: { _tag: "InvalidReviewResult" } });
  });

  it("rejects invalid verdicts and accepts a Patchdesk-computed final mapping status", () => {
    const result = parseReviewResult({
      changeSummary: "Adds strict review parsing.",
      verdict: "comment",
      summary: "No blocking findings.",
      findings: [
        {
          id: "finding-1",
          severity: "P2",
          title: "Validate input",
          explanation: "Validation is present.",
          confidence: "high",
          mappingStatus: "mapped",
        },
      ],
      validationPlan: ["pnpm test -- --run domain"],
      assumptions: [],
    });

    expect(result).toMatchObject({ _tag: "ok", value: { verdict: "comment" } });
    expect(
      parseReviewResult({
        changeSummary: "Adds strict review parsing.",
        verdict: "merge_now",
        summary: "No blocking findings.",
        findings: [],
        validationPlan: [],
        assumptions: [],
      }),
    ).toMatchObject({ _tag: "err", error: { _tag: "InvalidReviewResult" } });
  });

  it("accepts inline, reply, and thread-state batch items", () => {
    expect(parseReviewBatch(batchFixture())._tag).toBe("ok");
  });

  it("rejects an invalid batch comment range", () => {
    expect(
      parseReviewBatch(batchFixture({ startLine: 8, line: 7 }))._tag,
    ).toBe("err");
  });

  it("accepts each completed remote write receipt variant", () => {
    expect(parseReviewBatch({
      ...batchFixture(),
      state: { _tag: "PendingReview", reviewId: "review-1" },
      receipts: [
        {
          _tag: "PendingReviewCreated",
          reviewId: "review-1",
          itemIds: ["finding-1"],
        },
        {
          _tag: "ReplyCreated",
          itemId: "reply-1",
          commentId: "comment-1",
        },
        {
          _tag: "ThreadStateChanged",
          itemId: "thread-state-1",
          state: "resolved",
        },
      ],
    })._tag).toBe("ok");
  });

  it("accepts a receipt-complete reply and thread-state batch without a GitHub review", () => {
    const fixture = batchFixture();
    const parsed = parseReviewBatch({
      ...fixture,
      state: { _tag: "Completed" },
      items: fixture.items.filter((item) => item._tag !== "InlineComment"),
      receipts: [
        {
          _tag: "ReplyCreated",
          itemId: "reply-1",
          commentId: "comment-1",
        },
        {
          _tag: "ThreadStateChanged",
          itemId: "thread-state-1",
          state: "resolved",
        },
      ],
    });

    expect(parsed).toMatchObject({ _tag: "ok", value: { state: { _tag: "Completed" } } });
    if (parsed._tag === "ok") {
      expect(parsed.value.state).toEqual({ _tag: "Completed" });
    }
  });

  it("rejects a completed batch that carries a GitHub review ID", () => {
    const fixture = batchFixture();

    expect(parseReviewBatch({
      ...fixture,
      state: { _tag: "Completed", reviewId: "review-1" },
      items: fixture.items.filter((item) => item._tag !== "InlineComment"),
      receipts: [
        {
          _tag: "ReplyCreated",
          itemId: "reply-1",
          commentId: "comment-1",
        },
        {
          _tag: "ThreadStateChanged",
          itemId: "thread-state-1",
          state: "resolved",
        },
      ],
    })._tag).toBe("err");
  });

  it.each([
    {
      name: "included inline comment",
      items: batchFixture().items,
      receipts: [
        {
          _tag: "PendingReviewCreated",
          reviewId: "review-1",
          itemIds: ["finding-1"],
        },
        {
          _tag: "ReplyCreated",
          itemId: "reply-1",
          commentId: "comment-1",
        },
        {
          _tag: "ThreadStateChanged",
          itemId: "thread-state-1",
          state: "resolved",
        },
      ],
    },
    {
      name: "missing reply receipt",
      items: batchFixture().items.filter((item) => item._tag !== "InlineComment"),
      receipts: [{
        _tag: "ThreadStateChanged",
        itemId: "thread-state-1",
        state: "resolved",
      }],
    },
  ])("rejects a completed batch with $name", ({ items, receipts }) => {
    expect(parseReviewBatch({
      ...batchFixture(),
      state: { _tag: "Completed" },
      items,
      receipts,
    })._tag).toBe("err");
  });

  it("preserves Submitted for a pending review that was separately submitted", () => {
    const parsed = parseReviewBatch({
      ...batchFixture(),
      state: { _tag: "Submitted", reviewId: "review-1", event: "COMMENT" },
      receipts: [
        {
          _tag: "PendingReviewCreated",
          reviewId: "review-1",
          itemIds: ["finding-1"],
        },
        {
          _tag: "ReplyCreated",
          itemId: "reply-1",
          commentId: "comment-1",
        },
        {
          _tag: "ThreadStateChanged",
          itemId: "thread-state-1",
          state: "resolved",
        },
      ],
    });

    expect(parsed).toMatchObject({
      _tag: "ok",
      value: { state: { _tag: "Submitted", reviewId: "review-1" } },
    });
  });

  it.each([
    {
      name: "missing item",
      state: {
        _tag: "Applying",
        operation: { _tag: "Reply", itemId: "missing-item" },
      },
    },
    {
      name: "wrong item kind",
      state: {
        _tag: "Applying",
        operation: { _tag: "ThreadState", itemId: "reply-1" },
      },
    },
  ])("rejects an applying operation with a $name", ({ state }) => {
    expect(parseReviewBatch({
      ...batchFixture(),
      state,
    })._tag).toBe("err");
  });

  it("rejects an applying operation for an excluded item", () => {
    const fixture = batchFixture();

    expect(parseReviewBatch({
      ...fixture,
      items: fixture.items.map((item) =>
        item.id === "reply-1" ? { ...item, include: false } : item
      ),
      state: {
        _tag: "Applying",
        operation: { _tag: "Reply", itemId: "reply-1" },
      },
    })._tag).toBe("err");
  });

  it.each([
    { name: "missing item", itemIds: ["finding-1"] },
    { name: "extra item", itemIds: ["finding-1", "finding-2", "missing-item"] },
  ])("rejects a pending-review operation with a $name", ({ itemIds }) => {
    const fixture = batchFixture();
    const firstInline = fixture.items.find(
      (item) => item._tag === "InlineComment",
    );
    if (firstInline === undefined) {
      throw new Error("Batch fixture must include an inline comment");
    }

    expect(parseReviewBatch({
      ...fixture,
      items: [
        ...fixture.items,
        {
          ...firstInline,
          id: "finding-2",
          findingId: "finding-2",
          body: "Keep the fallback explicit.",
        },
      ],
      state: {
        _tag: "Applying",
        operation: { _tag: "CreatePendingReview", itemIds },
      },
    })._tag).toBe("err");
  });

  it.each([
    { _tag: "PendingReview", reviewId: "review-1" },
    { _tag: "Submitted", reviewId: "review-1", event: "COMMENT" },
  ] as const)("rejects a $_tag batch when its pending-review receipt omits an eligible inline comment", (state) => {
    const fixture = batchFixture();
    const firstInline = fixture.items.find(
      (item) => item._tag === "InlineComment",
    );
    if (firstInline === undefined) {
      throw new Error("Batch fixture must include an inline comment");
    }

    expect(parseReviewBatch({
      ...fixture,
      items: [
        ...fixture.items.map((item) =>
          item._tag === "InlineComment" ? item : { ...item, include: false },
        ),
        {
          ...firstInline,
          id: "finding-2",
          findingId: "finding-2",
          body: "Keep the fallback explicit.",
        },
      ],
      state,
      receipts: [{
        _tag: "PendingReviewCreated",
        reviewId: "review-1",
        itemIds: ["finding-1"],
      }],
    })._tag).toBe("err");
  });

  it.each([
    {
      name: "missing item",
      receipt: {
        _tag: "ReplyCreated",
        itemId: "missing-item",
        commentId: "comment-1",
      },
    },
    {
      name: "wrong item kind",
      receipt: {
        _tag: "ThreadStateChanged",
        itemId: "reply-1",
        state: "resolved",
      },
    },
    {
      name: "wrong resulting thread state",
      receipt: {
        _tag: "ThreadStateChanged",
        itemId: "thread-state-1",
        state: "open",
      },
    },
  ])("rejects a remote write receipt with a $name", ({ receipt }) => {
    expect(parseReviewBatch({
      ...batchFixture(),
      state: {
        _tag: "Applying",
        operation: { _tag: "Reply", itemId: "reply-1" },
      },
      receipts: [receipt],
    })._tag).toBe("err");
  });

  it.each([
    {
      name: "local state with a remote receipt",
      state: { _tag: "Local" },
      receipts: [{
        _tag: "PendingReviewCreated",
        reviewId: "review-1",
        itemIds: ["finding-1"],
      }],
    },
    {
      name: "applying state whose operation already has a receipt",
      state: {
        _tag: "Applying",
        operation: { _tag: "Reply", itemId: "reply-1" },
      },
      receipts: [{
        _tag: "ReplyCreated",
        itemId: "reply-1",
        commentId: "comment-1",
      }],
    },
    {
      name: "pending-review state without its creation receipt",
      state: { _tag: "PendingReview", reviewId: "review-1" },
      receipts: [],
    },
    {
      name: "submitted state with a different creation receipt",
      state: {
        _tag: "Submitted",
        reviewId: "review-1",
        event: "COMMENT",
      },
      receipts: [{
        _tag: "PendingReviewCreated",
        reviewId: "review-2",
        itemIds: ["finding-1"],
      }],
    },
  ])("rejects a batch with $name", ({ state, receipts }) => {
    expect(parseReviewBatch({
      ...batchFixture(),
      state,
      receipts,
    })._tag).toBe("err");
  });

  it("blocks reruns until a local batch is explicitly discarded", () => {
    const session = createReviewSession({
      key: ids,
      ...sessionContext,
      createdAt: times.created,
      batch: { state: { _tag: "Local" } },
    });

    expect(startNextAttempt(session, ["001"])).toMatchObject({
      _tag: "err",
      error: { _tag: "ActiveBatchBlocksRerun" },
    });
  });

  it("clears a completed reply and thread-state batch before a rerun", () => {
    const fixture = batchFixture();
    const completedBatch = mustParse(parseReviewBatch({
      ...fixture,
      state: { _tag: "Completed" },
      items: fixture.items.filter((item) => item._tag !== "InlineComment"),
      receipts: [
        {
          _tag: "ReplyCreated",
          itemId: "reply-1",
          commentId: "comment-1",
        },
        {
          _tag: "ThreadStateChanged",
          itemId: "thread-state-1",
          state: "resolved",
        },
      ],
    }));
    const session = {
      ...createReviewSession({
        key: ids,
        ...sessionContext,
        createdAt: times.created,
      }),
      state: {
        _tag: "ReviewCompleted" as const,
        attemptId: completedBatch.attemptId,
      },
      currentAttemptId: completedBatch.attemptId,
      batch: { state: completedBatch.state },
      batchContent: completedBatch,
    };

    expect(hasActiveReviewBatch(completedBatch)).toBe(false);
    const started = mustParse(startNextAttempt(session, ["001"]));
    expect(started).toMatchObject({
      attemptId: "002",
      session: {
        currentAttemptId: "002",
        state: { _tag: "Running", attemptId: "002" },
      },
    });
    expect(started.session.batch).toBeUndefined();
    expect(started.session.batchContent).toBeUndefined();
  });

  it("discards only the batch before a rerun and preserves the visible result", () => {
    const visibleResult = mustParse(
      parseReviewResult({
        changeSummary: "Preserve this completed review.",
        verdict: "comment",
        summary: "One note.",
        findings: [],
        validationPlan: [],
        assumptions: [],
      }),
    );
    const session = {
      ...createReviewSession({
        key: ids,
        ...sessionContext,
        createdAt: times.created,
      }),
      state: {
        _tag: "ReviewCompleted" as const,
        attemptId: mustParse(parseReviewAttemptId("001")),
      },
      currentAttemptId: mustParse(parseReviewAttemptId("001")),
      batch: { state: { _tag: "Local" as const } },
      batchContent: mustParse(parseReviewBatch(batchFixture())),
      visibleResult,
    };

    expect(hasActiveReviewBatch(session.batch)).toBe(true);
    const discarded = discardBatchForRerun(session, times.completed);
    expect(discarded).toEqual({
      ...session,
      batch: undefined,
      batchContent: undefined,
      updatedAt: times.completed,
    });
    expect(startNextAttempt(discarded, ["001"])).toMatchObject({
      _tag: "ok",
      value: {
        attemptId: "002",
        session: { visibleResult },
      },
    });
  });

  it("ignores a late result from a non-current attempt without changing the session result", () => {
    const session = createReviewSession({
      key: ids,
      ...sessionContext,
      createdAt: times.created,
    });
    const started = mustParse(startNextAttempt(session, ["001"]));
    const finalResult = mustParse(
      parseReviewResult({
        changeSummary: "Adds strict review parsing.",
        verdict: "comment",
        summary: "One note.",
        findings: [],
        validationPlan: [],
        assumptions: [],
      }),
    );

    const completed = completeAttempt(started.session, {
      id: mustParse(allocateNextReviewAttemptId([])),
      sessionId: started.session.id,
      state: { _tag: "Running", flueRunId: "run-old" },
    }, finalResult, times.completed, mustParse(parseAbsolutePath("/tmp/result.json")));

    expect(completed).toMatchObject({
      _tag: "ok",
      value: {
        session: { state: { _tag: "Running" } },
        attempt: { state: { _tag: "IgnoredLateResult", reason: "not_current" } },
      },
    });
  });

  it("makes a successfully merged session immutable", () => {
    const session = createReviewSession({
      key: ids,
      ...sessionContext,
      createdAt: times.created,
    });
    const merged = mustParse(markSessionMerged(session, times.merged));

    expect(startNextAttempt(merged, [])).toMatchObject({
      _tag: "err",
      error: { _tag: "SessionImmutable" },
    });
    expect(markSessionMerged(merged, times.completed)).toMatchObject({
      _tag: "err",
      error: { _tag: "SessionImmutable" },
    });
  });

  it("marks a completion after discard as an ignored late result", () => {
    const session = createReviewSession({ key: ids, ...sessionContext, createdAt: times.created });
    const started = mustParse(startNextAttempt(session, []));
    const discarded = mustParse(
      discardCurrentAttempt(started.session, started.attemptId, times.completed),
    );
    const result = mustParse(
      parseReviewResult({
        changeSummary: "Adds strict review parsing.",
        verdict: "comment",
        summary: "One note.",
        findings: [],
        validationPlan: [],
        assumptions: [],
      }),
    );

    expect(
      completeAttempt(
        discarded,
        {
          id: started.attemptId,
          sessionId: discarded.id,
          state: { _tag: "Running", flueRunId: "run-discarded" },
        },
        result,
        times.completed,
        mustParse(parseAbsolutePath("/tmp/result.json")),
      ),
    ).toMatchObject({
      _tag: "ok",
      value: { attempt: { state: { _tag: "IgnoredLateResult", reason: "session_discarded" } } },
    });
  });

  it("rejects a matching attempt ID that belongs to a different session", () => {
    const session = createReviewSession({ key: ids, ...sessionContext, createdAt: times.created });
    const started = mustParse(startNextAttempt(session, []));
    const otherSession = createReviewSession({
      key: { ...ids, profileId: mustParse(parseWorkspaceProfileId("other-profile")) },
      ...sessionContext,
      createdAt: times.created,
    });
    const result = mustParse(
      parseReviewResult({
        changeSummary: "Adds strict review parsing.",
        verdict: "comment",
        summary: "One note.",
        findings: [],
        validationPlan: [],
        assumptions: [],
      }),
    );

    expect(
      completeAttempt(
        started.session,
        {
          id: started.attemptId,
          sessionId: otherSession.id,
          state: { _tag: "Running", flueRunId: "run-wrong-session" },
        },
        result,
        times.completed,
        mustParse(parseAbsolutePath("/tmp/result.json")),
      ),
    ).toMatchObject({ _tag: "err", error: { _tag: "AttemptSessionMismatch" } });
  });

  it("ignores a duplicate completion and preserves the first visible result", () => {
    const session = createReviewSession({ key: ids, ...sessionContext, createdAt: times.created });
    const started = mustParse(startNextAttempt(session, []));
    const firstResult = mustParse(
      parseReviewResult({
        changeSummary: "Adds strict review parsing.",
        verdict: "comment",
        summary: "First completion remains visible.",
        findings: [],
        validationPlan: [],
        assumptions: [],
      }),
    );
    const duplicateResult = mustParse(
      parseReviewResult({
        changeSummary: "Different result must not replace the first.",
        verdict: "request_changes",
        summary: "Duplicate completion.",
        findings: [],
        validationPlan: [],
        assumptions: [],
      }),
    );
    const attempt = {
      id: started.attemptId,
      sessionId: started.session.id,
      state: { _tag: "Running" as const, flueRunId: "run-current" },
    };
    const completed = mustParse(
      completeAttempt(
        started.session,
        attempt,
        firstResult,
        times.completed,
        mustParse(parseAbsolutePath("/tmp/result.json")),
      ),
    );

    expect(
      completeAttempt(
        completed.session,
        attempt,
        duplicateResult,
        times.merged,
        mustParse(parseAbsolutePath("/tmp/duplicate-result.json")),
      ),
    ).toMatchObject({
      _tag: "ok",
      value: {
        session: { visibleResult: { summary: "First completion remains visible." } },
        attempt: { state: { _tag: "IgnoredLateResult", reason: "not_current" } },
      },
    });
  });

  it("parses strict boundary contracts for config, GitHub, storage, Flue, and UI requests", () => {
    expect(parsePatchdeskConfig({ recentPrs: [] })).toMatchObject({ _tag: "ok" });
    expect(parsePatchdeskConfig({ recentPrs: [], typo: true })).toMatchObject({
      _tag: "err",
      error: { _tag: "InvalidDomainContract", boundary: "config" },
    });
    expect(
      parseGitHubPullRequestDto({
        number: 42,
        title: "Domain model",
        state: "open",
        draft: false,
        head: { ref: "feat/domain", sha: "abcdef1234567890abcdef1234567890abcdef12" },
        base: { ref: "sit" },
      }),
    ).toMatchObject({ _tag: "ok" });
    expect(parseGitHubPullRequestDto({ number: 42 })).toMatchObject({
      _tag: "err",
      error: { _tag: "InvalidDomainContract", boundary: "github" },
    });
    expect(
      parseReviewSessionStorageFile({
        id: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__000000000000",
        currentAttemptId: "001",
        state: { _tag: "Running", attemptId: "001" },
      }),
    ).toMatchObject({ _tag: "ok" });
    expect(
      parseReviewSessionStorageFile({
        id: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__000000000000",
        currentAttemptId: "001",
        state: { _tag: "Running", attemptId: "002" },
      }),
    ).toMatchObject({ _tag: "err", error: { _tag: "InvalidDomainContract", boundary: "storage" } });
    expect(
      parseReviewPrWorkflowInput({
        profileId: "cfw",
        sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__000000000000",
        attemptId: "001",
        worktreePath: "/tmp/worktree",
        contextPath: "/tmp/context.json",
        reviewInputPath: "/tmp/review-input.md",
        patchPath: "/tmp/patch.diff",
      }),
    ).toMatchObject({ _tag: "ok" });
    expect(
      parseReviewPrWorkflowInput({
        profileId: "cfw",
        sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__000000000000",
        attemptId: "001",
        worktreePath: "/tmp/worktree\0unsafe",
        contextPath: "/tmp/context.json",
        reviewInputPath: "/tmp/review-input.md",
        patchPath: "/tmp/patch.diff",
      }),
    ).toMatchObject({ _tag: "err", error: { _tag: "InvalidDomainContract", boundary: "flue" } });
    expect(
      parseReviewPrWorkflowInput({
        profileId: "cfw",
        sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__000000000000",
        attemptId: "001",
        worktreePath: "/tmp/worktree",
        contextPath: "relative/context.json",
        reviewInputPath: "/tmp/review-input.md",
        patchPath: "/tmp/patch.diff",
      }),
    ).toMatchObject({ _tag: "err", error: { _tag: "InvalidDomainContract", boundary: "flue" } });
    expect(
      parseReviewPrWorkflowInput({
        profileId: "cfw",
        sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__000000000000",
        attemptId: "001",
        worktreePath: "/tmp/worktree",
        contextPath: "/tmp/context.json",
        reviewInputPath: "/tmp/review-input\0unsafe.md",
        patchPath: "relative/patch.diff",
      }),
    ).toMatchObject({ _tag: "err", error: { _tag: "InvalidDomainContract", boundary: "flue" } });
    expect(
      parseStartReviewRequest({ profileId: "cfw", value: "centraldigital/patchdesk#42" }),
    ).toMatchObject({ _tag: "ok" });
  });
});
