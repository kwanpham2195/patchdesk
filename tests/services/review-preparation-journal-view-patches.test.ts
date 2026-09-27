import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  createReviewSessionId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseLocalBranchName,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { ok, type Result } from "../../src/domain/result";
import { ReviewPreparationJournal } from "../../src/services/review-preparation-journal";
import { ReviewWorktreeService } from "../../src/services/review-worktree-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("fixture");
  return result.value;
}

it("recovers an interrupted shared Review preparation by deleting all three of its patch files (#556)", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-view-patches-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const profileId = must(parseWorkspaceProfileId("acme"));
  const sessionId = createReviewSessionId({
    profileId,
    host: must(parseGitHubHost("github.com")),
    owner: must(parseGitHubOwner("octo-org")),
    repo: must(parseGitHubRepoName("patchdesk")),
    source: {
      kind: "local_branch",
      branch: must(parseLocalBranchName("feature")),
      baseBranch: must(parseLocalBranchName("main")),
    },
    headSha: must(parseGitSha("a".repeat(40))),
    baseSha: must(parseGitSha("b".repeat(40))),
  });
  const journal = must(
    await ReviewPreparationJournal.begin(paths, profileId, sessionId),
  );
  const targets = [
    paths.patchFile(profileId, sessionId),
    paths.viewPatchFile(profileId, sessionId, "committed"),
    paths.viewPatchFile(profileId, sessionId, "uncommitted"),
  ];
  expect((await journal.recordAll(targets))._tag).toBe("ok");
  for (const target of targets) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "diff --git a/x b/x\n", "utf8");
  }
  // No worktree was recorded and the journal never reached `committing`, so recovery runs no git and asks no store.
  const unused = () => {
    throw new Error("recovery must not reach this");
  };
  const worktrees = new ReviewWorktreeService(
    paths,
    { run: unused },
    { environmentFor: async () => ok({}) },
    async () => undefined,
  );

  await expect(
    ReviewPreparationJournal.recover(paths, worktrees, { load: unused }),
  ).resolves.toEqual({ recovered: 1, failed: 0 });

  for (const target of targets) await expect(access(target)).rejects.toThrow();
});
