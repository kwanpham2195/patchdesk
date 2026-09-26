import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseContentHash,
  parseFindingId,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import {
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  now,
  profileId,
  retainAnalysis,
  value,
  type LocalApplyHarness,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

function localRefs(repositoryPath: string): ReadonlyArray<string> {
  const listed = git(
    repositoryPath,
    "for-each-ref",
    "--format=%(refname)",
    "refs/patchdesk/local/",
  ).trim();
  return listed === "" ? [] : listed.split("\n");
}

/** The worktrees Git lists besides the maintainer's own checkout. */
function sessionWorktrees(repositoryPath: string): ReadonlyArray<string> {
  return git(repositoryPath, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .slice(1);
}

function present(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Opens a working-tree Review of `probe.txt`, then edits and Refreshes it `edits` times. */
async function refreshedReview(harness: LocalApplyHarness, edits: number) {
  const probe = join(harness.repositoryPath, "probe.txt");
  await writeFile(probe, "edit 0\n");
  const first = await harness.open();
  let latest = first;
  for (let edit = 1; edit <= edits; edit += 1) {
    await writeFile(probe, `edit ${String(edit)}\n`);
    latest = value(await harness.opening.refresh(profileId, first.review.id));
  }
  return { first, latest };
}

describe("LocalReviewRetention", () => {
  it("leaves only the current session's ref and worktree after three edited Refreshes", async () => {
    const harness = await localApplyHarness();
    const { latest } = await refreshedReview(harness, 3);

    value(await harness.retention.sweepProfile(profileId));

    expect(localRefs(harness.repositoryPath)).toEqual([
      `refs/patchdesk/local/${profileId}/${latest.session.id}/head`,
    ]);
    expect(sessionWorktrees(harness.repositoryPath)).toHaveLength(1);
  });

  it("keeps the patch of a session a retained Insight names and removes its worktree and ref", async () => {
    const harness = await localApplyHarness();
    const probe = join(harness.repositoryPath, "probe.txt");
    await writeFile(probe, "edit 0\n");
    const first = await harness.open();
    await retainAnalysis(harness.insights, first, []);
    await writeFile(probe, "edit 1\n");
    value(await harness.opening.refresh(profileId, first.review.id));

    value(await harness.retention.sweepProfile(profileId));

    const firstSession = first.session.id;
    expect(
      await present(harness.paths.patchFile(profileId, firstSession)),
    ).toBe(true);
    expect(
      await present(harness.paths.worktreeDirectory(profileId, firstSession)),
    ).toBe(false);
    expect(localRefs(harness.repositoryPath)).not.toContain(
      `refs/patchdesk/local/${profileId}/${firstSession}/head`,
    );
    expect(sessionWorktrees(harness.repositoryPath)).toHaveLength(1);
  });

  it("keeps every session of a Review while an Apply operation is recorded", async () => {
    const harness = await localApplyHarness();
    const { first } = await refreshedReview(harness, 0);
    const hash = value(parseContentHash("a".repeat(64)));
    value(
      await harness.operations.save({
        schemaVersion: 1,
        profileId,
        reviewId: first.review.id,
        sessionId: first.session.id,
        headSha: first.session.key.headSha,
        analysisRunId: await retainAnalysis(harness.insights, first, []),
        findingIds: [value(parseFindingId("finding-1"))],
        files: [
          {
            path: value(parseRepoRelativePath("probe.txt")),
            preImageSha256: hash,
            postImageSha256: hash,
          },
        ],
        state: "OutcomeUnknown",
        requestedAt: now,
        updatedAt: now,
      }),
    );
    expect(
      value(await harness.operations.load(profileId, first.review.id)),
    ).toBeDefined();
    await writeFile(join(harness.repositoryPath, "probe.txt"), "edit 1\n");
    value(await harness.opening.refresh(profileId, first.review.id));

    value(await harness.retention.sweepProfile(profileId));

    expect(localRefs(harness.repositoryPath)).toHaveLength(2);
    expect(sessionWorktrees(harness.repositoryPath)).toHaveLength(2);
  });
});
