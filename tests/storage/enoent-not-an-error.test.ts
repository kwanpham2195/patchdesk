import type { PathLike } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { readAvatar } from "../../src/adapters/storage/avatar-cache-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { RecentWriteJournalStore } from "../../src/adapters/storage/recent-write-journal-store";
import {
  createReviewId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

/**
 * `isNotFound` in `json-file.ts` reads `code` off any object rather than
 * requiring `instanceof Error`, so a `node:fs` rejection that crossed a realm
 * boundary — an Electron utility process, a worker thread, a `vm` context,
 * where `instanceof Error` is false against the local realm's constructor —
 * still counts as "this path is not there" instead of a real I/O failure.
 *
 * Real in-process `node:fs` can only reject with a local-realm `Error`, which
 * both the wide and the narrow predicate accept, so no test built on real
 * files can tell the two apart. These tests reject with a plain object
 * instead, and fail if the predicate is ever narrowed back to
 * `instanceof Error`.
 */

// Roots chosen so the rejected code is readable off the path itself: every
// path the stores build below one of them carries its marker segment.
const missingRoot = "/patchdesk-realm-fixture/enoent";
const unreadableRoot = "/patchdesk-realm-fixture/eacces";

// oxlint-disable-next-line anti-slop/no-module-mocking -- `node:fs/promises` is a Node builtin with no DI seam these two stores own, and a real in-process rejection is always a local-realm `Error`; rejecting with a plain object is the only way to observe the widened `isNotFound` at the call sites that classify it.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  // Rejects the way a realm-crossed `node:fs` failure arrives: the same `code`
  // property, but a plain object rather than an `Error`.
  const rejectAcrossRealms = async (
    path: PathLike | FsPromises.FileHandle,
  ): Promise<never> => {
    throw String(path).includes("/eacces/")
      ? { code: "EACCES" }
      : { code: "ENOENT" };
  };
  return { ...actual, readFile: rejectAcrossRealms, rm: rejectAcrossRealms };
});

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};
const profileId = must(parseWorkspaceProfileId("cfw"));
const reviewId = createReviewId({
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  prNumber: must(parsePullRequestNumber(42)),
});
const avatarHash = "0".repeat(64);

describe("an ENOENT rejection that is not an Error", () => {
  it("reads as not_found from the avatar cache", async () => {
    const read = await readAvatar(
      PatchdeskPaths.forTest(missingRoot),
      profileId,
      avatarHash,
    );

    expect(read).toMatchObject({
      _tag: "err",
      error: { operation: "read", reason: "not_found" },
    });
  });

  it("still reads as io from the avatar cache under another code", async () => {
    const read = await readAvatar(
      PatchdeskPaths.forTest(unreadableRoot),
      profileId,
      avatarHash,
    );

    expect(read).toMatchObject({
      _tag: "err",
      error: { operation: "read", reason: "io" },
    });
  });

  it("leaves the recent-write journal clear reporting success", async () => {
    const store = new RecentWriteJournalStore(
      PatchdeskPaths.forTest(missingRoot),
    );

    expect(await store.clear(profileId, reviewId)).toMatchObject({
      _tag: "ok",
    });
  });

  it("still fails the recent-write journal clear under another code", async () => {
    const store = new RecentWriteJournalStore(
      PatchdeskPaths.forTest(unreadableRoot),
    );

    expect(await store.clear(profileId, reviewId)).toMatchObject({
      _tag: "err",
      error: { operation: "write", reason: "io" },
    });
  });
});
