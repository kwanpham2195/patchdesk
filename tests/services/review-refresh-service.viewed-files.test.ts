import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ViewedFilesStore } from "../../src/adapters/storage/viewed-files-store";
import {
  parseAbsolutePath,
  parseGitSha,
  parseRepoRelativePath,
  type AbsolutePath,
} from "../../src/domain/ids";
import type { LogEntryInput } from "../../src/domain/log-entry";
import type { Result } from "../../src/domain/result";
import {
  createReviewRefreshFixture,
  createReviewRefreshFixtureValues,
  createReviewRefreshSession,
} from "./review-refresh-fixture";

const { profileId, identity, at, snapshot, session, review } =
  createReviewRefreshFixtureValues();
const newHeadSha = must(parseGitSha("2".repeat(40)));
const newHead = { ...snapshot.pullRequest, headSha: newHeadSha };
const a = must(parseRepoRelativePath("a.ts"));
const b = must(parseRepoRelativePath("b.ts"));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ReviewRefreshService Viewed marks on a new head", () => {
  it("keeps the mark on a file whose patch is unchanged and drops it on a changed file", async () => {
    const harness = await setUp();
    await writeFile(
      harness.oldPatchPath,
      filePatch("a.ts", "A") + filePatch("b.ts", "B"),
    );
    await writeFile(
      harness.newPatchPath,
      filePatch("a.ts", "A") + filePatch("b.ts", "B2"),
    );
    await harness.viewedFiles.save(profileId, session.id, "combined", [a, b]);

    const refreshed = await harness.fixture.service.refresh({
      profileId,
      reviewId: review.id,
    });

    expect(refreshed._tag).toBe("ok");
    expect(harness.fixture.calls.savedReviews.at(-1)?.currentSessionId).toBe(
      harness.newSession.id,
    );
    expect(
      must(
        await harness.viewedFiles.load(
          profileId,
          harness.newSession.id,
          "combined",
        ),
      ),
    ).toEqual([a]);
    expect(
      must(await harness.viewedFiles.load(profileId, session.id, "combined")),
    ).toEqual([a, b]);
  });

  it("still moves the Review with no files viewed and logs when the marks cannot be carried", async () => {
    const harness = await setUp();
    // The superseded session's patch is missing, so no mark can be compared.
    await writeFile(harness.newPatchPath, filePatch("a.ts", "A"));
    await harness.viewedFiles.save(profileId, session.id, "combined", [a]);

    const refreshed = await harness.fixture.service.refresh({
      profileId,
      reviewId: review.id,
    });

    expect(refreshed._tag).toBe("ok");
    expect(harness.fixture.calls.savedReviews.at(-1)?.currentSessionId).toBe(
      harness.newSession.id,
    );
    expect(
      must(
        await harness.viewedFiles.load(
          profileId,
          harness.newSession.id,
          "combined",
        ),
      ),
    ).toEqual([]);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({ level: "warn", topic: "review-refresh" }),
    );
  });
});

async function setUp() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-refresh-viewed-"));
  roots.push(root);
  const logs: LogEntryInput[] = [];
  const viewedFiles = new ViewedFilesStore(PatchdeskPaths.forTest(root), {
    write: () => undefined,
  });
  const oldPatchPath = absolute(join(root, "old.patch"));
  const newPatchPath = absolute(join(root, "new.patch"));
  const newSession = createReviewRefreshSession({
    identity,
    snapshot: { ...snapshot, pullRequest: newHead },
    createdAt: at,
    headSha: newHeadSha,
    patchPath: newPatchPath,
  });
  const fixture = createReviewRefreshFixture({
    session: { ...session, patchPath: oldPatchPath },
    currentPullRequest: newHead,
    preparedSession: newSession,
    viewedFiles,
    log: { write: (entry) => logs.push(entry) },
  });
  return { fixture, viewedFiles, logs, oldPatchPath, newPatchPath, newSession };
}

function filePatch(path: string, line: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-old",
    `+${line}`,
    "",
  ].join("\n");
}

function absolute(path: string): AbsolutePath {
  return must(parseAbsolutePath(path));
}

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}
