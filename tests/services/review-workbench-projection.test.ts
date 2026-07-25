import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import type { GitHubReader } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import type { CheckSummary, GitHubComments, PullRequestSummary } from "../../src/domain/github-context";
import {
  createReviewSessionId,
  parseAbsolutePath,
  parseGitSha,
  parseIsoTimestamp,
  type GitSha,
} from "../../src/domain/ids";
import { createReviewSession, type ReviewSession } from "../../src/domain/review-session";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ReviewWorkbenchProjectionService } from "../../src/services/review-workbench-projection";

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

async function setup(github: ReturnType<typeof fakeGitHub>): Promise<{
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
  );
  return { root, paths, projection, sessions };
}

describe("ReviewWorkbenchProjectionService", () => {
  it("opens saved local work without reading GitHub", async () => {
    const github = fakeGitHub({ current: summary(headSha), comments: { threads: [] }, checks: { overall: "passing", checks: [] } });
    const { root, paths, projection, sessions } = await setup(github);
    try {
      const session = completedSession(paths);
      expect((await sessions.save(session))._tag).toBe("ok");

      const loaded = await projection.loadLocal({ profileId, sessionId: session.id });

      expect(loaded).toMatchObject({ _tag: "ok", value: { state: "completed", freshness: "not_refreshed" } });
      expect(github.calls).toEqual([]);
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
      expect(loaded.value.state).toBe("completed");
      if (loaded.value.state !== "completed") return;
      expect(loaded.value.fullPatch).toBeUndefined();
      expect(loaded.value.freshness).toBe("fresh");
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
      if (loaded.value.state !== "completed") throw new Error("expected completed");
      expect(loaded.value.freshness).toBe("unavailable");
      expect(loaded.value.comments).toEqual({ threads: [] });
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
      if (loaded.value.state !== "completed") throw new Error("expected completed");
      expect(loaded.value.freshness).toBe("stale");
      expect(loaded.value.currentHeadSha).toBe(staleHeadSha);
      expect(loaded.value.reviewedHeadSha).toBe(headSha);
      expect(loaded.value.result).toMatchObject({ summary: "Persisted review result" });
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
      if (loaded.value.state !== "completed") throw new Error("expected completed");
      expect(loaded.value.comparisonAvailability).toBe("missing");
      expect(loaded.value.comparison).toBeUndefined();
      expect(loaded.value.reviewScope).toEqual({
        kind: "incremental",
        baseSessionId: "github.com__centraldigital__patchdesk__pr-42__sha-11111111__000000000000",
        baseHeadSha: "1111111111111111111111111111111111111111",
        headSha,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects a prepared session without attempt history or preparation work", async () => {
    const github = fakeGitHub({
      current: summary(headSha),
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
      expect((await sessions.save(session))._tag).toBe("ok");
      const loaded = await projection.load({ profileId, sessionId: session.id });
      expect(loaded._tag).toBe("ok");
      if (loaded._tag === "err") return;
      expect(loaded.value.state).toBe("review_started");
      expect(loaded.value.freshness).toBe("fresh");
      expect(loaded.value.checks).toEqual({ overall: "pending", checks: [] });
      expect(loaded.value.session).toEqual({
        id: session.id,
        key: { profileId, host, owner, repo, prNumber: number, headSha },
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
