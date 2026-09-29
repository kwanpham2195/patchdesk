import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  parseGitShaPrefix,
  parseRepoRelativePath,
  parseReviewId,
  parseReviewSessionId,
} from "../../src/domain/ids";
import type { LogEntryInput } from "../../src/domain/log-entry";
import { ok } from "../../src/domain/result";
import { createReadOnlyGitExecutor } from "../../src/main/local-api-stores";
import { LocalCheckoutChangeDetector } from "../../src/services/local-checkout-change-detector";
import { ReviewWorkbenchController } from "../../src/services/review-workbench-controller";
import type { GitReadExecutor } from "../../src/services/review-worktree-service";
import {
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  now,
  profileId,
  value,
  type LocalApplyHarness,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

/** The controller behind `POST /v1/reviews/detect-updates`, over the harness's stores and a checkout detector reading real git. */
function detection(
  harness: LocalApplyHarness,
  options: { readonly git?: GitReadExecutor } = {},
) {
  const logs: LogEntryInput[] = [];
  const controller = new ReviewWorkbenchController(
    // SAFETY: detecting updates on a local Review never prepares a pull request session.
    {} as never,
    // SAFETY: detecting updates never projects a workbench.
    {} as never,
    // SAFETY: these are every member `detectUpdates` reaches for a local Review; the pull request members stay unused.
    {
      reviews: harness.reviews,
      coordinator: harness.coordinator,
      localChanges: new LocalCheckoutChangeDetector({
        git: options.git ?? createReadOnlyGitExecutor(new CommandRunner()),
        paths: harness.paths,
        profiles: new ProfileStore(harness.paths),
        sessions: new ReviewSessionStore(harness.paths),
        logs: { write: (entry) => logs.push(entry) },
      }),
    } as never,
    () => now,
  );
  return {
    logs,
    detect: async (reviewId: string) =>
      value(
        await controller.detectUpdates({
          profileId,
          reviewId: value(parseReviewId(reviewId)),
        }),
      ),
  };
}

/** A shared Review opened on `main` over an uncommitted edit to `tracked.txt`. */
async function editedReview(harness: LocalApplyHarness) {
  await writeFile(join(harness.repositoryPath, "tracked.txt"), "two\n");
  const workbench = await harness.open();
  return { workbench, reviewId: value(parseReviewId(workbench.review.id)) };
}

describe("Detecting updates on a shared local Review", () => {
  const changes = [
    {
      name: "a second edit to the already modified file",
      apply: (repo: string) => writeFile(join(repo, "tracked.txt"), "three\n"),
      revert: (repo: string) => writeFile(join(repo, "tracked.txt"), "two\n"),
    },
    {
      name: "a new untracked file",
      apply: (repo: string) => writeFile(join(repo, "added.txt"), "new\n"),
      revert: (repo: string) => rm(join(repo, "added.txt")),
    },
    {
      // `git hash-object` cannot read a symlink to a directory.
      name: "a new untracked symlink to a directory",
      apply: async (repo: string) => {
        await mkdir(join(repo, "ignored-dir"));
        await writeFile(join(repo, ".git", "info", "exclude"), "ignored-dir\n");
        await symlink("ignored-dir", join(repo, "linked"));
      },
      revert: (repo: string) => rm(join(repo, "linked")),
    },
    {
      name: "a commit of the edit",
      apply: async (repo: string) => {
        git(repo, "commit", "-q", "-am", "commit the edit");
      },
      revert: async (repo: string) => {
        git(repo, "reset", "-q", "--soft", "HEAD~1");
      },
    },
  ];

  it.each(changes)(
    "answers RevisionChanged after $name, Unchanged after its revert, and never moves the Review",
    async ({ apply, revert }) => {
      const harness = await localApplyHarness();
      const { reviewId } = await editedReview(harness);
      const { detect } = detection(harness);
      const stored = value(await harness.reviews.load(profileId, reviewId));

      await apply(harness.repositoryPath);
      expect(await detect(reviewId)).toMatchObject({ _tag: "RevisionChanged" });
      expect(value(await harness.reviews.load(profileId, reviewId))).toEqual(
        stored,
      );

      await revert(harness.repositoryPath);
      expect(await detect(reviewId)).toMatchObject({ _tag: "Unchanged" });
      expect(value(await harness.reviews.load(profileId, reviewId))).toEqual(
        stored,
      );
    },
  );

  it("fingerprints a session stored without a fingerprint on its first check, then reports an edit", async () => {
    const harness = await localApplyHarness();
    const { workbench, reviewId } = await editedReview(harness);
    const sessionFile = harness.paths.sessionFile(
      profileId,
      value(parseReviewSessionId(workbench.session.id)),
    );
    // Only the fingerprint is read; the rest is written back as stored.
    const stored: { readonly checkoutFingerprint?: string } = JSON.parse(
      await readFile(sessionFile, "utf8"),
    );
    const { checkoutFingerprint, ...legacy } = stored;
    expect(checkoutFingerprint).toEqual(expect.any(String));
    await writeFile(sessionFile, JSON.stringify(legacy));
    const { detect } = detection(harness);

    expect(await detect(reviewId)).toMatchObject({ _tag: "Unchanged" });
    await writeFile(join(harness.repositoryPath, "tracked.txt"), "three\n");

    expect(await detect(reviewId)).toMatchObject({ _tag: "RevisionChanged" });
  });

  it("skips a Commit Review, whose commit cannot change", async () => {
    const harness = await localApplyHarness();
    const head = git(harness.repositoryPath, "rev-parse", "HEAD").trim();
    const workbench = await harness.open({
      kind: "commit",
      commit: value(parseGitShaPrefix(head)),
    });
    const { detect } = detection(harness);
    expect(await detect(workbench.review.id)).toMatchObject({
      _tag: "Unchanged",
    });

    await writeFile(join(harness.repositoryPath, "tracked.txt"), "three\n");

    expect(await detect(workbench.review.id)).toMatchObject({
      _tag: "Unchanged",
    });
  });

  it("answers Unchanged while the checkout is on another branch, which Refresh refuses", async () => {
    const harness = await localApplyHarness();
    const { reviewId } = await editedReview(harness);
    const { detect } = detection(harness);
    git(harness.repositoryPath, "checkout", "-q", "-b", "other");
    await writeFile(join(harness.repositoryPath, "tracked.txt"), "three\n");

    expect(await detect(reviewId)).toMatchObject({ _tag: "Unchanged" });
  });

  it("answers Unchanged when the checkout cannot be read, and logs it once", async () => {
    const harness = await localApplyHarness();
    const { reviewId } = await editedReview(harness);
    const { detect, logs } = detection(harness);
    await rename(harness.repositoryPath, `${harness.repositoryPath}-moved`);

    expect(await detect(reviewId)).toMatchObject({ _tag: "Unchanged" });
    expect(await detect(reviewId)).toMatchObject({ _tag: "Unchanged" });

    expect(logs).toEqual([
      expect.objectContaining({
        level: "warn",
        meta: { reviewId, cause: "CheckoutMissing" },
      }),
    ]);
  });

  it("lets a note be saved while the checkout is read, and takes no optional git lock", async () => {
    const harness = await localApplyHarness();
    const { workbench, reviewId } = await editedReview(harness);
    const realGit = createReadOnlyGitExecutor(new CommandRunner());
    const argvs: Array<ReadonlyArray<string>> = [];
    let reachedDiff!: () => void;
    const diffReached = new Promise<void>((resolve) => {
      reachedDiff = resolve;
    });
    let releaseDiff!: () => void;
    const diffReleased = new Promise<void>((resolve) => {
      releaseDiff = resolve;
    });
    const { detect } = detection(harness, {
      git: {
        run: async (argv, environment) => {
          argvs.push(argv);
          if (argv.includes("diff")) {
            reachedDiff();
            await diffReleased;
          }
          return realGit.run(argv, environment);
        },
      },
    });
    await writeFile(join(harness.repositoryPath, "tracked.txt"), "three\n");

    const detected = detect(reviewId);
    await diffReached;
    const note = await harness.drafts.addNote({
      view: "combined",
      profileId,
      reviewId,
      sessionId: workbench.session.id,
      anchor: {
        path: value(parseRepoRelativePath("tracked.txt")),
        side: "new",
        startLine: 1,
        line: 1,
      },
      text: "Keep the old value.",
    });
    releaseDiff();

    expect(note).toEqual(ok(expect.anything()));
    expect(await detected).toMatchObject({ _tag: "RevisionChanged" });
    expect(argvs.length).toBeGreaterThan(0);
    for (const argv of argvs) expect(argv[1]).toBe("--no-optional-locks");
  });
});
