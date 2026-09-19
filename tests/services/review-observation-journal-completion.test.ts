import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  ReviewRemoteStore,
  type ReviewRemoteSnapshot,
} from "../../src/adapters/storage/review-remote-store";
import {
  createReviewId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
  type ContentHash,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";
import { completeObservationJournal } from "../../src/services/review-observation-recovery";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "err") throw new Error("fixture");
  return result.value;
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
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Three stored snapshots: one two adoptions old, one this adoption replaced, one represented. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-journal-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const remote = new ReviewRemoteStore(paths);
  const hashes: ContentHash[] = [];
  for (const title of ["oldest", "previous", "represented"]) {
    const saved = await remote.saveCandidate({
      profileId,
      reviewId,
      snapshot: snapshot(title),
    });
    if (saved._tag === "err") throw new Error("fixture");
    hashes.push(saved.value.snapshotHash);
  }
  const removals: number[] = [];
  const journals = {
    async remove(): Promise<Result<void, never>> {
      removals.push(1);
      return ok(undefined);
    },
  };
  return {
    remote,
    journals,
    removals,
    previous: hashes[1],
    represented: hashes[2],
    directory: join(paths.reviewDirectory(profileId, reviewId), "remote"),
  };
}

describe("completeObservationJournal", () => {
  it("removes the journal, then keeps the represented snapshot and the one it replaced", async () => {
    const value = await fixture();
    expect(await readdir(value.directory)).toHaveLength(3);
    const completed = await completeObservationJournal(
      // SAFETY: the completion path touches only these two seams.
      { journals: value.journals, remote: value.remote } as never,
      {
        profileId,
        reviewId,
        representedSnapshotHash: value.represented,
        previousSnapshotHash: value.previous,
      },
    );
    expect(completed).toMatchObject({ _tag: "ok" });
    expect(value.removals).toHaveLength(1);
    expect((await readdir(value.directory)).sort()).toEqual(
      [`${value.previous}.json`, `${value.represented}.json`].sort(),
    );
  });

  it("keeps only the represented snapshot when it replaced nothing", async () => {
    const value = await fixture();
    const completed = await completeObservationJournal(
      // SAFETY: as above, for the first adoption a Review ever completes.
      { journals: value.journals, remote: value.remote } as never,
      {
        profileId,
        reviewId,
        representedSnapshotHash: value.represented,
        previousSnapshotHash: undefined,
      },
    );
    expect(completed).toMatchObject({ _tag: "ok" });
    expect(await readdir(value.directory)).toEqual([
      `${value.represented}.json`,
    ]);
  });

  it("keeps every snapshot when the journal removal fails", async () => {
    const value = await fixture();
    const completed = await completeObservationJournal(
      // SAFETY: as above, with a journal this removal leaves in place.
      {
        journals: {
          remove: async () =>
            err({
              _tag: "StorageFailure",
              operation: "write",
              reason: "io",
            }),
        },
        remote: value.remote,
      } as never,
      {
        profileId,
        reviewId,
        representedSnapshotHash: value.represented,
        previousSnapshotHash: value.previous,
      },
    );
    expect(completed).toMatchObject({ _tag: "err" });
    // The journal still names the snapshot recovery will replay from.
    expect(await readdir(value.directory)).toHaveLength(3);
  });

  it("completes the adoption when the prune throws", async () => {
    const value = await fixture();
    const completed = await completeObservationJournal(
      // SAFETY: as above, with a prune standing in for a misbehaving store.
      {
        journals: value.journals,
        remote: {
          pruneExcept: () => Promise.reject(new Error("unreadable")),
        },
      } as never,
      {
        profileId,
        reviewId,
        representedSnapshotHash: value.represented,
        previousSnapshotHash: value.previous,
      },
    );
    expect(completed).toMatchObject({ _tag: "ok" });
    expect(await readdir(value.directory)).toHaveLength(3);
  });
});

function snapshot(title: string): ReviewRemoteSnapshot {
  return {
    schemaVersion: 1,
    pullRequest: {
      ref: {
        host: identity.host,
        owner: identity.owner,
        repo: identity.repo,
        number: identity.prNumber,
      },
      headSha: must(parseGitSha("1".repeat(40))),
      isDraft: false,
      isOpen: true,
      title,
      author: "fixture",
      headBranch: "feature",
      baseBranch: "main",
      reviewState: "none",
      mergeability: "mergeable",
      labels: [],
      updatedAt: must(parseIsoTimestamp("2026-08-12T00:00:00.000Z")),
    },
    comments: { threads: [], complete: true },
    commits: [],
    checks: { overall: "passing", checks: [] },
    conversation: { prDescription: "", entries: [] },
  };
}
