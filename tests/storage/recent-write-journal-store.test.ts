import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { RecentWriteJournalStore } from "../../src/adapters/storage/recent-write-journal-store";
import { writeAtomicJson } from "../../src/adapters/storage/json-file";
import { createReviewId } from "../../src/domain/ids";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};
const profileId = must(parseWorkspaceProfileId("cfw"));
const identity = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
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
}> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-recent-write-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  return { store: new RecentWriteJournalStore(paths), paths };
}

describe("RecentWriteJournalStore", () => {
  it("round-trips a LabelChange entry", async () => {
    const { store } = await tempStore();
    const appended = await store.append(
      profileId,
      reviewId,
      { _tag: "LabelChange", added: ["bug"], removed: ["needs-triage"] },
      writtenAt,
    );
    expect(appended._tag).toBe("ok");
    await expect(store.load(profileId, reviewId)).resolves.toEqual({
      _tag: "ok",
      value: [
        { _tag: "LabelChange", added: ["bug"], removed: ["needs-triage"] },
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

  it("fails the whole read closed on an unrecognized entry tag instead of throwing", async () => {
    // Per ADR 0022, a durable record Patchdesk fully owns on both read and
    // write uses v.strictObject and fails the whole read closed on
    // structural drift; a future/unknown entry must not corrupt or crash the
    // read, only return a typed storage failure.
    const { store, paths } = await tempStore();
    const fromTheFuture = {
      schemaVersion: 1,
      entries: [
        { _tag: "SomeFutureVariant", whatever: true, writtenAt },
        { _tag: "Comment", commentId: "c-still-here", writtenAt },
      ],
    };
    const written = await writeAtomicJson(
      paths.recentWriteJournalFile(profileId, reviewId),
      fromTheFuture,
    );
    expect(written._tag).toBe("ok");
    const loaded = await store.load(profileId, reviewId);
    expect(loaded).toEqual({
      _tag: "err",
      error: {
        _tag: "StorageFailure",
        operation: "read",
        reason: "invalid_stored_value",
      },
    });
  });
});
