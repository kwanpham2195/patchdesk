import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { RecentWriteJournalStore } from "../../src/adapters/storage/recent-write-journal-store";
import { writeAtomicJson } from "../../src/adapters/storage/json-file";
import { createReviewId } from "../../src/domain/ids";
import type { LogEntryInput } from "../../src/domain/log-entry";
import {
  parseGitHubHost,
  parseGitHubThreadId,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { RecentReviewWrite } from "../../src/domain/recent-review-write";
import type { Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};
const profileId = must(parseWorkspaceProfileId("acme"));
const identity = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("octo-org")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
};
const reviewId = createReviewId(identity);
// Within the store's 24h age-ceiling of "now" so pruning-on-load never
// discards these fixtures regardless of when the suite runs.
const writtenAt = must(parseIsoTimestamp(new Date().toISOString()));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempStore(): Promise<{
  readonly store: RecentWriteJournalStore;
  readonly paths: PatchdeskPaths;
  readonly logged: ReadonlyArray<LogEntryInput>;
}> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-recent-write-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const logged: Array<LogEntryInput> = [];
  const log = { write: (entry: LogEntryInput) => logged.push(entry) };
  return { store: new RecentWriteJournalStore(paths, log), paths, logged };
}

describe("RecentWriteJournalStore", () => {
  it("round-trips a journal holding every receipt tag", async () => {
    const { store } = await tempStore();
    const threadId = must(parseGitHubThreadId("PRRT_thread"));
    const receipts = {
      Comment: { _tag: "Comment", commentId: "PRRC_1", reviewId: "PRR_1" },
      ThreadState: { _tag: "ThreadState", threadId, state: "resolved" },
      PendingThread: { _tag: "PendingThread", threadId },
      DiscardedThread: {
        _tag: "DiscardedThread",
        threadId: must(parseGitHubThreadId("PRRT_discarded")),
      },
      DeletedComment: {
        _tag: "DeletedComment",
        commentId: "2145998877",
        nodeId: "PRRC_deleted",
      },
      DirectSummaryReview: { _tag: "DirectSummaryReview", reviewId: "PRR_1" },
      LabelChange: { _tag: "LabelChange", added: ["bug"], removed: ["wip"] },
      AssigneeChange: { _tag: "AssigneeChange", added: [], removed: ["hubot"] },
      ReviewerChange: {
        _tag: "ReviewerChange",
        requested: ["octocat"],
        removed: [],
      },
      DraftStateChange: { _tag: "DraftStateChange", draft: true },
      BaseBranchChange: { _tag: "BaseBranchChange", branch: "release/1.2" },
    } satisfies Record<RecentReviewWrite["_tag"], RecentReviewWrite>;
    for (const receipt of Object.values(receipts)) {
      const appended = await store.append(
        profileId,
        reviewId,
        receipt,
        writtenAt,
      );
      expect(appended._tag).toBe("ok");
    }
    await expect(store.load(profileId, reviewId)).resolves.toEqual({
      _tag: "ok",
      value: Object.values(receipts),
    });
  });

  it("drops the pending receipt for a thread whose discard is appended", async () => {
    // Live residue behind #322: starting a review journals PendingThread X and
    // discarding it journals DiscardedThread X, but a PendingThread can only
    // ever be satisfied by finding the thread, which the discard just removed.
    const { store } = await tempStore();
    const threadId = must(parseGitHubThreadId("PRRT_thread"));
    const otherThreadId = must(parseGitHubThreadId("PRRT_other"));
    for (const receipt of [
      { _tag: "PendingThread", threadId },
      { _tag: "PendingThread", threadId: otherThreadId },
      { _tag: "DiscardedThread", threadId },
    ] satisfies ReadonlyArray<RecentReviewWrite>) {
      const appended = await store.append(
        profileId,
        reviewId,
        receipt,
        writtenAt,
      );
      expect(appended._tag).toBe("ok");
    }
    await expect(store.load(profileId, reviewId)).resolves.toEqual({
      _tag: "ok",
      value: [
        { _tag: "PendingThread", threadId: otherThreadId },
        { _tag: "DiscardedThread", threadId },
      ],
    });
  });

  it("still loads an old journal file written before LabelChange existed", async () => {
    // Simulates a journal on disk from before this change: only the four
    // pre-existing variants, no LabelChange anywhere. Widening the schema by
    // adding a new variant case must not invalidate files that predate it.
    const { store, paths } = await tempStore();
    const legacy = {
      schemaVersion: 1,
      entries: [
        { _tag: "Comment", commentId: "c-legacy", writtenAt },
        { _tag: "PendingThread", threadId: "t-legacy", writtenAt },
      ],
    };
    const written = await writeAtomicJson(
      paths.recentWriteJournalFile(profileId, reviewId),
      legacy,
    );
    expect(written._tag).toBe("ok");
    await expect(store.load(profileId, reviewId)).resolves.toEqual({
      _tag: "ok",
      value: [
        { _tag: "Comment", commentId: "c-legacy" },
        { _tag: "PendingThread", threadId: "t-legacy" },
      ],
    });
  });

  it.each([
    ["invalid JSON", "{not json"],
    [
      "an unrecognized entry tag",
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ _tag: "SomeFutureVariant", whatever: true, writtenAt }],
      }),
    ],
  ])(
    "moves a journal holding %s aside and restarts it empty",
    async (_name, poisoned) => {
      const { store, paths, logged } = await tempStore();
      const file = paths.recentWriteJournalFile(profileId, reviewId);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, poisoned);

      await expect(store.load(profileId, reviewId)).resolves.toEqual({
        _tag: "ok",
        value: [],
      });
      await expect(
        readFile(
          paths.recentWriteJournalQuarantineFile(profileId, reviewId),
          "utf8",
        ),
      ).resolves.toBe(poisoned);
      expect(logged).toMatchObject([
        { level: "warn", topic: "recent-write-journal", profileId },
      ]);

      const receipt = { _tag: "Comment", commentId: "PRRC_1" } as const;
      await expect(
        store.append(profileId, reviewId, receipt, writtenAt),
      ).resolves.toEqual({ _tag: "ok", value: undefined });
      await expect(store.load(profileId, reviewId)).resolves.toEqual({
        _tag: "ok",
        value: [receipt],
      });
    },
  );

  it("logs a failed append of a confirmed write and resolves", async () => {
    const { store, paths, logged } = await tempStore();
    await mkdir(paths.recentWriteJournalFile(profileId, reviewId), {
      recursive: true,
    });
    await store.appendConfirmed(
      profileId,
      reviewId,
      { _tag: "Comment", commentId: "PRRC_1" },
      writtenAt,
    );
    expect(logged).toEqual([
      {
        process: "main",
        level: "warn",
        topic: "recent-write-journal",
        message: "journal append failed; write already confirmed, continuing",
        profileId,
        meta: { reason: "io", reviewId },
      },
    ]);
  });
});
