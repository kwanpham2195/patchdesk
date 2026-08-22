import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReviewArtifactStorage } from "../../src/adapters/storage/review-artifact-storage";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { writeAtomicJson } from "../../src/adapters/storage/json-file";

const roots: string[] = [];
// SAFETY: This literal is a well-formed WorkspaceProfileId fixture.
const profileId = "cfw" as never;
const reviewId =
  // SAFETY: This literal is a well-formed ReviewId fixture.
  "github.com__centraldigital__patchdesk__pr-42__review-6bc2fb3696aa" as never;
const sessionId =
  // SAFETY: This literal is a well-formed head/base-aware ReviewSessionId fixture.
  "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca" as never;
// SAFETY: This fixed ISO timestamp is a valid test value for the branded timestamp field.
const at = "2026-08-14T00:00:00.000Z" as never;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ReviewArtifactStorage", () => {
  it("quarantines an unusable Review before a clean restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-review-artifacts-"));
    roots.push(root);
    const paths = PatchdeskPaths.forTest(root);
    const reviewFile = paths.reviewFile(profileId, reviewId);
    await writeAtomicJson(reviewFile, { marker: "old-review" });
    const remoteFile = join(
      paths.reviewDirectory(profileId, reviewId),
      "remote",
      "snapshot.json",
    );
    await writeAtomicJson(remoteFile, { marker: "old-snapshot" });
    const storage = new ReviewArtifactStorage(paths, () => at);

    const result = await storage.quarantineReview(profileId, reviewId);

    expect(result).toMatchObject({ _tag: "ok" });
    if (result._tag === "err") return;
    expect(result.value.entryName).toMatch(
      new RegExp(`^${reviewId}\\.20260814T000000\\.[0-9a-f-]{36}$`),
    );
    await expect(access(reviewFile)).rejects.toMatchObject({ code: "ENOENT" });
    const quarantined = paths.quarantinedReviewDirectory(
      profileId,
      result.value.entryName,
    );
    await expect(
      readFile(join(quarantined, "review.json"), "utf8"),
    ).resolves.toContain("old-review");
    await expect(
      readFile(join(quarantined, "remote", "snapshot.json"), "utf8"),
    ).resolves.toContain("old-snapshot");

    await writeAtomicJson(reviewFile, { marker: "second-review" });
    const second = await storage.quarantineReview(profileId, reviewId);
    expect(second).toMatchObject({ _tag: "ok" });
    if (second._tag === "err") return;
    expect(second.value.entryName).not.toBe(result.value.entryName);
    await expect(
      readFile(
        join(
          paths.quarantinedReviewDirectory(profileId, second.value.entryName),
          "review.json",
        ),
        "utf8",
      ),
    ).resolves.toContain("second-review");
  });

  it("quarantines surviving directories when session.json is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-review-artifacts-"));
    roots.push(root);
    const paths = PatchdeskPaths.forTest(root);
    const sessionMarker = join(
      paths.sessionDirectory(profileId, sessionId),
      "orphaned-artifact.json",
    );
    const worktreeMarker = join(
      paths.worktreeDirectory(profileId, sessionId),
      "orphaned-worktree.json",
    );
    await writeAtomicJson(sessionMarker, { marker: "session" });
    await writeAtomicJson(worktreeMarker, { marker: "worktree" });
    const storage = new ReviewArtifactStorage(paths, () => at);

    const result = await storage.quarantineIfPresent(profileId, sessionId);

    expect(result).toMatchObject({ _tag: "ok" });
    if (result._tag === "err") return;
    await expect(access(sessionMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(worktreeMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(
        join(
          paths.quarantinedSessionDirectory(profileId, result.value.entryName),
          "orphaned-artifact.json",
        ),
        "utf8",
      ),
    ).resolves.toContain("session");
    await expect(
      readFile(
        join(
          paths.quarantinedWorktreeDirectory(profileId, result.value.entryName),
          "orphaned-worktree.json",
        ),
        "utf8",
      ),
    ).resolves.toContain("worktree");
  });
});
