import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import type { GitHubReader } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { InsightStore } from "../../src/adapters/storage/insight-store";
import type { CheckSummary, GitHubComments, PullRequestSummary } from "../../src/domain/github-context";
import {
  createReviewId,
  createReviewSessionId,
  parseAbsolutePath,
  parseContentHash,
  parseFindingId,
  parseGitSha,
  parseInsightRunId,
  parseIsoTimestamp,
  type GitSha,
} from "../../src/domain/ids";
import { createReview, type Review } from "../../src/domain/review";
import { normalizeNarrativeWalkthrough } from "../../src/domain/narrative-walkthrough";
import { createReviewSession, type ReviewSession, type ReviewSessionState } from "../../src/domain/review-session";
import { createEmptyReviewBatch } from "../../src/domain/review-batch";
import type { ReviewAttempt, ReviewAttemptState } from "../../src/domain/review-attempt";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ReviewWorkbenchProjectionService, type ReviewWorkbenchProjection } from "../../src/services/review-workbench-projection";
import { ReviewRunRegistry } from "../../src/services/review-run-registry";

const profileId = "cfw" as never;
const host = "github.com" as never;
const owner = "centraldigital" as never;
const repo = "patchdesk" as never;
const number = 42 as never;
const headSha = must(parseGitSha("2222222222222222222222222222222222222222"));
const staleHeadSha = must(parseGitSha("3333333333333333333333333333333333333333"));
const now = must(parseIsoTimestamp("2026-07-18T00:00:00.000Z"));

function summary(head: GitSha): PullRequestSummary {
  return {
    ref: { host, owner, repo, number },
    title: "Fixture review",
    author: "fixture",
    headBranch: "feature/review",
    baseBranch: "sit",
    headSha: head,
    isDraft: false,
    isOpen: true,
    reviewState: "none",
    mergeability: "unknown",
    labels: [],
    updatedAt: now,
  };
}

function fakeGitHub(options: {
  readonly current?: PullRequestSummary;
  readonly comments?: GitHubComments;
  readonly checks?: CheckSummary;
}): Pick<GitHubReader, "getPullRequest" | "getPullRequestComments" | "getPullRequestChecks"> & { readonly calls: Array<string> } {
  const calls: Array<string> = [];
  const missing = (): { readonly _tag: "err"; readonly error: never } => ({
    _tag: "err",
    error: { _tag: "GitHubReadFailure" } as never,
  });
  return {
    async getPullRequest() {
      calls.push("pull_request");
      return options.current === undefined ? missing() : { _tag: "ok", value: options.current };
    },
    async getPullRequestComments() {
      calls.push("comments");
      return options.comments === undefined ? missing() : { _tag: "ok", value: options.comments };
    },
    async getPullRequestChecks() {
      calls.push("checks");
      return options.checks === undefined ? missing() : { _tag: "ok", value: options.checks };
    },
    calls,
  };
}

function sessionId(): ReturnType<typeof createReviewSessionId> {
  return createReviewSessionId({ profileId, host, owner, repo, prNumber: number, headSha });
}

function completedSession(paths: PatchdeskPaths, options: { readonly incremental?: boolean } = {}): ReviewSession {
  const id = sessionId();
  const scope = options.incremental === true
    ? {
        kind: "incremental" as const,
        baseSessionId: "github.com__centraldigital__patchdesk__pr-42__sha-11111111__000000000000" as never,
        baseHeadSha: must(parseGitSha("1111111111111111111111111111111111111111")),
        headSha,
        comparisonPatchPath: must(parseAbsolutePath(paths.comparisonPatchFile(profileId, id))),
        comparisonMetadataPath: must(parseAbsolutePath(paths.comparisonMetadataFile(profileId, id))),
        previousFindingsPath: must(parseAbsolutePath(paths.previousFindingsFile(profileId, id))),
        lifecyclePath: must(parseAbsolutePath(paths.findingLifecycleFile(profileId, id))),
      }
    : undefined;
  const session = createReviewSession({
    key: { profileId, host, owner, repo, prNumber: number, headSha },
    pr: { headSha, isDraft: false, isOpen: true },
    prContext: {
      title: "Stored review title",
      author: "fixture",
      headBranch: "feature/review",
      baseBranch: "sit",
    },
    patchPath: must(parseAbsolutePath(paths.patchFile(profileId, id))),
    ...(scope === undefined ? {} : { scope }),
    worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, id))), headSha },
    createdAt: now,
  });
  const batch = {
    sessionId: session.id,
    attemptId: "001",
    state: { _tag: "Local" },
    summaryBody: "Persisted review result",
    suggestedEvent: "COMMENT",
    items: [],
    receipts: [],
    createdAt: now,
    updatedAt: now,
  };
  return {
    ...session,
    state: { _tag: "ReviewCompleted", attemptId: "001" as never },
    currentAttemptId: "001" as never,
    batch: { state: { _tag: "Local" } },
    batchContent: batch as never,
    visibleResult: {
      changeSummary: "Persisted review result",
      verdict: "comment",
      summary: "Persisted review result",
      findings: [],
      validationPlan: [],
      assumptions: [],
    } as never,
  };
}

function preparedSession(paths: PatchdeskPaths, state: ReviewSessionState, currentAttemptId?: string): ReviewSession {
  const id = sessionId();
  return {
    ...createReviewSession({
      key: { profileId, host, owner, repo, prNumber: number, headSha },
      pr: { headSha, isDraft: false, isOpen: true },
      patchPath: must(parseAbsolutePath(paths.patchFile(profileId, id))),
      worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, id))), headSha },
      createdAt: now,
    }),
    state,
    ...(currentAttemptId === undefined ? {} : { currentAttemptId: currentAttemptId as never }),
  };
}

function attemptFor(paths: PatchdeskPaths, session: ReviewSession, state: ReviewAttemptState): ReviewAttempt {
  const id = "001" as never;
  return {
    id,
    sessionId: session.id,
    state,
    model: "fixture-model",
    reasoning: "medium",
    reviewSkillVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as never,
    contextHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as never,
    contextPath: must(parseAbsolutePath(paths.attemptContextFile(profileId, session.id, id))),
    reviewInputPath: must(parseAbsolutePath(paths.attemptReviewInputFile(profileId, session.id, id))),
    debugPath: must(parseAbsolutePath(paths.attemptDebugFile(profileId, session.id, id))),
    startedAt: now,
  };
}

async function setup(github: ReturnType<typeof fakeGitHub>, withInsights = false): Promise<{
  readonly root: string;
  readonly paths: PatchdeskPaths;
  readonly projection: ReviewWorkbenchProjectionService;
  readonly sessions: ReviewSessionStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-projection-"));
  const paths = PatchdeskPaths.forTest(root);
  const profile = must(parseWorkspaceProfileConfig({
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "fixture",
    ownerFilters: [],
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  }));
  await new ProfileStore(paths).save(profile);
  const sessions = new ReviewSessionStore(paths);
  const projection = new ReviewWorkbenchProjectionService(
    new ProfileStore(paths),
    sessions,
    github,
    () => now,
    undefined,
    undefined,
    withInsights ? new InsightStore(paths) : undefined,
  );
  return { root, paths, projection, sessions };
}

describe("ReviewWorkbenchProjectionService", () => {
  it("uses normal type imports for projection dependencies", async () => {
    const source = await readFile(
      new URL("../../src/services/review-workbench-projection.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/import\(['"][^'"]+['"]\)\./);
  });

  it("opens saved local work without reading GitHub", async () => {
    const github = fakeGitHub({ current: summary(headSha), comments: { threads: [] }, checks: { overall: "passing", checks: [] } });
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const session = completedSession(paths);
      expect((await sessions.save(session))._tag).toBe("ok");

      const loaded = await projection.loadLocal({ profileId, sessionId: session.id });

      expect(loaded).toMatchObject({
        _tag: "ok",
        value: {
          state: "review",
          revision: { freshness: "not_refreshed" },
          recoveryView: {
            noticeKey: "ready_to_review",
            tone: "positive",
            actionKey: "run_review",
          },
        },
      });
      expect(github.calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads only the Review-represented snapshot without reading GitHub", async () => {
    const github = fakeGitHub({ current: { ...summary(headSha), title: "Live title" }, comments: { threads: [{ id: "live-thread" as never, state: "open", comments: [] }] }, checks: { overall: "failing", checks: [] } });
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const session = completedSession(paths);
      expect((await sessions.save(session))._tag).toBe("ok");
      const represented = {
        schemaVersion: 1 as const,
        pullRequest: { ...summary(headSha), title: "Represented title" },
        comments: { threads: [], complete: true },
        commits: [],
        checks: { overall: "passing" as const, checks: [] },
      };
      const loaded = await projection.loadRepresented({ profileId, sessionId: session.id, snapshot: represented, refreshedAt: now, updatesAvailable: true });
      expect(loaded).toMatchObject({ _tag: "ok", value: { pullRequest: { title: "Represented title" }, checks: { overall: "passing" }, revision: { freshness: "updates_available", refreshedAt: now } } });
      expect(github.calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects policy-backed approval reasons and partial unavailable evidence safely", async () => {
    const github = fakeGitHub({ current: { ...summary(headSha), reviewState: "review_pending", mergeability: "blocked" }, comments: { threads: [] }, checks: { overall: "passing", checks: [] } });
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const session = completedSession(paths);
      expect((await sessions.save(session))._tag).toBe("ok");
      const represented = {
        schemaVersion: 1 as const,
        pullRequest: summary(headSha),
        comments: { threads: [], complete: true },
        commits: [],
        checks: { overall: "passing" as const, checks: [] },
        mergeEvidence: {
          mergeable: "blocked" as const,
          mergeStateStatus: "blocked" as const,
          reviewDecision: "review_required" as const,
          policy: {
            branchProtection: { state: "unavailable" as const, reason: "forbidden" as const },
            appliedRuleset: { state: "unavailable" as const, reason: "not_found" as const },
          },
        },
      };
      const loaded = await projection.loadRepresented({ profileId, sessionId: session.id, snapshot: represented, refreshedAt: now });
      expect(loaded).toMatchObject({ _tag: "ok", value: { mergeReasons: [{ code: "review_required", message: "Approval required by GitHub.", source: "github_pr_state", availability: "partial", openOnGitHub: true }] } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not turn zero approvals or unrelated rules into an exact policy claim", async () => {
    const github = fakeGitHub({ current: { ...summary(headSha), reviewState: "review_pending", mergeability: "blocked" }, comments: { threads: [] }, checks: { overall: "passing", checks: [] } });
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const session = completedSession(paths);
      expect((await sessions.save(session))._tag).toBe("ok");
      const represented = {
        schemaVersion: 1 as const,
        pullRequest: summary(headSha),
        comments: { threads: [], complete: true },
        commits: [],
        checks: { overall: "passing" as const, checks: [] },
        mergeEvidence: {
          mergeable: "blocked" as const,
          mergeStateStatus: "blocked" as const,
          reviewDecision: "review_required" as const,
          policy: {
            branchProtection: { state: "available" as const, value: { requiredApprovingReviewCount: 0, dismissStaleReviews: false } },
            appliedRuleset: { state: "available" as const, value: { rules: [{ type: "required_status_checks" }] } },
          },
        },
      };
      const loaded = await projection.loadRepresented({ profileId, sessionId: session.id, snapshot: represented, refreshedAt: now });
      expect(loaded).toMatchObject({ _tag: "ok", value: { mergeReasons: [{ message: "Approval required by GitHub.", source: "github_pr_state", availability: "partial", openOnGitHub: true }] } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes GitHub context without replacing the saved local batch", async () => {
    const github = fakeGitHub({ current: summary(headSha), comments: { threads: [] }, checks: { overall: "passing", checks: [] } });
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const session = completedSession(paths);
      expect((await sessions.save(session))._tag).toBe("ok");
      const before = await sessions.load(profileId, session.id);
      if (before._tag === "err") throw new Error("session should load");

      const refreshed = await projection.refreshRemote({ profileId, sessionId: session.id });
      const after = await sessions.load(profileId, session.id);

      expect(refreshed).toMatchObject({ _tag: "ok", value: { freshness: "fresh", checks: { overall: "passing" } } });
      expect(github.calls).toEqual(expect.arrayContaining(["pull_request", "comments", "checks"]));
      expect(after).toMatchObject({ _tag: "ok", value: { batchContent: before.value.batchContent } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps a completed review readable when its local patch is absent, without path fields", async () => {
    const github = fakeGitHub({
      current: summary(headSha),
      comments: { threads: [] },
      checks: { overall: "passing", checks: [] },
    });
    const { root, projection, sessions } = await setup(github);
    try {
      const session = completedSession(PatchdeskPaths.forTest(root));
      expect((await sessions.save(session))._tag).toBe("ok");
      const loaded = await projection.load({ profileId, sessionId: session.id });
      expect(loaded._tag).toBe("ok");
      if (loaded._tag === "err") return;
      expect(loaded.value.state).toBe("review");
      expect(loaded.value.fullPatch).toBeUndefined();
      expect(loaded.value.revision.freshness).toBe("fresh");
      const serialized = JSON.stringify(loaded.value);
      for (const leaked of ["patchPath", "worktree", "comparisonPatchPath", "comparisonMetadataPath", "previousFindingsPath", "lifecyclePath", root]) {
        expect(serialized).not.toContain(leaked);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("degrades to safe bounded values when GitHub is unavailable", async () => {
    const github = fakeGitHub({});
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const session = completedSession(paths);
      expect((await sessions.save(session))._tag).toBe("ok");
      const loaded = await projection.load({ profileId, sessionId: session.id });
      expect(loaded._tag).toBe("ok");
      if (loaded._tag === "err") return;
      expect(loaded.value.state).toBe("review");
      expect(loaded.value.revision.freshness).toBe("unavailable");
      expect(loaded.value.comments).toEqual({
        threads: [],
        complete: false,
        incompleteReason: "unavailable",
      });
      expect(loaded.value.checks).toEqual({ overall: "unknown", checks: [] });
      expect(loaded.value.pullRequest).toMatchObject({ title: "Stored review title", reviewState: "unknown" });
      expect(loaded.value.mergeReadiness).toEqual({ _tag: "Blocked", blockers: ["stale_head"], warnings: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a changed current head stale while keeping saved evidence readable", async () => {
    const github = fakeGitHub({
      current: summary(staleHeadSha),
      comments: { threads: [] },
      checks: { overall: "passing", checks: [] },
    });
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const session = completedSession(paths);
      expect((await sessions.save(session))._tag).toBe("ok");
      const loaded = await projection.load({ profileId, sessionId: session.id });
      expect(loaded._tag).toBe("ok");
      if (loaded._tag === "err") return;
      expect(loaded.value.state).toBe("review");
      expect(loaded.value.revision.freshness).toBe("updates_available");
      expect(loaded.value.revision.currentHeadSha).toBe(staleHeadSha);
      expect(loaded.value.revision.reviewedHeadSha).toBe(headSha);
      expect(loaded.value.insights.analysis.retained?.value).toMatchObject({ summary: "Persisted review result" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects a retained typed InsightStore result instead of session legacy evidence", async () => {
    const github = fakeGitHub({ current: summary(headSha), comments: { threads: [] }, checks: { overall: "passing", checks: [] } });
    const { root, paths, projection, sessions } = await setup(github, true);
    try {
      const session = completedSession(paths);
      const patch = "diff --git a/src/a.ts b/src/a.ts\\n+change\\n";
      await mkdir(dirname(session.patchPath), { recursive: true });
      await writeFile(session.patchPath, patch, "utf8");
      expect((await sessions.save(session))._tag).toBe("ok");
      const patchHash = must(parseContentHash(createHash("sha256").update(patch).digest("hex")));
      const runId = must(parseInsightRunId("insight-analysis-1-aaaaaaaaaaaa-github.com__centraldigital__patchdesk__pr-42__review-0c8c9a759258"));
      expect((await new InsightStore(paths).save(profileId, {
        schemaVersion: 1,
        reviewId: createReviewId(session.key),
        type: "analysis",
        nextToken: 2,
        retained: {
          runId,
          revision: { sessionId: session.id, headSha, patchHash },
          generatedAt: now,
          value: {
            changeSummary: "Durable analysis",
            verdict: "comment",
            summary: "Durable analysis",
            findings: [],
            validationPlan: [],
            assumptions: [],
          },
        },
        updatedAt: now,
      }))._tag).toBe("ok");

      const loaded = await projection.loadLocal({ profileId, sessionId: session.id });
      expect(loaded).toMatchObject({ _tag: "ok", value: { insights: { analysis: { status: "current", artifactStatus: "verified", retained: { value: { summary: "Durable analysis" }, scope: { fileCount: 1 } } } } } });
      await writeFile(session.patchPath, `${patch}tampered`, "utf8");
      const corrupted = await projection.loadLocal({ profileId, sessionId: session.id });
      expect(corrupted).toMatchObject({ _tag: "ok", value: { insights: { analysis: { status: "outdated", artifactStatus: "mismatch", retained: { value: { summary: "Durable analysis" } } } } } });
      if (corrupted._tag === "ok") expect(corrupted.value.insights.analysis.retained?.scope).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects persisted first-run Insight run state from storage", async () => {
    const github = fakeGitHub({ current: summary(headSha), comments: { threads: [] }, checks: { overall: "passing", checks: [] } });
    const { root, paths, projection, sessions } = await setup(github, true);
    try {
      const session = completedSession(paths);
      expect((await sessions.save(session))._tag).toBe("ok");
      const reviewId = createReviewId(session.key);
      const runId = must(parseInsightRunId("insight-analysis-1-aaaaaaaaaaaa-github.com__centraldigital__patchdesk__pr-42__review-0c8c9a759258"));
      const store = new InsightStore(paths);
      expect((await store.save(profileId, {
        schemaVersion: 1,
        reviewId,
        type: "analysis",
        nextToken: 2,
        activeRun: { id: runId, type: "analysis", revision: { sessionId: session.id, headSha, patchHash: must(parseContentHash("a".repeat(64))) }, token: 1, model: "fixture-model", reasoning: "medium", status: "queued", startedAt: now },
        updatedAt: now,
      }))._tag).toBe("ok");
      expect(await projection.loadLocal({ profileId, sessionId: session.id })).toMatchObject({ _tag: "ok", value: { insights: { analysis: { status: "running", activeRun: { runId } } } } });

      expect((await store.save(profileId, {
        schemaVersion: 1,
        reviewId,
        type: "analysis",
        nextToken: 2,
        replacementFailure: { runId, reason: "failed", category: "unexpected_failure", model: "fixture-model", reasoning: "medium", retryable: true, failedAt: now },
        updatedAt: now,
      }))._tag).toBe("ok");
      expect(await projection.loadLocal({ profileId, sessionId: session.id })).toMatchObject({ _tag: "ok", value: { insights: { analysis: { status: "failed", replacementFailure: { runId, category: "unexpected_failure", model: "fixture-model" } } } } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads an outdated Walkthrough from its retained Session patch instead of the current patch", async () => {
    const github = fakeGitHub({ current: summary(headSha), comments: { threads: [] }, checks: { overall: "passing", checks: [] } });
    const { root, paths, projection, sessions } = await setup(github, true);
    try {
      const current = completedSession(paths);
      const oldHead = must(parseGitSha("1111111111111111111111111111111111111111"));
      const oldId = createReviewSessionId({ profileId, host, owner, repo, prNumber: number, headSha: oldHead });
      const oldSession = createReviewSession({
        key: { profileId, host, owner, repo, prNumber: number, headSha: oldHead },
        pr: { headSha: oldHead, isDraft: false, isOpen: true },
        patchPath: must(parseAbsolutePath(paths.patchFile(profileId, oldId))),
        worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, oldId))), headSha: oldHead },
        createdAt: now,
      });
      const oldPatch = "diff --git a/src/old.ts b/src/old.ts\nindex 1111111..2222222 100644\n--- a/src/old.ts\n+++ b/src/old.ts\n@@ -1,2 +1,3 @@\n old\n+old-new\n old-tail\n";
      const currentPatch = "diff --git a/src/current.ts b/src/current.ts\nindex 3333333..4444444 100644\n--- a/src/current.ts\n+++ b/src/current.ts\n@@ -1,2 +1,3 @@\n current\n+current-new\n current-tail\n";
      await mkdir(dirname(oldSession.patchPath), { recursive: true });
      await writeFile(oldSession.patchPath, oldPatch, "utf8");
      await mkdir(dirname(current.patchPath), { recursive: true });
      await writeFile(current.patchPath, currentPatch, "utf8");
      expect((await sessions.save(oldSession))._tag).toBe("ok");
      expect((await sessions.save(current))._tag).toBe("ok");
      const oldHash = must(parseContentHash(createHash("sha256").update(oldPatch).digest("hex")));
      const runId = must(parseInsightRunId("insight-walkthrough-1-aaaaaaaaaaaa-github.com__centraldigital__patchdesk__pr-42__review-0c8c9a759258"));
      const raw = {
        citationVersion: 2,
        snapshot: { profileId, sessionId: oldSession.id, headSha: oldHead, patchHash: oldHash },
        title: "Retained old walkthrough",
        focus: "Read old patch",
        chapters: [{ title: "Old chapter", sections: [{ title: "Old section", prose: "Old evidence in src/old.ts", hunkIds: ["h1"] }] }],
      };
      const normalized = normalizeNarrativeWalkthrough(raw, oldPatch, { profileId, sessionId: oldSession.id, headSha: oldHead, patchHash: oldHash });
      if (normalized._tag === "err") throw new Error(`normalize failed: ${normalized.error.reason}`);
      expect((await new InsightStore(paths).save(profileId, {
        schemaVersion: 1,
        reviewId: createReviewId(current.key),
        type: "walkthrough",
        nextToken: 2,
        retained: { runId, revision: { sessionId: oldSession.id, headSha: oldHead, patchHash: oldHash }, generatedAt: now, value: raw },
        updatedAt: now,
      }))._tag).toBe("ok");
      const loaded = await projection.loadLocal({ profileId, sessionId: current.id });
      expect(loaded).toMatchObject({ _tag: "ok", value: { insights: { walkthrough: { status: "outdated", artifactStatus: "verified", retained: { value: { title: "Retained old walkthrough", snapshot: { sessionId: oldSession.id }, chapters: [{ sections: [{ hunks: [{ id: "h1" }] }] }] } } } } } });
      await writeFile(oldSession.patchPath, oldPatch.replace("+old-new", "+tampered"), "utf8");
      const corrupted = await projection.loadLocal({ profileId, sessionId: current.id });
      expect(corrupted).toMatchObject({ _tag: "ok", value: { insights: { walkthrough: { status: "outdated", artifactStatus: "mismatch", retained: { value: { title: "Retained old walkthrough", chapters: [{ sections: [{ hunks: [], hunkIds: [] }] }], support: { hunks: [], hunkIds: [] } } } } } } });
      await writeFile(oldSession.patchPath, "corrupt bytes", "utf8");
      const unreadable = await projection.loadLocal({ profileId, sessionId: current.id });
      expect(unreadable).toMatchObject({ _tag: "ok", value: { insights: { walkthrough: { status: "outdated", artifactStatus: "mismatch", retained: { value: { title: "Retained old walkthrough", chapters: [{ sections: [{ hunks: [], hunkIds: [] }] }], support: { hunks: [], hunkIds: [] } } } } } } });
      await rm(oldSession.patchPath, { force: true });
      const missingPatch = await projection.loadLocal({ profileId, sessionId: current.id });
      expect(missingPatch).toMatchObject({ _tag: "ok", value: { insights: { walkthrough: { status: "outdated", artifactStatus: "mismatch", retained: { value: { title: "Retained old walkthrough", chapters: [{ sections: [{ hunks: [], hunkIds: [] }] }], support: { hunks: [], hunkIds: [] } } } } } } });
      await rm(paths.sessionFile(profileId, oldSession.id), { force: true });
      const missingSession = await projection.loadLocal({ profileId, sessionId: current.id });
      expect(missingSession).toMatchObject({ _tag: "ok", value: { insights: { walkthrough: { status: "outdated", artifactStatus: "mismatch", retained: { value: { title: "Retained old walkthrough", chapters: [{ sections: [{ hunks: [], hunkIds: [] }] }], support: { hunks: [], hunkIds: [] } } } } } } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects persisted Finding dismissals without changing retained Analysis", async () => {
  const github = fakeGitHub({ current: summary(headSha), comments: { threads: [] }, checks: { overall: "passing", checks: [] } });
  const { root, paths, projection, sessions } = await setup(github, true);
  try {
    const session = completedSession(paths);
    const patch = "diff --git a/src/a.ts b/src/a.ts\\n+change\\n";
    await mkdir(dirname(session.patchPath), { recursive: true });
    await writeFile(session.patchPath, patch, "utf8");
    expect((await sessions.save(session))._tag).toBe("ok");
    const patchHash = must(parseContentHash(createHash("sha256").update(patch).digest("hex")));
    const runId = must(parseInsightRunId("insight-analysis-1-aaaaaaaaaaaa-github.com__centraldigital__patchdesk__pr-42__review-0c8c9a759258"));
    const findingId = must(parseFindingId("finding-1"));
    expect((await new InsightStore(paths).save(profileId, {
      schemaVersion: 1,
      reviewId: createReviewId(session.key),
      type: "analysis",
      nextToken: 2,
      retained: {
        runId,
        revision: { sessionId: session.id, headSha, patchHash },
        generatedAt: now,
        value: {
          changeSummary: "Durable analysis",
          verdict: "comment",
          summary: "Durable analysis",
          findings: [{ id: findingId, severity: "P1", title: "Guard", explanation: "Missing guard.", confidence: "high", mappingStatus: "mapped", file: "src/a.ts", lineStart: 1, diffSide: "new" }],
          validationPlan: [],
          assumptions: [],
        },
      },
      dismissals: [{ findingId, reason: "Not applicable.", dismissedAt: now }],
      updatedAt: now,
    }))._tag).toBe("ok");
    const loaded = await projection.loadLocal({ profileId, sessionId: session.id });
    expect(loaded).toMatchObject({ _tag: "ok", value: { insights: { analysis: { retained: { value: { findings: [{ id: findingId, disposition: "dismissed" }] } } } } } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports a missing incremental comparison truthfully", async () => {
    const github = fakeGitHub({
      current: summary(headSha),
      comments: { threads: [] },
      checks: { overall: "passing", checks: [] },
    });
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const session = completedSession(paths, { incremental: true });
      expect((await sessions.save(session))._tag).toBe("ok");
      const loaded = await projection.load({ profileId, sessionId: session.id });
      expect(loaded._tag).toBe("ok");
      if (loaded._tag === "err") return;
      expect(loaded.value.state).toBe("review");
      expect(loaded.value.insights.analysis.status).toBe("current");
      expect(loaded.value.commits).toEqual([]);
      expect(loaded.value.publishedFeedback).toEqual({ reviews: [], comments: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects a prepared session without attempt history or preparation work", async () => {
    const github = fakeGitHub({
      current: summary(headSha),
      comments: { threads: [{ id: "thread-1", body: "Existing discussion", state: "open" }] } as never,
      checks: { overall: "pending", checks: [] },
    });
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const id = sessionId();
      const session = createReviewSession({
        key: { profileId, host, owner, repo, prNumber: number, headSha },
        pr: { headSha, isDraft: false, isOpen: true },
        patchPath: must(parseAbsolutePath(paths.patchFile(profileId, id))),
        worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, id))), headSha },
        createdAt: now,
      });
      const batch = createEmptyReviewBatch({ sessionId: session.id, createdAt: now });
      expect((await sessions.save({ ...session, batch: { state: batch.state }, batchContent: batch }))._tag).toBe("ok");
      const loaded = await projection.load({ profileId, sessionId: session.id });
      expect(loaded._tag).toBe("ok");
      if (loaded._tag === "err") return;
      expect(loaded.value.state).toBe("review");
      expect(loaded.value.revision.freshness).toBe("fresh");
      expect(loaded.value.checks).toEqual({ overall: "pending", checks: [] });
      expect(loaded.value.comments).toMatchObject({ threads: [{ id: "thread-1" }] });
      expect(loaded.value.draft).toMatchObject({ sessionId: session.id, items: [] });
      expect(loaded.value.mergeReadiness).toEqual({
        _tag: "Blocked",
        blockers: ["mergeability_unknown"],
        warnings: [],
      });
      expect(loaded.value.session).toEqual({
        id: session.id,
        key: { profileId, host, owner, repo, prNumber: number, headSha },
      });
      expect(loaded.value.recoveryView).toEqual({ noticeKey: "ready_to_review", tone: "positive", actionKey: "run_review" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects the analysis matrix into one Review envelope", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly state: ReviewSessionState;
      readonly expected: "not_generated" | "running" | "current" | "outdated" | "failed";
      readonly visibleResult?: boolean;
      readonly current?: PullRequestSummary;
    }> = [
      { name: "no analysis", state: { _tag: "Created" }, expected: "not_generated" },
      { name: "running", state: { _tag: "Running", attemptId: "001" as never }, expected: "running" },
      { name: "current", state: { _tag: "ReviewCompleted", attemptId: "001" as never }, expected: "current", visibleResult: true },
      { name: "outdated", state: { _tag: "ReviewCompleted", attemptId: "001" as never }, expected: "outdated", visibleResult: true, current: summary(staleHeadSha) },
      { name: "failed replacement", state: { _tag: "ReviewFailed", attemptId: "001" as never, error: { category: "flue", message: "safe" } }, expected: "failed", visibleResult: true },
    ];
    for (const fixture of cases) {
      const github = fakeGitHub({ current: fixture.current ?? summary(headSha), checks: { overall: "passing", checks: [] } });
      const { root, paths, projection, sessions } = await setup(github);
      try {
        const base = preparedSession(paths, fixture.state, "001");
        const session: ReviewSession = fixture.visibleResult === true
          ? { ...base, visibleResult: { changeSummary: "saved", verdict: "comment", summary: "saved", findings: [], validationPlan: [], assumptions: [] } as never }
          : base;
        expect((await sessions.save(session))._tag).toBe("ok");
        if (fixture.state._tag === "Running" || fixture.state._tag === "ReviewCompleted" || fixture.state._tag === "ReviewFailed") {
          expect((await sessions.saveAttempt(profileId, session.id, attemptFor(paths, session, fixture.state._tag === "Running" ? { _tag: "Running", flueRunId: "flue-1" } : fixture.state._tag === "ReviewFailed" ? { _tag: "Failed", error: { category: "flue", message: "safe" } } : { _tag: "Completed", resultPath: must(parseAbsolutePath(paths.attemptResultFile(profileId, session.id, "001" as never))) })))._tag).toBe("ok");
        }
        const loaded = await projection.load({ profileId, sessionId: session.id });
        expect(loaded._tag).toBe("ok");
        if (loaded._tag === "ok") expect(loaded.value.insights.analysis.status, fixture.name).toBe(fixture.expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("projects terminal status from the stable Review aggregate", async () => {
    const github = fakeGitHub({ current: summary(headSha), checks: { overall: "passing", checks: [] } });
    const { root, paths, sessions } = await setup(github);
    try {
      const session = preparedSession(paths, { _tag: "Merged", mergedAt: now });
      expect((await sessions.save(session))._tag).toBe("ok");
      const reviews = new ReviewStore(paths);
      const stableReview: Review = createReview({ identity: { profileId, host, owner, repo, prNumber: number }, currentSessionId: session.id, headSha, createdAt: now });
      expect((await reviews.save(stableReview))._tag).toBe("ok");
      const projection = new ReviewWorkbenchProjectionService(new ProfileStore(paths), sessions, github, () => now, undefined, reviews);
      const loaded = await projection.loadLocal({ profileId, sessionId: session.id });
      expect(loaded).toMatchObject({ _tag: "ok", value: { review: { status: "open" } } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects a terminal Review status without exposing session internals", async () => {
    const github = fakeGitHub({ current: summary(headSha), checks: { overall: "passing", checks: [] } });
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const session = preparedSession(paths, { _tag: "Merged", mergedAt: now });
      expect((await sessions.save(session))._tag).toBe("ok");
      const loaded = await projection.loadLocal({ profileId, sessionId: session.id });
      expect(loaded).toMatchObject({ _tag: "ok", value: { state: "review", review: { status: "merged" } } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects every recovery matrix action through the workbench boundary", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly state: ReviewSessionState;
      readonly attemptState?: ReviewAttemptState;
      readonly liveRun?: boolean;
      readonly activePreparation?: boolean;
      readonly expected: ReviewWorkbenchProjection["recoveryView"];
    }> = [
      { name: "run review", state: { _tag: "Created" }, expected: { noticeKey: "ready_to_review", tone: "positive", actionKey: "run_review" } },
      { name: "interrupted", state: { _tag: "Running", attemptId: "001" as never }, attemptState: { _tag: "Interrupted", interruptedAt: now }, expected: { noticeKey: "review_interrupted", tone: "warning", actionKey: "start_again" } },
      { name: "failed", state: { _tag: "ReviewFailed", attemptId: "001" as never, error: { category: "flue", message: "failed" } }, attemptState: { _tag: "Failed", error: { category: "flue", message: "failed" } }, expected: { noticeKey: "review_failed", tone: "warning", actionKey: "try_again" } },
      { name: "stale", state: { _tag: "Stale", reason: "head_changed" }, expected: { noticeKey: "needs_preparation", tone: "warning", actionKey: "prepare_again" } },
      { name: "unavailable", state: { _tag: "Merged", mergedAt: now }, expected: undefined },
      { name: "preparing", state: { _tag: "Created" }, activePreparation: true, expected: { noticeKey: "preparing", tone: "neutral" } },
      { name: "reconnect", state: { _tag: "Running", attemptId: "001" as never }, attemptState: { _tag: "Running", flueRunId: "flue-1" }, liveRun: true, expected: { noticeKey: "review_in_progress", tone: "positive", actionKey: "reconnect" } },
    ];
    for (const fixture of cases) {
      const github = fakeGitHub({ current: summary(headSha), checks: { overall: "pending", checks: [] } });
      const { root, paths, sessions } = await setup(github);
      try {
        const session = preparedSession(paths, fixture.state, fixture.attemptState === undefined ? undefined : "001");
        expect((await sessions.save(session))._tag).toBe("ok");
        if (fixture.attemptState !== undefined) {
          expect((await sessions.saveAttempt(profileId, session.id, attemptFor(paths, session, fixture.attemptState)))._tag).toBe("ok");
        }
        const runs = new ReviewRunRegistry(() => now);
        if (fixture.liveRun === true) runs.create({ sessionId: session.id, attemptId: "001" });
        const projection = new ReviewWorkbenchProjectionService(
          new ProfileStore(paths),
          sessions,
          github,
          () => now,
          {
            paths,
            runs,
            preparation: fixture.activePreparation === true
              ? { activeFor: async () => ({ _tag: "ok", value: { profileId, sessionId: session.id, phase: "preparing" as const } }) }
              : { activeFor: async () => ({ _tag: "ok", value: undefined }) },
          },
        );
        const loaded = await projection.loadLocal({ profileId, sessionId: session.id });
        expect(loaded._tag).toBe("ok");
        if (loaded._tag === "ok") {
          if (fixture.expected === undefined) expect(loaded.value.recoveryView).toBeUndefined();
          else expect(loaded.value.recoveryView).toEqual(fixture.expected);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("fails closed when the preparation journal cannot be read", async () => {
    const github = fakeGitHub({ current: summary(headSha), checks: { overall: "pending", checks: [] } });
    const { root, paths, sessions } = await setup(github);
    try {
      const session = completedSession(paths);
      expect((await sessions.save(session))._tag).toBe("ok");
      const projection = new ReviewWorkbenchProjectionService(
        new ProfileStore(paths),
        sessions,
        github,
        () => now,
        { paths, preparation: { activeFor: async () => ({ _tag: "err", error: { _tag: "PreparationJournalFailed" } }) } },
      );
      const loaded = await projection.loadLocal({ profileId, sessionId: session.id });
      expect(loaded).toMatchObject({
        _tag: "ok",
        value: { recoveryView: { noticeKey: "preparing", tone: "neutral" } },
      });
      if (loaded._tag === "ok") {
        expect(loaded.value.recoveryView?.actionKey).toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces the last run failure for a failed session", async () => {
    const github = fakeGitHub({
      current: summary(headSha),
      checks: { overall: "pending", checks: [] },
    });
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const id = sessionId();
      const base = createReviewSession({
        key: { profileId, host, owner, repo, prNumber: number, headSha },
        pr: { headSha, isDraft: false, isOpen: true },
        patchPath: must(parseAbsolutePath(paths.patchFile(profileId, id))),
        worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, id))), headSha },
        createdAt: now,
      });
      const session: ReviewSession = {
        ...base,
        state: { _tag: "ReviewFailed", attemptId: "001" as never, error: { category: "flue", message: "The review workflow did not complete." } },
      };
      expect((await sessions.save(session))._tag).toBe("ok");
      const loaded = await projection.load({ profileId, sessionId: session.id });
      expect(loaded).toMatchObject({
        _tag: "ok",
        value: {
          session: { id: session.id },
          recoveryView: { noticeKey: "review_failed", tone: "warning", actionKey: "try_again" },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps an attempts-list storage failure to SessionStorageUnavailable", async () => {
    const github = fakeGitHub({
      current: summary(headSha),
      comments: { threads: [] },
      checks: { overall: "passing", checks: [] },
    });
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const session = completedSession(paths);
      expect((await sessions.save(session))._tag).toBe("ok");
      const attemptsPath = paths.attemptsDirectory(profileId, session.id);
      await mkdir(dirname(attemptsPath), { recursive: true });
      await writeFile(attemptsPath, "not a directory", "utf8");
      const loaded = await projection.load({ profileId, sessionId: session.id });
      expect(loaded).toEqual({ _tag: "err", error: { _tag: "SessionStorageUnavailable" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown profiles and sessions without preparing anything", async () => {
    const github = fakeGitHub({});
    const { root, projection } = await setup(github);
    try {
      const missing = await projection.load({ profileId, sessionId: sessionId() });
      expect(missing).toEqual({ _tag: "err", error: { _tag: "SessionNotFound" } });
      const unknownProfile = await projection.load({ profileId: "unknown" as never, sessionId: sessionId() });
      expect(unknownProfile).toEqual({ _tag: "err", error: { _tag: "ProfileNotFound" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}
