import { describe, expect, it } from "vitest";

import {
  allocateNextReviewAttemptId,
  createReviewSessionId,
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { parsePullRequestInput } from "../../src/domain/pull-request";
import {
  parseModelReviewResult,
  parseReviewResult,
} from "../../src/domain/review-result";
import {
  completeAttempt,
  createReviewSession,
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
      verdict: "approve",
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

    expect(result).toMatchObject({ _tag: "ok", value: { verdict: "approve" } });
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

  it("blocks reruns while a local draft is active", () => {
    const session = createReviewSession({
      key: ids,
      ...sessionContext,
      createdAt: times.created,
      draft: { state: { _tag: "LocalDraft" } },
    });

    expect(startNextAttempt(session, ["001"])).toMatchObject({
      _tag: "err",
      error: { _tag: "ActiveDraftBlocksRerun" },
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
