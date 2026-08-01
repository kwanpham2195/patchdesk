import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewArtifactStorage, type QuarantineFailure } from "../../src/adapters/storage/review-artifact-storage";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  createReviewSessionId,
  parseAbsolutePath,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewAttemptId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { ReviewAttempt, ReviewAttemptState } from "../../src/domain/review-attempt";
import { createReviewSession } from "../../src/domain/review-session";
import type { ReviewSession, ReviewSessionState } from "../../src/domain/review-session";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ReviewDiagnosticService } from "../../src/services/review-diagnostic-service";
import { ReviewRecoveryService } from "../../src/services/review-recovery-service";

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (result._tag === "err") throw new Error("fixture");
  return result.value;
}

const profileId = must(parseWorkspaceProfileId("cfw"));
const headSha = must(parseGitSha("2222222222222222222222222222222222222222"));
const timestamp = must(parseIsoTimestamp("2026-07-18T00:00:00.000Z"));

class FailingQuarantineArtifacts extends ReviewArtifactStorage {
  override async quarantineInvalidEntry(
    _profileId: typeof profileId,
    _entryName: string,
  ): Promise<{ readonly _tag: "err"; readonly error: QuarantineFailure }> {
    void _profileId;
    void _entryName;
    return { _tag: "err", error: { _tag: "StorageFailure", operation: "write", reason: "io" } };
  }
}

it("records a diagnostic when quarantine fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-recovery-service-"));
  try {
    const paths = PatchdeskPaths.forTest(root);
    const profile = parseWorkspaceProfileConfig({
      id: "cfw",
      label: "CFW",
      githubHost: "github.com",
      ghAccount: "fixture",
      ownerFilters: [],
      workspaceRoots: [],
      rulePaths: [],
      repos: [],
    });
    if (profile._tag === "err") throw new Error("fixture");
    const profiles = new ProfileStore(paths);
    expect((await profiles.save(profile.value))._tag).toBe("ok");
    await mkdir(join(paths.profileReviewsDirectory(profileId), "broken-entry"), { recursive: true });
    const sessions = new ReviewSessionStore(paths);
    const diagnostics = new ReviewDiagnosticService(paths, () => timestamp, () => "incident-quarantine");
    const artifacts = new FailingQuarantineArtifacts(paths, () => timestamp);
    const service = new ReviewRecoveryService(profiles, sessions, () => timestamp, { artifacts, diagnostics });

    const result = await service.reconcile();

    expect(result.failed).toBe(1);
    const events = await diagnostics.recent(profileId);
    expect(events).toMatchObject({
      _tag: "ok",
      value: expect.arrayContaining([expect.objectContaining({ phase: "quarantine-failed" })]),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("quarantines malformed entries, records diagnostics, and continues scanning valid sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-recovery-service-"));
  try {
    const paths = PatchdeskPaths.forTest(root);
    const profile = parseWorkspaceProfileConfig({
      id: "cfw",
      label: "CFW",
      githubHost: "github.com",
      ghAccount: "fixture",
      ownerFilters: [],
      workspaceRoots: [],
      rulePaths: [],
      repos: [],
    });
    if (profile._tag === "err") throw new Error("fixture");
    const profiles = new ProfileStore(paths);
    expect((await profiles.save(profile.value))._tag).toBe("ok");
    const sessions = new ReviewSessionStore(paths);
    const sessionId = createReviewSessionId({ profileId, host: "github.com" as never, owner: "centraldigital" as never, repo: "patchdesk" as never, prNumber: 42 as never, headSha });
    const session = createReviewSession({
      key: { profileId, host: "github.com" as never, owner: "centraldigital" as never, repo: "patchdesk" as never, prNumber: 42 as never, headSha },
      pr: { headSha, isDraft: false, isOpen: true },
      patchPath: must(parseAbsolutePath(paths.patchFile(profileId, sessionId))),
      worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, sessionId))), headSha },
      createdAt: timestamp,
    });
    expect((await sessions.save(session))._tag).toBe("ok");
    await mkdir(join(paths.profileReviewsDirectory(profileId), "broken-entry"), { recursive: true });
    const artifacts = new ReviewArtifactStorage(paths, () => timestamp);
    const service = new ReviewRecoveryService(profiles, sessions, () => timestamp, { paths, artifacts });

    const result = await service.reconcile();

    expect(result.failed).toBe(0);
    const diagnosticText = await readFile(join(paths.profileReviewsDirectory(profileId), "diagnostics.jsonl"), "utf8");
    expect(diagnosticText).toContain('"entryName":"broken-entry"');
    expect(await artifacts.listQuarantined(profileId)).toMatchObject({ _tag: "ok", value: [{ entryName: expect.stringMatching(/^invalid-/) }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { name: "ReviewCompleted", state: "ReviewCompleted" as const },
  { name: "Merged", state: "Merged" as const },
])("skips a terminal $name session with retained attempt history", async ({ state }) => {
  const fixture = await recoveryFixture(
    state === "ReviewCompleted"
      ? { _tag: state, attemptId: must(parseReviewAttemptId("001")) }
      : { _tag: state, mergedAt: timestamp },
    { _tag: "Completed", resultPath: must(parseAbsolutePath("/tmp/fixture-result.json")) },
  );
  try {
    const beforeSession = await fixture.sessions.load(profileId, fixture.session.id);
    const beforeAttempt = await fixture.sessions.loadAttempt(profileId, fixture.session.id, fixture.attempt.id);
    expect(beforeSession._tag).toBe("ok");
    expect(beforeAttempt._tag).toBe("ok");

    const result = await fixture.service.reconcile();

    expect(result).toEqual({ recovered: 0, failed: 0 });
    expect(await fixture.sessions.load(profileId, fixture.session.id)).toEqual(beforeSession);
    expect(await fixture.sessions.loadAttempt(profileId, fixture.session.id, fixture.attempt.id)).toEqual(beforeAttempt);
    expect(await fixture.diagnostics.recent(profileId)).toEqual({ _tag: "ok", value: [] });
  } finally {
    await fixture.cleanup();
  }
});

it.each([
  { name: "Starting", state: { _tag: "Starting" as const } },
  { name: "Running", state: { _tag: "Running" as const, flueRunId: "fixture-run" } },
])("still recovers a Running session with a $name attempt", async ({ state }) => {
  const fixture = await recoveryFixture(
    { _tag: "Running", attemptId: must(parseReviewAttemptId("001")) },
    state,
  );
  try {
    const result = await fixture.service.reconcile();

    expect(result).toEqual({ recovered: 1, failed: 0 });
    expect(await fixture.sessions.load(profileId, fixture.session.id)).toMatchObject({
      _tag: "ok",
      value: {
        state: { _tag: "Running", attemptId: fixture.attempt.id },
        currentAttemptId: fixture.attempt.id,
      },
    });
    expect(await fixture.sessions.loadAttempt(profileId, fixture.session.id, fixture.attempt.id)).toMatchObject({
      _tag: "ok",
      value: { state: { _tag: "Interrupted", interruptedAt: timestamp }, completedAt: timestamp },
    });
    expect(await fixture.diagnostics.recent(profileId)).toEqual({ _tag: "ok", value: [] });
  } finally {
    await fixture.cleanup();
  }
});

it("reports an inconsistent attempt lifecycle for a Running session", async () => {
  const fixture = await recoveryFixture(
    { _tag: "Running", attemptId: must(parseReviewAttemptId("001")) },
    { _tag: "Completed", resultPath: must(parseAbsolutePath("/tmp/fixture-result.json")) },
  );
  try {
    const beforeSession = await fixture.sessions.load(profileId, fixture.session.id);
    const beforeAttempt = await fixture.sessions.loadAttempt(profileId, fixture.session.id, fixture.attempt.id);

    expect(await fixture.service.reconcile()).toEqual({ recovered: 0, failed: 1 });
    expect(await fixture.sessions.load(profileId, fixture.session.id)).toEqual(beforeSession);
    expect(await fixture.sessions.loadAttempt(profileId, fixture.session.id, fixture.attempt.id)).toEqual(beforeAttempt);
    expect(await fixture.diagnostics.recent(profileId)).toMatchObject({
      _tag: "ok",
      value: [expect.objectContaining({ phase: "attempt-recover", sessionId: fixture.session.id })],
    });
  } finally {
    await fixture.cleanup();
  }
});

async function recoveryFixture(
  state: ReviewSessionState,
  attemptState: ReviewAttemptState,
): Promise<{
  readonly sessions: ReviewSessionStore;
  readonly diagnostics: ReviewDiagnosticService;
  readonly service: ReviewRecoveryService;
  readonly session: ReviewSession;
  readonly attempt: ReviewAttempt;
  readonly cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-recovery-service-"));
  const paths = PatchdeskPaths.forTest(root);
  const profile = parseWorkspaceProfileConfig({
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "fixture",
    ownerFilters: [],
    workspaceRoots: [],
    rulePaths: [],
    repos: [],
  });
  if (profile._tag === "err") throw new Error("fixture");
  const profiles = new ProfileStore(paths);
  expect((await profiles.save(profile.value))._tag).toBe("ok");
  const sessions = new ReviewSessionStore(paths);
  const key = {
    profileId,
    host: must(parseGitHubHost("github.com")),
    owner: must(parseGitHubOwner("centraldigital")),
    repo: must(parseGitHubRepoName("patchdesk")),
    prNumber: must(parsePullRequestNumber(42)),
    headSha,
  };
  const seed = createReviewSession({
    key,
    pr: { headSha, isDraft: false, isOpen: true },
    patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never))),
    worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "placeholder" as never))), headSha },
    createdAt: timestamp,
  });
  const attemptId = must(parseReviewAttemptId("001"));
  const session: ReviewSession = {
    ...seed,
    patchPath: must(parseAbsolutePath(paths.patchFile(profileId, seed.id))),
    worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, seed.id))), headSha },
    state,
    currentAttemptId: attemptId,
    updatedAt: timestamp,
  };
  const attempt: ReviewAttempt = {
    id: attemptId,
    sessionId: session.id,
    state: attemptState,
    ...(attemptState._tag === "Running" ? { flueRunId: attemptState.flueRunId } : {}),
    ...(attemptState._tag === "Completed" ? { resultPath: must(parseAbsolutePath(paths.attemptResultFile(profileId, session.id, attemptId))) } : {}),
    model: "fixture-model",
    reasoning: "medium",
    reviewSkillVersion: must(parseContentHash("a".repeat(64))),
    contextHash: must(parseContentHash("b".repeat(64))),
    contextPath: must(parseAbsolutePath(paths.attemptContextFile(profileId, session.id, attemptId))),
    reviewInputPath: must(parseAbsolutePath(paths.attemptReviewInputFile(profileId, session.id, attemptId))),
    debugPath: must(parseAbsolutePath(paths.attemptDebugFile(profileId, session.id, attemptId))),
    startedAt: timestamp,
  };
  expect(await sessions.save(session)).toEqual({ _tag: "ok", value: undefined });
  expect(await sessions.saveAttempt(profileId, session.id, attempt)).toEqual({ _tag: "ok", value: undefined });
  const diagnostics = new ReviewDiagnosticService(paths, () => timestamp, () => "incident-recovery");
  const service = new ReviewRecoveryService(profiles, sessions, () => timestamp, {
    paths,
    artifacts: new ReviewArtifactStorage(paths, () => timestamp),
    diagnostics,
  });
  return {
    sessions,
    diagnostics,
    service,
    session,
    attempt,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
