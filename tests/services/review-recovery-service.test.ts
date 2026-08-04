import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewArtifactStorage, type QuarantineFailure } from "../../src/adapters/storage/review-artifact-storage";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import { ReviewRemoteStore } from "../../src/adapters/storage/review-remote-store";
import { MergeOperationStore } from "../../src/adapters/storage/merge-operation-store";
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
import { markMergeOutcomeUnknown, requestMergeOperation } from "../../src/domain/merge-operation";
import { ok } from "../../src/domain/result";
import type { ReviewSession, ReviewSessionState } from "../../src/domain/review-session";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { ReviewDiagnosticService } from "../../src/services/review-diagnostic-service";
import { ReviewRecoveryService } from "../../src/services/review-recovery-service";
import { ReviewWriteGate } from "../../src/services/review-write-gate";
import { UnifiedReviewMigration } from "../../src/services/unified-review-migration";
import { applyReviewBatch, planBatchOperations } from "../../src/services/review-submission-service";
import { createReviewId } from "../../src/domain/ids";

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (result._tag === "err") throw new Error("fixture");
  return result.value;
}

const profileId = must(parseWorkspaceProfileId("cfw"));
const headSha = must(parseGitSha("2222222222222222222222222222222222222222"));
const timestamp = must(parseIsoTimestamp("2026-07-18T00:00:00.000Z"));

class FailingSuccessorSessionStore extends ReviewSessionStore {
  private failNextSave = true;

  override async save(session: unknown) {
    if (this.failNextSave) {
      this.failNextSave = false;
      return { _tag: "err" as const, error: { _tag: "StorageFailure" as const, operation: "write" as const, reason: "io" as const } };
    }
    return super.save(session);
  }
}

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

it("recovers a Submitted batch after successor storage failure and installs it once on restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-submitted-recovery-"));
  try {
    const paths = PatchdeskPaths.forTest(root);
    const profile = must(parseWorkspaceProfileConfig({ id: "cfw", label: "CFW", githubHost: "github.com", ghAccount: "fixture", ownerFilters: [], workspaceRoots: [], rulePaths: [], repos: [] }));
    const profiles = new ProfileStore(paths);
    expect(await profiles.save(profile)).toEqual({ _tag: "ok", value: undefined });
    const initialStore = new ReviewSessionStore(paths);
    const key = { profileId, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)), headSha };
    const seed = createReviewSession({ key, pr: { headSha, isDraft: false, isOpen: true }, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "placeholder" as never))), headSha }, createdAt: timestamp });
    const itemId = "inline-1" as never;
    const submittedBatch = { sessionId: seed.id, state: { _tag: "Submitted" as const, reviewId: "review-1", event: "COMMENT" as const }, summaryBody: "Summary", suggestedEvent: "COMMENT" as const, items: [{ _tag: "InlineComment" as const, id: itemId, provenance: { _tag: "human" as const }, source: "manual" as const, anchor: { path: "src/a.ts" as never, startLine: 1, line: 1, side: "new" as const }, body: "Feedback", include: true, postability: "postable" as const }], receipts: [{ _tag: "PendingReviewCreated" as const, reviewId: "review-1", itemIds: [itemId] }], createdAt: timestamp, updatedAt: timestamp };
    const submitted: ReviewSession = { ...seed, batch: { state: submittedBatch.state }, batchContent: submittedBatch, submittedReview: { reviewId: "review-1", event: "COMMENT", submittedAt: timestamp }, updatedAt: timestamp };
    expect(await initialStore.save(submitted)).toEqual({ _tag: "ok", value: undefined });

    const firstAttempt = new ReviewRecoveryService(profiles, new FailingSuccessorSessionStore(paths), () => timestamp);
    expect(await firstAttempt.reconcilePublication(profileId, createReviewId(key))).toEqual({ recovered: 0, failed: 1 });
    expect(await initialStore.load(profileId, submitted.id)).toMatchObject({ _tag: "ok", value: { batchContent: { state: { _tag: "Submitted" } } } });

    const restarted = new ReviewRecoveryService(profiles, new ReviewSessionStore(paths), () => timestamp);
    expect(await restarted.reconcile()).toEqual({ recovered: 1, failed: 0 });
    expect(await restarted.reconcile()).toEqual({ recovered: 0, failed: 0 });
    expect(await initialStore.load(profileId, submitted.id)).toMatchObject({ _tag: "ok", value: { batchContent: { state: { _tag: "Local" }, receipts: [] }, archivedReceipts: [{ _tag: "PendingReviewCreated", reviewId: "review-1" }], submittedReview: { reviewId: "review-1" } } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("recovers an older Submitted session after migration selects a newer current session", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-legacy-submitted-recovery-"));
  try {
    const paths = PatchdeskPaths.forTest(root);
    const profile = must(parseWorkspaceProfileConfig({ id: "cfw", label: "CFW", githubHost: "github.com", ghAccount: "fixture", ownerFilters: [], workspaceRoots: [], rulePaths: [], repos: [] }));
    const profiles = new ProfileStore(paths);
    expect(await profiles.save(profile)).toEqual({ _tag: "ok", value: undefined });
    const sessions = new ReviewSessionStore(paths);
    const reviews = new ReviewStore(paths);
    const remote = new ReviewRemoteStore(paths, reviews);
    const olderKey = { profileId, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)), headSha };
    const newerHeadSha = must(parseGitSha("3333333333333333333333333333333333333333"));
    const newerKey = { ...olderKey, headSha: newerHeadSha };
    const older = createReviewSession({ key: olderKey, pr: { headSha, isDraft: false, isOpen: true }, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "older" as never))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "older" as never))), headSha }, createdAt: timestamp });
    const newer = createReviewSession({ key: newerKey, pr: { headSha: newerHeadSha, isDraft: false, isOpen: true }, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "newer" as never))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "newer" as never))), headSha: newerHeadSha }, createdAt: must(parseIsoTimestamp("2026-07-18T00:00:01.000Z")) });
    const itemId = "legacy-inline-1" as never;
    const submittedBatch = { sessionId: older.id, state: { _tag: "Submitted" as const, reviewId: "legacy-review-1", event: "COMMENT" as const }, summaryBody: "Legacy summary", suggestedEvent: "COMMENT" as const, items: [{ _tag: "InlineComment" as const, id: itemId, provenance: { _tag: "human" as const }, source: "manual" as const, anchor: { path: "src/legacy.ts" as never, startLine: 1, line: 1, side: "new" as const }, body: "Legacy feedback", include: true, postability: "postable" as const }], receipts: [{ _tag: "PendingReviewCreated" as const, reviewId: "legacy-review-1", itemIds: [itemId] }], createdAt: timestamp, updatedAt: timestamp };
    const submittedOlder: ReviewSession = { ...older, batch: { state: submittedBatch.state }, batchContent: submittedBatch, submittedReview: { reviewId: "legacy-review-1", event: "COMMENT", submittedAt: timestamp } };
    expect(await sessions.save(submittedOlder)).toEqual({ _tag: "ok", value: undefined });
    expect(await sessions.save(newer)).toEqual({ _tag: "ok", value: undefined });

    const migration = new UnifiedReviewMigration(sessions, reviews);
    expect((await migration.migrateProfile(profileId))._tag).toBe("ok");
    const reviewGate = new ReviewWriteGate(profiles, reviews, sessions, remote);
    const recovery = new ReviewRecoveryService(profiles, sessions, () => timestamp, { reviewGate });

    // Startup recovery must inspect every eligible session, not only the
    // session named by the migrated Review.currentSessionId.
    expect(await recovery.reconcile()).toEqual({ recovered: 1, failed: 0 });
    expect(await sessions.load(profileId, submittedOlder.id)).toMatchObject({ _tag: "ok", value: { batchContent: { state: { _tag: "Local" }, receipts: [] }, archivedReceipts: [{ _tag: "PendingReviewCreated", reviewId: "legacy-review-1" }] } });
    const newerLoaded = await sessions.load(profileId, newer.id);
    expect(newerLoaded).toMatchObject({ _tag: "ok", value: { id: newer.id } });
    if (newerLoaded._tag === "ok") expect(newerLoaded.value.batchContent).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

it("keeps an unknown publication locked when GitHub cannot prove the intent", async () => {
  const fixture = await recoveryFixture(
    { _tag: "ReviewCompleted", attemptId: must(parseReviewAttemptId("001")) },
    { _tag: "Completed", resultPath: must(parseAbsolutePath("/tmp/fixture-result.json")) },
  );
  try {
    const itemId = "reply-1" as never;
    const unknownBatch = {
      sessionId: fixture.session.id,
      state: { _tag: "PartialFailure" as const, operation: { _tag: "Reply" as const, itemId, startedAt: timestamp, priorCommentIds: ["old-comment"] }, failure: { _tag: "SafeWriteFailure" as const, category: "outcome_unknown" as const, message: "The write outcome could not be confirmed." } },
      summaryBody: "",
      suggestedEvent: "COMMENT" as const,
      items: [{ _tag: "ThreadReply" as const, id: itemId, provenance: { _tag: "human" as const }, threadId: "thread-1" as never, body: "Reply once", include: true }],
      receipts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const seeded = await fixture.sessions.save({ ...fixture.session, batch: { state: unknownBatch.state }, batchContent: unknownBatch as never });
    expect(seeded._tag).toBe("ok");
    const recovery = new ReviewRecoveryService(fixture.profiles, fixture.sessions, () => timestamp, {
      github: {
        async getPullRequestComments() { return { _tag: "ok" as const, value: { threads: [], complete: true } }; },
      } as never,
    });
    const unresolved = await recovery.reconcilePublication(profileId, createReviewId(fixture.session.key));
    expect(unresolved).toEqual({ recovered: 0, failed: 1 });
    expect(await fixture.sessions.load(profileId, fixture.session.id)).toMatchObject({ _tag: "ok", value: { batchContent: { state: { _tag: "PartialFailure", failure: { category: "outcome_unknown" } } } } });

    const preExisting = new ReviewRecoveryService(fixture.profiles, fixture.sessions, () => timestamp, {
      github: {
        async getPullRequestComments() { return { _tag: "ok" as const, value: { threads: [{ id: "thread-1" as never, state: "open" as const, comments: [{ id: "old-comment", author: "fixture", body: "Reply once", createdAt: "2026-08-01T00:00:01.000Z" }] }], complete: true } }; },
        async resolveAuthenticatedAccount() { return { _tag: "ok" as const, value: { host: "github.com", account: "fixture" } }; },
      } as never,
    });
    expect(await preExisting.reconcilePublication(profileId, createReviewId(fixture.session.key))).toEqual({ recovered: 0, failed: 1 });

    const confirmed = new ReviewRecoveryService(fixture.profiles, fixture.sessions, () => timestamp, {
      github: {
        async getPullRequestComments() { return { _tag: "ok" as const, value: { threads: [{ id: "thread-1" as never, state: "open" as const, comments: [{ id: "comment-1", author: "fixture", body: "Reply once", createdAt: "2026-07-18T00:00:00.000Z" }] }], complete: true } }; },
        async resolveAuthenticatedAccount() { return { _tag: "ok" as const, value: { host: "github.com", account: "fixture" } }; },
      } as never,
    });
    expect(await confirmed.reconcilePublication(profileId, createReviewId(fixture.session.key))).toEqual({ recovered: 1, failed: 0 });
    expect(await fixture.sessions.load(profileId, fixture.session.id)).toMatchObject({ _tag: "ok", value: { batchContent: { state: { _tag: "Completed" }, receipts: [{ _tag: "ReplyCreated", commentId: "comment-1" }] } } });

    let writes = 0;
    const applied = await applyReviewBatch({
      profile: { githubHost: "github.com", ghAccount: "fixture" } as never,
      session: { ...fixture.session, batch: { state: unknownBatch.state }, batchContent: unknownBatch as never },
      batch: unknownBatch as never,
      now: timestamp,
      persist: async () => true,
      gateway: {
        async getPullRequest() { return { _tag: "ok" as const, value: { headSha } }; },
        async createPendingReview() { writes += 1; return { _tag: "ok" as const, value: { reviewId: "never", state: "PENDING" as const } }; },
        async submitPendingReview() { writes += 1; return { _tag: "ok" as const, value: { reviewId: "never" } }; },
        async createThreadReply() { writes += 1; return { _tag: "ok" as const, value: { commentId: "never" } }; },
      } as never,
    });
    expect(planBatchOperations(unknownBatch as never)).toEqual([]);
    expect(applied).toMatchObject({ _tag: "err", error: { _tag: "BatchOutcomeUnknown" } });
    expect(writes).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

it("rejects foreign identical feedback and accepts only an authenticated matching receipt", async () => {
  const fixture = await recoveryFixture(
    { _tag: "ReviewCompleted", attemptId: must(parseReviewAttemptId("001")) },
    { _tag: "Completed", resultPath: must(parseAbsolutePath("/tmp/fixture-result.json")) },
  );
  try {
    const itemId = "inline-1" as never;
    const batch = {
      sessionId: fixture.session.id,
      state: { _tag: "Applying" as const, operation: { _tag: "SubmitPendingReview" as const, reviewId: "review-1", event: "COMMENT" as const } },
      summaryBody: "Summary",
      suggestedEvent: "COMMENT" as const,
      items: [{ _tag: "InlineComment" as const, id: itemId, provenance: { _tag: "human" as const }, source: "manual" as const, anchor: { path: "a.ts" as never, startLine: 1, line: 1, side: "new" as const }, body: "Same feedback", include: true, postability: "postable" as const }],
      receipts: [{ _tag: "PendingReviewCreated" as const, reviewId: "review-1", itemIds: [itemId] }],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect((await fixture.sessions.save({ ...fixture.session, batch: { state: batch.state }, batchContent: batch as never }))._tag).toBe("ok");
    const feedback = (author: string) => ({ reviews: [{ id: "review-1", author, body: "Summary", event: "COMMENTED" as const, submittedAt: timestamp, canDismiss: false }], comments: [{ id: "comment-1", author, body: "Same feedback", createdAt: timestamp, reviewId: "review-1", location: { path: "a.ts" as never, line: 1, diffSide: "new" as const }, canEdit: false, canDelete: false }], complete: true });
    const reader = {
      async getPullRequestComments() { return { _tag: "ok" as const, value: { threads: [], complete: true } }; },
      async getPullRequestPublishedFeedback() { return { _tag: "ok" as const, value: feedback("another-actor") }; },
      async resolveAuthenticatedAccount() { return { _tag: "ok" as const, value: { host: "github.com", account: "fixture" } }; },
    };
    const recovery = new ReviewRecoveryService(fixture.profiles, fixture.sessions, () => timestamp, { github: reader });
    expect(await recovery.reconcilePublication(profileId, createReviewId(fixture.session.key))).toEqual({ recovered: 0, failed: 1 });
    expect(await fixture.sessions.load(profileId, fixture.session.id)).toMatchObject({ _tag: "ok", value: { batchContent: { state: { _tag: "Applying" } } } });
    const confirmed = new ReviewRecoveryService(fixture.profiles, fixture.sessions, () => timestamp, {
      github: { ...reader, async getPullRequestPublishedFeedback() { return { _tag: "ok" as const, value: feedback("fixture") }; } },
    });
    expect(await confirmed.reconcilePublication(profileId, createReviewId(fixture.session.key))).toEqual({ recovered: 1, failed: 0 });
    expect(await fixture.sessions.load(profileId, fixture.session.id)).toMatchObject({ _tag: "ok", value: { batchContent: { state: { _tag: "Local" }, receipts: [] }, archivedReceipts: [{ _tag: "PendingReviewCreated", reviewId: "review-1" }], submittedReview: { reviewId: "review-1", event: "COMMENT" } } });
  } finally {
    await fixture.cleanup();
  }
});

it("refuses publication recovery when the stable Review owner rejects the session", async () => {
  const fixture = await recoveryFixture(
    { _tag: "ReviewCompleted", attemptId: must(parseReviewAttemptId("001")) },
    { _tag: "Completed", resultPath: must(parseAbsolutePath("/tmp/fixture-result.json")) },
  );
  try {
    const itemId = "reply-owner-1" as never;
    const batch = {
      sessionId: fixture.session.id,
      state: { _tag: "Applying" as const, operation: { _tag: "Reply" as const, itemId, startedAt: timestamp, priorCommentIds: [] } },
      summaryBody: "",
      suggestedEvent: "COMMENT" as const,
      items: [{ _tag: "ThreadReply" as const, id: itemId, provenance: { _tag: "human" as const }, threadId: "thread-owner" as never, body: "Reply", include: true }],
      receipts: [], createdAt: timestamp, updatedAt: timestamp,
    };
    await fixture.sessions.save({ ...fixture.session, batch: { state: batch.state }, batchContent: batch as never });
    const recovery = new ReviewRecoveryService(fixture.profiles, fixture.sessions, () => timestamp, {
      reviewGate: { async requireCurrentSession() { return { _tag: "err" as const, error: { reason: "stale" as const } }; } },
      github: { async getPullRequestComments() { return { _tag: "ok" as const, value: { threads: [], complete: true } }; } } as never,
    });
    expect(await recovery.reconcilePublication(profileId, createReviewId(fixture.session.key))).toEqual({ recovered: 0, failed: 0 });
    expect(await fixture.sessions.load(profileId, fixture.session.id)).toMatchObject({ _tag: "ok", value: { batchContent: { state: { _tag: "Applying" } } } });
  } finally { await fixture.cleanup(); }
});

it("reconciles a merged outcome-unknown operation without a merge write", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-merge-recovery-"));
  try {
    const paths = PatchdeskPaths.forTest(root);
    const profile = must(parseWorkspaceProfileConfig({ id: "cfw", label: "CFW", githubHost: "github.com", ghAccount: "fixture", ownerFilters: [], workspaceRoots: [], rulePaths: [], repos: [] }));
    const profiles = new ProfileStore(paths); await profiles.save(profile);
    const sessions = new ReviewSessionStore(paths);
    const key = { profileId, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)), headSha };
    const session = createReviewSession({ key, pr: { headSha, isDraft: false, isOpen: true }, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "placeholder" as never))), headSha }, createdAt: timestamp });
    await sessions.save(session);
    const operations = new MergeOperationStore(paths);
    const requested = must(requestMergeOperation({ operationId: "merge-001", profileId, sessionId: session.id, pr: { host: key.host, owner: key.owner, repo: key.repo, number: key.prNumber }, expectedHeadSha: headSha, method: "squash", acknowledgedWarningCodes: [], startedAt: timestamp }));
    await operations.begin(must(markMergeOutcomeUnknown(requested)));
    const service = new ReviewRecoveryService(profiles, sessions, () => timestamp, { mergeOperations: operations, github: { async getMergeOutcome() { return ok({ state: "merged" as const, mergedAt: timestamp }); } } });
    await service.reconcile();
    await expect(sessions.load(profileId, session.id)).resolves.toMatchObject({ _tag: "ok", value: { state: { _tag: "Merged" } } });
    await expect(operations.load(profileId, session.id)).resolves.toMatchObject({ _tag: "err", error: { reason: "not_found" } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function recoveryFixture(
  state: ReviewSessionState,
  attemptState: ReviewAttemptState,
): Promise<{
  readonly profiles: ProfileStore;
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
    profiles,
    sessions,
    diagnostics,
    service,
    session,
    attempt,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
