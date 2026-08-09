import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parseLocalReviewItemId,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import {
  parseReviewBatch,
  type ReviewBatch,
  type ReviewBatchState,
} from "../../src/domain/review-batch";
import { createReviewSession, type ReviewSession } from "../../src/domain/review-session";
import { LegacyBatchDiscardMigration } from "../../src/services/legacy-batch-discard-migration";

function must<T>(
  value:
    | { readonly _tag: "ok"; readonly value: T }
    | { readonly _tag: "err" },
): T {
  if (value._tag === "err") throw new Error("Invalid fixture");
  return value.value;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const profileId = must(parseWorkspaceProfileId("cfw"));
const itemId = must(parseLocalReviewItemId("finding-a"));
const createdAt = "2026-07-16T00:00:00.000Z";

async function makePaths(): Promise<PatchdeskPaths> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-batch-discard-"));
  roots.push(root);
  return PatchdeskPaths.forTest(root);
}

/** Builds and saves a session whose batch carries the given state. */
async function durableFixture(
  paths: PatchdeskPaths,
  label: string,
  state: ReviewBatchState,
): Promise<{ readonly session: ReviewSession; readonly batch: ReviewBatch }> {
  const store = new ReviewSessionStore(paths);
  const host = must(parseGitHubHost("github.com"));
  const owner = must(parseGitHubOwner("centraldigital"));
  const repo = must(parseGitHubRepoName("patchdesk"));
  const prNumber = must(parsePullRequestNumber(42));
  const headSha = must(
    parseGitSha(createHash("sha256").update(label).digest("hex").slice(0, 40)),
  );
  const parsedCreatedAt = must(parseIsoTimestamp(createdAt));
  const base = createReviewSession({
    key: { profileId, host, owner, repo, prNumber, headSha },
    pr: { headSha, isDraft: false, isOpen: true },
    patchPath: must(parseAbsolutePath(join(paths.dataDirectory(), "patch.diff"))),
    worktree: {
      path: must(parseAbsolutePath(join(paths.dataDirectory(), "worktree"))),
      headSha,
    },
    createdAt: parsedCreatedAt,
  });
  const batch = batchFor(base.id, state);
  const session: ReviewSession = {
    ...base,
    batch: { state: batch.state },
    batchContent: batch,
    ...(batch.state._tag === "Submitted"
      ? {
          submittedReview: {
            reviewId: batch.state.reviewId,
            event: batch.state.event,
            submittedAt: parsedCreatedAt,
          },
        }
      : {}),
  };
  const saved = await store.save(session);
  if (saved._tag === "err") throw new Error("fixture save failed");
  return { session, batch };
}

function batchFor(
  sessionId: ReviewSession["id"],
  state: ReviewBatchState,
): ReviewBatch {
  const items =
    state._tag === "Completed"
      ? [
          {
            _tag: "ThreadReply" as const,
            id: itemId,
            provenance: { _tag: "human" as const },
            threadId: "thread-1",
            body: "Reply body",
            include: true,
          },
        ]
      : [
          {
            _tag: "InlineComment" as const,
            id: itemId,
            provenance: { _tag: "human" as const },
            source: "manual" as const,
            anchor: {
              path: "src/a.ts",
              startLine: 8,
              line: 8,
              side: "new" as const,
            },
            body: "Original A",
            include: true,
            postability: "postable" as const,
          },
        ];
  const receipts =
    state._tag === "PendingReview" || state._tag === "Submitted"
      ? [
          {
            _tag: "PendingReviewCreated" as const,
            reviewId: "review-1",
            itemIds: [itemId],
          },
        ]
      : state._tag === "Completed"
        ? [
            {
              _tag: "ReplyCreated" as const,
              itemId,
              commentId: "comment-1",
            },
          ]
        : [];
  const stateValue =
    state._tag === "Applying"
      ? {
          _tag: "Applying" as const,
          operation: { _tag: "CreatePendingReview" as const, itemIds: [itemId] },
        }
      : state._tag === "PartialFailure"
        ? {
            _tag: "PartialFailure" as const,
            operation: {
              _tag: "CreatePendingReview" as const,
              itemIds: [itemId],
            },
            failure: {
              _tag: "SafeWriteFailure" as const,
              category: state.failure.category,
              message: state.failure.message,
            },
          }
        : state._tag === "PendingReview" || state._tag === "Submitted"
          ? { ...state }
          : { _tag: state._tag };
  return must(
    parseReviewBatch({
      sessionId,
      state: stateValue,
      summaryBody: state._tag === "Completed" ? "" : "Original summary",
      suggestedEvent: "COMMENT",
      items,
      receipts,
      createdAt,
      updatedAt: createdAt,
    }),
  );
}

function coveredStates(): Array<{ readonly label: string; readonly state: ReviewBatchState }> {
  const partialCategories = ["auth", "rejected", "unavailable", "outcome_unknown"] as const;
  return [
    { label: "local", state: { _tag: "Local" } },
    { label: "pending", state: { _tag: "PendingReview", reviewId: "review-1" } },
    { label: "applying", state: { _tag: "Applying", operation: { _tag: "CreatePendingReview", itemIds: [itemId] } } },
    ...partialCategories.map((category) => ({
      label: `partial-${category}`,
      state: {
        _tag: "PartialFailure" as const,
        operation: { _tag: "CreatePendingReview" as const, itemIds: [itemId] },
        failure: { _tag: "SafeWriteFailure" as const, category, message: "blocked" },
      },
    })),
  ];
}

describe("LegacyBatchDiscardMigration", () => {
  it("discards every covered legacy batch state from stored sessions", async () => {
    const paths = await makePaths();
    const store = new ReviewSessionStore(paths);
    const fixtures: Array<{ readonly label: string; readonly session: ReviewSession }> = [];
    for (const { label, state } of coveredStates()) {
      const fixture = await durableFixture(paths, `covered-${label}`, state);
      fixtures.push({ label, session: fixture.session });
    }
    const migration = new LegacyBatchDiscardMigration(store, {
      paths,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    const result = await migration.migrateProfile(profileId);
    expect(result).toMatchObject({
      _tag: "ok",
      value: { discarded: fixtures.length, skipped: 0 },
    });
    for (const { label, session } of fixtures) {
      const loaded = await store.load(profileId, session.id);
      expect(loaded._tag, label).toBe("ok");
      if (loaded._tag !== "ok") continue;
      expect(loaded.value.batch, label).toBeUndefined();
      expect(loaded.value.batchContent, label).toBeUndefined();
      expect(loaded.value.id, label).toBe(session.id);
      expect(loaded.value.state, label).toMatchObject({ _tag: "Created" });
    }
    // The marker is durable proof the treatment ran once.
    const marker = JSON.parse(
      await readFile(paths.batchDiscardMarkerFile(profileId), "utf8"),
    ) as Record<string, unknown>;
    expect(marker).toMatchObject({ schemaVersion: 1, profileId });
  });

  it("leaves Submitted, Completed, and batch-less sessions untouched", async () => {
    const paths = await makePaths();
    const store = new ReviewSessionStore(paths);
    const submitted = await durableFixture(paths, "submitted", { _tag: "Submitted", reviewId: "review-1", event: "COMMENT" });
    const completed = await durableFixture(paths, "completed", { _tag: "Completed" });
    const batchless = await durableFixture(paths, "batchless", { _tag: "Local" });
    const { batch: _b, batchContent: _c, ...withoutBatch } = batchless.session;
    void _b;
    void _c;
    await store.save(withoutBatch);

    const migration = new LegacyBatchDiscardMigration(store, {
      paths,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    const result = await migration.migrateProfile(profileId);
    expect(result).toMatchObject({ _tag: "ok", value: { discarded: 0, skipped: 3 } });

    for (const fixture of [submitted, completed]) {
      const loaded = await store.load(profileId, fixture.session.id);
      expect(loaded._tag).toBe("ok");
      if (loaded._tag !== "ok") continue;
      expect(loaded.value.batchContent, fixture.session.id).toBeDefined();
      expect(
        loaded.value.batchContent?.state._tag,
        fixture.session.id,
      ).toBe(fixture.batch.state._tag);
    }
    const loadedBatchless = await store.load(profileId, withoutBatch.id);
    expect(loadedBatchless._tag).toBe("ok");
    if (loadedBatchless._tag === "ok") {
      expect(loadedBatchless.value.batchContent).toBeUndefined();
    }
  });

  it("removes only local evidence, writes no remote-absence claim, and touches only scan+save", async () => {
    const paths = await makePaths();
    const store = new ReviewSessionStore(paths);
    const fixture = await durableFixture(paths, "pending", {
      _tag: "PendingReview",
      reviewId: "review-1",
    });
    // Any store access beyond scan + save would fail the migration loudly.
    // Methods are bound to the target so the store's internal `this` access
    // bypasses the guard while the migration's own calls stay visible.
    const guarded = new Proxy(store, {
      get(target, property) {
        if (
          property !== "scanSessionEntries" &&
          property !== "save"
        ) {
          throw new Error(`unexpected store access: ${String(property)}`);
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const migration = new LegacyBatchDiscardMigration(guarded, {
      paths,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    const result = await migration.migrateProfile(profileId);
    expect(result._tag).toBe("ok");
    const raw = JSON.parse(
      await readFile(paths.sessionFile(profileId, fixture.session.id), "utf8"),
    ) as Record<string, unknown>;
    // Only local evidence is removed: no batch fields remain and no field
    // claims anything about remote GitHub state (absence or otherwise).
    expect(Object.hasOwn(raw, "batch")).toBe(false);
    expect(Object.hasOwn(raw, "batchContent")).toBe(false);
    expect(
      Object.keys(raw).some((key) => /pending|remote/i.test(key)),
    ).toBe(false);
  });

  it("is idempotent after its marker: a second run discards nothing", async () => {
    const paths = await makePaths();
    const store = new ReviewSessionStore(paths);
    await durableFixture(paths, "local", { _tag: "Local" });
    const migration = new LegacyBatchDiscardMigration(store, {
      paths,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    const first = await migration.migrateProfile(profileId);
    expect(first).toMatchObject({ _tag: "ok", value: { discarded: 1 } });
    const second = await migration.migrateProfile(profileId);
    expect(second).toMatchObject({ _tag: "ok", value: { discarded: 0 } });
    const scanned = await store.scanSessionEntries(profileId);
    expect(scanned._tag).toBe("ok");
    if (scanned._tag === "ok") {
      expect(scanned.value.sessions).toHaveLength(1);
      expect(scanned.value.sessions[0]?.batchContent).toBeUndefined();
    }
  });

  it("interruption between saves leaves remaining sessions for the next run without double-discarding", async () => {
    const paths = await makePaths();
    const store = new ReviewSessionStore(paths);
    const first = await durableFixture(paths, "local-a", { _tag: "Local" });
    const second = await durableFixture(paths, "local-b", { _tag: "Local" });
    let interrupted = true;
    const interruptedRun = new LegacyBatchDiscardMigration(store, {
      paths,
      now: () => "2026-08-09T00:00:00.000Z",
      afterDiscard: async () => {
        if (interrupted) {
          interrupted = false;
          throw new Error("interrupted");
        }
      },
    });
    await expect(interruptedRun.migrateProfile(profileId)).rejects.toThrow(
      "interrupted",
    );
    await expect(
      readFile(paths.batchDiscardMarkerFile(profileId), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const resumed = new LegacyBatchDiscardMigration(store, {
      paths,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    const result = await resumed.migrateProfile(profileId);
    expect(result).toMatchObject({ _tag: "ok", value: { discarded: 1 } });
    for (const fixture of [first, second]) {
      const loaded = await store.load(profileId, fixture.session.id);
      expect(loaded._tag).toBe("ok");
      if (loaded._tag === "ok") {
        expect(loaded.value.batchContent).toBeUndefined();
      }
    }
  });

  it("skips unreadable entries and still completes with the marker", async () => {
    const paths = await makePaths();
    const store = new ReviewSessionStore(paths);
    await durableFixture(paths, "local", { _tag: "Local" });
    await writeFile(
      join(paths.profileReviewsDirectory(profileId), "not-a-session-id"),
      "{}",
      "utf8",
    );
    const migration = new LegacyBatchDiscardMigration(store, {
      paths,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    const result = await migration.migrateProfile(profileId);
    expect(result).toMatchObject({ _tag: "ok", value: { discarded: 1, skipped: 1 } });
    await expect(
      readFile(paths.batchDiscardMarkerFile(profileId), "utf8"),
    ).resolves.toBeDefined();
  });

  it("fails closed on a corrupt marker instead of discarding again", async () => {
    const paths = await makePaths();
    const store = new ReviewSessionStore(paths);
    await durableFixture(paths, "local", { _tag: "Local" });
    await writeFile(paths.batchDiscardMarkerFile(profileId), "{not-json", "utf8");
    const migration = new LegacyBatchDiscardMigration(store, { paths });
    const result = await migration.migrateProfile(profileId);
    expect(result._tag).toBe("err");
    const scanned = await store.scanSessionEntries(profileId);
    expect(scanned._tag).toBe("ok");
    if (scanned._tag === "ok") {
      expect(scanned.value.sessions).toHaveLength(1);
      expect(scanned.value.sessions[0]?.batchContent).toBeDefined();
    }
  });

  it("discards legacy v2 local drafts after their read-time migration", async () => {
    const paths = await makePaths();
    const store = new ReviewSessionStore(paths);
    const fixture = await durableFixture(paths, "legacy-v2", { _tag: "Local" });
    const sessionPath = paths.sessionFile(profileId, fixture.session.id);
    const raw = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>;
    delete raw.batch;
    delete raw.batchContent;
    const legacy = {
      ...raw,
      schemaVersion: 2,
      draft: { state: { _tag: "LocalDraft" } },
      draftContent: {
        sessionId: fixture.session.id,
        attemptId: "001",
        state: { _tag: "LocalDraft" },
        summaryBody: "Legacy summary",
        suggestedEvent: "COMMENT",
        comments: [],
        createdAt,
        updatedAt: createdAt,
      },
    };
    await writeFile(sessionPath, JSON.stringify(legacy), "utf8");

    const migration = new LegacyBatchDiscardMigration(store, {
      paths,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    const result = await migration.migrateProfile(profileId);
    expect(result).toMatchObject({ _tag: "ok", value: { discarded: 1, skipped: 0 } });
    const loaded = await store.load(profileId, fixture.session.id);
    expect(loaded._tag).toBe("ok");
    if (loaded._tag === "ok") {
      expect(loaded.value.batch).toBeUndefined();
      expect(loaded.value.batchContent).toBeUndefined();
    }
  });
});
