import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
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
  type ReviewAttemptId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../../src/domain/ids";
import { parseReviewBatch } from "../../src/domain/review-batch";
import {
  createReviewSession,
} from "../../src/domain/review-session";
import type { ReviewAttempt } from "../../src/domain/review-attempt";

const roots: string[] = [];
const startedAt = must(parseIsoTimestamp("2026-07-24T00:00:00.000Z"));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ReviewSessionStore.beginAttempt", () => {
  it("requires the persisted local batch to be discarded before a rerun", async () => {
    const fixture = await createFixture();
    const attemptId = must(parseReviewAttemptId("001"));
    const batchContent = must(parseReviewBatch({
      sessionId: fixture.session.id,
      attemptId,
      state: { _tag: "Local" },
      summaryBody: "Saved local work.",
      suggestedEvent: "COMMENT",
      items: [],
      receipts: [],
      createdAt: startedAt,
      updatedAt: startedAt,
    }));
    const sessionWithBatch = {
      ...fixture.session,
      currentAttemptId: attemptId,
      state: { _tag: "ReviewCompleted" as const, attemptId },
      batch: { state: { _tag: "Local" as const } },
      batchContent,
    };
    expect(await fixture.store.save(sessionWithBatch)).toEqual({
      _tag: "ok",
      value: undefined,
    });

    const blocked = await fixture.store.beginAttempt({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      updatedAt: startedAt,
      createAttempt: async (session, id) =>
        okAttempt(fixture.paths, fixture.profileId, session.id, id),
    });
    expect(blocked).toMatchObject({ _tag: "ok", value: { id: "001" } });
  });

  it("allocates retry artifacts from the real attempt ID", async () => {
    const fixture = await createFixture();
    const first = await fixture.store.beginAttempt({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      updatedAt: startedAt,
      createAttempt: async (session, id) => okAttempt(fixture.paths, fixture.profileId, session.id, id),
    });
    expect(first).toMatchObject({ _tag: "ok", value: { id: "001", state: { _tag: "Starting" } } });

    const completed = {
      ...fixture.session,
      currentAttemptId: first._tag === "ok" ? first.value.id : undefined,
      state: { _tag: "ReviewCompleted" as const, attemptId: first._tag === "ok" ? first.value.id : "001" as ReviewAttemptId },
      updatedAt: startedAt,
    };
    await fixture.store.save(completed);

    const retry = await fixture.store.beginAttempt({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      updatedAt: startedAt,
      createAttempt: async (session, id) => okAttempt(fixture.paths, fixture.profileId, session.id, id),
    });

    expect(retry).toMatchObject({ _tag: "ok", value: { id: "002" } });
    if (retry._tag === "ok") {
      expect(retry.value.contextPath).toContain("/attempts/002/context.json");
      expect(retry.value.reviewInputPath).toContain("/attempts/002/review-input.md");
    }
  });

  it("clears a submitted batch before persisting the next attempt", async () => {
    const fixture = await createFixture();
    const attemptId = must(parseReviewAttemptId("001"));
    const previousAttempt = await okAttempt(
      fixture.paths,
      fixture.profileId,
      fixture.session.id,
      attemptId,
    );
    await fixture.store.saveAttempt(
      fixture.profileId,
      fixture.session.id,
      previousAttempt.value,
    );
    const batchContent = must(parseReviewBatch({
      sessionId: fixture.session.id,
      attemptId,
      state: {
        _tag: "Submitted",
        reviewId: "review-1",
        event: "COMMENT",
      },
      summaryBody: "Submitted review.",
      suggestedEvent: "COMMENT",
      items: [{
        _tag: "InlineComment",
        id: "finding-1",
        source: "finding",
        findingId: "finding-1",
        anchor: {
          path: "src/example.ts",
          startLine: 7,
          line: 7,
          side: "new",
        },
        body: "Keep this branch explicit.",
        include: true,
        postability: "postable",
      }],
      receipts: [{
        _tag: "PendingReviewCreated",
        reviewId: "review-1",
        itemIds: ["finding-1"],
      }],
      createdAt: startedAt,
      updatedAt: startedAt,
    }));
    const sessionWithSubmittedBatch = {
      ...fixture.session,
      currentAttemptId: attemptId,
      state: { _tag: "ReviewCompleted" as const, attemptId },
      batch: { state: batchContent.state },
      batchContent,
      submittedReview: {
        reviewId: "review-1",
        event: "COMMENT" as const,
        submittedAt: startedAt,
      },
    };
    expect(await fixture.store.save(sessionWithSubmittedBatch)).toEqual({
      _tag: "ok",
      value: undefined,
    });

    await expect(fixture.store.beginAttempt({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      updatedAt: startedAt,
      createAttempt: async (session, id) =>
        okAttempt(fixture.paths, fixture.profileId, session.id, id),
    })).resolves.toMatchObject({ _tag: "err", error: { _tag: "BeginAttemptRejected", reason: "not_runnable" } });

    await expect(
      fixture.store.load(fixture.profileId, fixture.session.id),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        currentAttemptId: "001",
        state: { _tag: "ReviewCompleted", attemptId: "001" },
        submittedReview: { reviewId: "review-1" },
      },
    });
    const stored = await fixture.store.load(
      fixture.profileId,
      fixture.session.id,
    );
    if (stored._tag === "ok") {
      expect(stored.value.batch).toMatchObject({ state: { _tag: "Submitted" } });
      expect(stored.value.batchContent).toMatchObject({ state: { _tag: "Submitted" } });
    }
  });

  it("scans corrupt entries without hiding healthy sessions", async () => {
    const fixture = await createFixture();
    const corruptId = `${fixture.session.id.slice(0, -1)}0` as ReviewSessionId;
    await mkdir(fixture.paths.sessionDirectory(fixture.profileId, corruptId), { recursive: true });
    await writeFile(fixture.paths.sessionFile(fixture.profileId, corruptId), "{\"broken\":true}", "utf8");
    const scanned = await fixture.store.scanSessionEntries(fixture.profileId);
    expect(scanned).toMatchObject({ _tag: "ok", value: { sessions: [{ id: fixture.session.id }] } });
    expect(scanned).toMatchObject({ value: { invalidEntries: [{ entryName: corruptId, sessionId: corruptId }] } });
  });

  it("round-trips an interrupted attempt and allows a fresh begin", async () => {
    const fixture = await createFixture();
    const first = await fixture.store.beginAttempt({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      updatedAt: startedAt,
      createAttempt: async (session, id) => okAttempt(fixture.paths, fixture.profileId, session.id, id),
    });
    expect(first._tag).toBe("ok");
    if (first._tag === "err") return;
    await fixture.store.saveAttempt(fixture.profileId, fixture.session.id, {
      ...first.value,
      state: { _tag: "Interrupted", interruptedAt: startedAt },
    });
    await fixture.store.save({ ...fixture.session, currentAttemptId: first.value.id, state: { _tag: "Running", attemptId: first.value.id } });
    await expect(fixture.store.loadAttempt(fixture.profileId, fixture.session.id, first.value.id)).resolves.toMatchObject({ value: { state: { _tag: "Interrupted" } } });
    await expect(fixture.store.beginAttempt({
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      updatedAt: startedAt,
      createAttempt: async (session, id) => okAttempt(fixture.paths, fixture.profileId, session.id, id),
    })).resolves.toMatchObject({ _tag: "ok", value: { id: "002" } });
  });

  it("serializes duplicate starts and refuses stale sessions", async () => {
    const fixture = await createFixture();
    const input = {
      profileId: fixture.profileId,
      sessionId: fixture.session.id,
      updatedAt: startedAt,
      createAttempt: async (session: typeof fixture.session, id: ReviewAttemptId) =>
        okAttempt(fixture.paths, fixture.profileId, session.id, id),
    };
    const [first, second] = await Promise.all([
      fixture.store.beginAttempt(input),
      fixture.store.beginAttempt(input),
    ]);
    expect([first, second].filter((result) => result._tag === "ok")).toHaveLength(1);
    expect([first, second].find((result) => result._tag === "err")).toMatchObject({
      error: { _tag: "BeginAttemptRejected", reason: "not_runnable" },
    });

    const staleFixture = await createFixture();
    await staleFixture.store.save({
      ...staleFixture.session,
      state: { _tag: "Stale", reason: "head_changed" },
    });
    await expect(staleFixture.store.beginAttempt({
      ...input,
      profileId: staleFixture.profileId,
      sessionId: staleFixture.session.id,
      createAttempt: async (session, id) => okAttempt(staleFixture.paths, staleFixture.profileId, session.id, id),
    })).resolves.toMatchObject({
      _tag: "err",
      error: { _tag: "BeginAttemptRejected", reason: "not_runnable" },
    });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-begin-attempt-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const profileId = must(parseWorkspaceProfileId("cfw"));
  const key = {
    profileId,
    host: must(parseGitHubHost("github.com")),
    owner: must(parseGitHubOwner("centraldigital")),
    repo: must(parseGitHubRepoName("patchdesk")),
    prNumber: must(parsePullRequestNumber(42)),
    headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
  };
  const seed = createReviewSession({
    key,
    pr: { headSha: key.headSha, isDraft: false, isOpen: true },
    patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never))),
    worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "placeholder" as never))), headSha: key.headSha },
    createdAt: startedAt,
  });
  const session = {
    ...seed,
    patchPath: must(parseAbsolutePath(paths.patchFile(profileId, seed.id))),
    worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, seed.id))), headSha: key.headSha },
  };
  const store = new ReviewSessionStore(paths);
  await store.save(session);
  return { paths, profileId, session, store };
}

function okAttempt(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  sessionId: ReviewSessionId,
  id: ReviewAttemptId,
) {
  const contentHash = must(parseContentHash("a".repeat(64)));
  const attempt: ReviewAttempt = {
    id,
    sessionId,
    state: { _tag: "Starting" },
    model: "fixture-model",
    reasoning: "medium",
    reviewSkillVersion: contentHash,
    contextHash: contentHash,
    contextPath: must(parseAbsolutePath(paths.attemptContextFile(profileId, sessionId, id))),
    reviewInputPath: must(parseAbsolutePath(paths.attemptReviewInputFile(profileId, sessionId, id))),
    debugPath: must(parseAbsolutePath(paths.attemptDebugFile(profileId, sessionId, id))),
    startedAt,
  };
  return Promise.resolve({ _tag: "ok" as const, value: attempt });
}

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}
