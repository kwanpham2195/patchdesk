import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { parseAbsolutePath, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseIsoTimestamp, parsePullRequestNumber, parseReviewAttemptId, parseWorkspaceProfileId, type GitSha, type WorkspaceProfileId } from "../../src/domain/ids";
import { createReviewSession, type ReviewSession } from "../../src/domain/review-session";
import { createReview, markReviewTerminal } from "../../src/domain/review";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { err, ok } from "../../src/domain/result";
import { ReviewHeadVerifier } from "../../src/services/review-head-verifier";
import { ReviewExecutionService } from "../../src/services/review-execution-service";

const roots: string[] = [];
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ReviewExecutionService", () => {
  it("persists a runnable attempt with copied immutable artifacts", async () => {
    const fixture = await preparedFixture();
    const service = new ReviewExecutionService(fixture.store, fixture.paths, availableCatalog(), () => now);

    const started = await service.start({ profileId: fixture.profileId, sessionId: fixture.session.id, model: "fixture-model", reasoning: "medium" });

    expect(started).toMatchObject({ _tag: "ok", value: { attemptId: "001", model: "fixture-model", reasoning: "medium", metadata: { access: "Read-only repository inspection" } } });
    await expect(fixture.store.loadAttempt(fixture.profileId, fixture.session.id, must(parseReviewAttemptId(must(started).attemptId)))).resolves.toMatchObject({ _tag: "ok", value: { state: { _tag: "Starting" } } });
  });

  it("rejects unavailable and unsupported catalogs without creating an attempt", async () => {
    const fixture = await preparedFixture();
    const unavailable = new ReviewExecutionService(fixture.store, fixture.paths, { async get() { return err({ _tag: "PiRuntimeModelCatalogUnavailable" as const }); } }, () => now);
    await expect(unavailable.start({ profileId: fixture.profileId, sessionId: fixture.session.id, model: "fixture-model", reasoning: "medium" })).resolves.toEqual({ _tag: "err", error: { reason: "catalog_unavailable" } });
    const unsupported = new ReviewExecutionService(fixture.store, fixture.paths, availableCatalog(), () => now);
    await expect(unsupported.start({ profileId: fixture.profileId, sessionId: fixture.session.id, model: "other-model", reasoning: "medium" })).resolves.toEqual({ _tag: "err", error: { reason: "unsupported_model" } });
    await expect(fixture.store.listAttempts(fixture.profileId, fixture.session.id)).resolves.toEqual({ _tag: "ok", value: [] });
  });

  it("rejects a merged session without allocating another attempt", async () => {
    const fixture = await preparedFixture({ state: { _tag: "Merged", mergedAt: now }, updatedAt: now });
    const service = new ReviewExecutionService(fixture.store, fixture.paths, availableCatalog(), () => now);
    await expect(service.start({ profileId: fixture.profileId, sessionId: fixture.session.id, model: "fixture-model", reasoning: "medium" })).resolves.toEqual({ _tag: "err", error: { reason: "not_runnable" } });
    await expect(fixture.store.listAttempts(fixture.profileId, fixture.session.id)).resolves.toEqual({ _tag: "ok", value: [] });
  });

  it("persists the remote head outcome and does not start when the prepared head is stale", async () => {
    const fixture = await preparedFixture();
    const profiles = new ProfileStore(fixture.paths);
    await profiles.save(profile(fixture.profileId));
    const currentHeadSha = must(parseGitSha("1234567890abcdef1234567890abcdef12345678"));
    const verifier = new ReviewHeadVerifier(profiles, fixture.store, new FakeGitHubAdapter({
      pullRequest: pullRequest(fixture.session, currentHeadSha),
    }), () => now);
    const service = new ReviewExecutionService(fixture.store, fixture.paths, availableCatalog(), () => now, verifier);

    await expect(service.start({ profileId: fixture.profileId, sessionId: fixture.session.id, model: "fixture-model", reasoning: "medium" })).resolves.toEqual({ _tag: "err", error: { reason: "head_changed" } });
    await expect(fixture.store.load(fixture.profileId, fixture.session.id)).resolves.toMatchObject({
      _tag: "ok",
      value: { state: { _tag: "Stale", reason: "head_changed", currentHeadSha } },
    });
    await expect(fixture.store.listAttempts(fixture.profileId, fixture.session.id)).resolves.toEqual({ _tag: "ok", value: [] });
  });

  it("rejects a forged run request when the owning Review is terminal", async () => {
    const fixture = await preparedFixture();
    const reviews = new ReviewStore(fixture.paths);
    const review = createReview({
      identity: {
        profileId: fixture.profileId,
        host: fixture.session.key.host,
        owner: fixture.session.key.owner,
        repo: fixture.session.key.repo,
        prNumber: fixture.session.key.prNumber,
      },
      currentSessionId: fixture.session.id,
      headSha: fixture.session.key.headSha,
      createdAt: now,
    });
    expect(await reviews.save(review)).toMatchObject({ _tag: "ok" });
    expect(await reviews.save(markReviewTerminal(review, "merged", now), review.updatedAt)).toMatchObject({ _tag: "ok" });
    const service = new ReviewExecutionService(fixture.store, fixture.paths, availableCatalog(), () => now, undefined, undefined, { reviews });

    await expect(service.start({ profileId: fixture.profileId, sessionId: fixture.session.id, model: "fixture-model", reasoning: "medium" })).resolves.toEqual({ _tag: "err", error: { reason: "not_runnable" } });
    await expect(fixture.store.listAttempts(fixture.profileId, fixture.session.id)).resolves.toEqual({ _tag: "ok", value: [] });
  });

  it("rejects an active attempt without allocating another attempt", async () => {
    const fixture = await preparedFixture();
    const first = await fixture.store.beginAttempt({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      updatedAt: now,
      createAttempt: async () => err({ _tag: "StorageFailure" as const, operation: "write" as const, reason: "io" as const }),
    });
    expect(first).toMatchObject({ _tag: "err" });
    await fixture.store.save({ ...fixture.session, state: { _tag: "Running", attemptId: must(parseReviewAttemptId("001")) }, currentAttemptId: must(parseReviewAttemptId("001")) });
    const service = new ReviewExecutionService(fixture.store, fixture.paths, availableCatalog(), () => now);

    await expect(service.start({ profileId: fixture.profileId, sessionId: fixture.session.id, model: "fixture-model", reasoning: "medium" })).resolves.toEqual({ _tag: "err", error: { reason: "not_runnable" } });
    await expect(fixture.store.listAttempts(fixture.profileId, fixture.session.id)).resolves.toEqual({ _tag: "ok", value: [] });
  });
});

function availableCatalog() { return { async get() { return ok({ models: [{ id: "fixture-model", label: "Fixture model" }], defaultModel: "fixture-model" }); } }; }

function profile(id: WorkspaceProfileId) {
  return must(parseWorkspaceProfileConfig({ id, label: "CFW", githubHost: "github.com", ghAccount: "fixture", ownerFilters: [], workspaceRoots: [], rulePaths: [], repos: [] }));
}

function pullRequest(session: ReviewSession, headSha: GitSha) {
  return { ref: { host: session.key.host, owner: session.key.owner, repo: session.key.repo, number: session.key.prNumber }, headSha, isDraft: false, isOpen: true, title: "Fixture PR", author: "fixture", headBranch: "main", baseBranch: "main", reviewState: "none" as const, mergeability: "mergeable" as const, labels: [], updatedAt: now };
}

async function preparedFixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-review-execution-")); roots.push(root);
  const paths = PatchdeskPaths.forTest(root); const profileId = must(parseWorkspaceProfileId("cfw"));
  const key = { profileId, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)), headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")) };
  const session = { ...createReviewSession({ key, pr: { headSha: key.headSha, isDraft: false, isOpen: true }, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "placeholder" as never))), headSha: key.headSha }, createdAt: now }), ...overrides };
  const stored = { ...session, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, session.id))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, session.id))), headSha: key.headSha } };
  const store = new ReviewSessionStore(paths); await store.save(stored);
  const prepared = { contextPath: paths.preparedContextFile(profileId, stored.id), reviewInputPath: paths.preparedReviewInputFile(profileId, stored.id), debugPath: paths.preparedDebugFile(profileId, stored.id) };
  await mkdir(dirname(prepared.contextPath), { recursive: true });
  await Promise.all([writeFile(stored.patchPath, "diff --git a/a.ts b/a.ts\n", "utf8"), writeFile(prepared.contextPath, "{}", "utf8"), writeFile(prepared.reviewInputPath, "Review", "utf8"), writeFile(prepared.debugPath, "{}", "utf8")]);
  return { paths, profileId, session: stored, store };
}

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T { if (result._tag === "err") throw new Error("Invalid fixture"); return result.value; }
