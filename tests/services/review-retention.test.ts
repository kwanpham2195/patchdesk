import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProfileStore } from "../../src/adapters/storage/profile-store";
import {
  createLocalNoteId,
  createReviewSessionId,
  parseAbsolutePath,
  parseContentHash,
  parseFindingId,
  parseGitSha,
  parseIsoTimestamp,
  parseLocalBaseRef,
  parseLocalBranchName,
  parseRepoRelativePath,
  parseReviewSessionId,
  type ReviewSessionId,
} from "../../src/domain/ids";
import { createReview } from "../../src/domain/review";
import { err } from "../../src/domain/result";
import type { ReviewWorkbenchProjection } from "../../src/services/review-workbench-projection";
import { ReviewPreparationJournal } from "../../src/services/review-preparation-journal";
import {
  beginRun,
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  now,
  profileId,
  repository,
  retainAnalysis,
  sharedAgainstMain,
  value,
  type LocalApplyHarness,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

/** A session id no stored session has. */
const orphanSessionId =
  "github.com__octo-org__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab";

const fifteenDaysLater = value(
  parseIsoTimestamp(
    new Date(Date.parse(now) + 15 * 24 * 60 * 60 * 1000).toISOString(),
  ),
);

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

/** A preparation journal left open on the session, as an interrupted preparation leaves it. */
async function beginPreparation(
  harness: LocalApplyHarness,
  sessionId: ReviewSessionId,
): Promise<void> {
  value(
    await ReviewPreparationJournal.begin(harness.paths, profileId, sessionId),
  );
}

/** A shared Review opened on branch `feature`, which is then deleted. */
async function reviewOfDeletedBranch(harness: LocalApplyHarness) {
  git(harness.repositoryPath, "checkout", "-q", "-b", "feature");
  const { first } = await refreshedReview(harness, 0);
  git(harness.repositoryPath, "checkout", "-q", "main");
  git(harness.repositoryPath, "branch", "-q", "-D", "feature");
  return first;
}

/** A shared Review opened in linked worktree `linked` on branch `feat`, which is then removed; the branch stays. */
async function reviewOfRemovedWorktree(
  harness: LocalApplyHarness,
  beforeRemoval: (
    workbench: ReviewWorkbenchProjection,
  ) => Promise<void> = async () => undefined,
) {
  const linked = join(dirname(harness.repositoryPath), "linked");
  git(harness.repositoryPath, "worktree", "add", "-q", linked, "-b", "feat");
  await writeFile(join(linked, "probe.txt"), "linked\n");
  const workbench = await harness.open(
    sharedAgainstMain(value(parseAbsolutePath(linked))),
  );
  await beforeRemoval(workbench);
  git(harness.repositoryPath, "worktree", "remove", "--force", linked);
  return workbench;
}

async function reviewKept(
  harness: LocalApplyHarness,
  workbench: ReviewWorkbenchProjection,
): Promise<boolean> {
  return (
    (await harness.reviews.load(profileId, workbench.review.id))._tag === "ok"
  );
}

/** Opens a shared Review of `probe.txt`, then edits and Refreshes it `edits` times. */
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

async function storeLegacyReview(
  harness: LocalApplyHarness,
  withNote: boolean,
  kind: "working_tree" | "branch" = "working_tree",
) {
  const branch = value(parseLocalBranchName("main"));
  const identity = {
    profileId,
    ...repository,
    source:
      kind === "branch"
        ? { kind, branch, baseBranch: branch }
        : { kind, branch },
  };
  const sessionId = createReviewSessionId({
    ...identity,
    headSha: value(parseGitSha("a".repeat(40))),
    baseSha: value(parseGitSha("b".repeat(40))),
  });
  const stored = createReview({
    identity,
    currentSessionId: sessionId,
    headSha: value(parseGitSha("a".repeat(40))),
    createdAt: now,
  });
  value(
    await harness.reviews.save(
      withNote
        ? {
            ...stored,
            localDrafts: [
              {
                author: "maintainer",
                noteId: createLocalNoteId("fixture-old"),
                sessionId,
                anchor: {
                  path: value(parseRepoRelativePath("tracked.txt")),
                  side: "new",
                  startLine: 1,
                  line: 1,
                  selectedLines: ["one"],
                  before: [],
                  after: [],
                },
                text: "Written before the shared Review.",
                createdAt: now,
                updatedAt: now,
              },
            ],
          }
        : stored,
    ),
  );
  return stored;
}

describe("ReviewRetention", () => {
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
        // Not OutcomeUnknown: the Refresh below would settle that (#484).
        state: "Requested",
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

  it("deletes managed refs no stored session names and keeps the current session's", async () => {
    const harness = await localApplyHarness();
    const { latest } = await refreshedReview(harness, 0);
    const gone =
      "github.com__octo-org__patchdesk__pr-42__sha-abcdef12__base-00000000__0123456789ab";
    git(
      harness.repositoryPath,
      "update-ref",
      `refs/patchdesk/reviews/${profileId}/${gone}/head`,
      "HEAD",
    );
    git(
      harness.repositoryPath,
      "update-ref",
      `refs/patchdesk/local/${profileId}/${gone}/head`,
      "HEAD",
    );

    value(await harness.retention.sweepProfile(profileId));

    expect(
      git(
        harness.repositoryPath,
        "for-each-ref",
        "--format=%(refname)",
        "refs/patchdesk/",
      ).trim(),
    ).toBe(`refs/patchdesk/local/${profileId}/${latest.session.id}/head`);
  });

  it("removes a local Review whose branch was deleted and that was left alone for 14 days", async () => {
    const harness = await localApplyHarness(undefined, {
      retentionNow: () => fifteenDaysLater,
    });
    git(harness.repositoryPath, "checkout", "-q", "-b", "feature");
    const { first } = await refreshedReview(harness, 1);
    git(harness.repositoryPath, "checkout", "-q", "main");
    git(harness.repositoryPath, "branch", "-q", "-D", "feature");

    value(await harness.retention.sweepProfile(profileId));

    expect(await harness.reviews.load(profileId, first.review.id)).toEqual({
      _tag: "err",
      error: expect.objectContaining({ reason: "not_found" }),
    });
    expect(
      await present(
        harness.paths.sessionDirectory(profileId, first.session.id),
      ),
    ).toBe(false);
    expect(localRefs(harness.repositoryPath)).toEqual([]);
    expect(sessionWorktrees(harness.repositoryPath)).toEqual([]);
  });

  it("keeps a local Review on a remote-tracking base while the ref exists and removes it once a prune deletes it (#591)", async () => {
    const harness = await localApplyHarness(undefined, {
      retentionNow: () => fifteenDaysLater,
    });
    git(
      harness.repositoryPath,
      "update-ref",
      "refs/remotes/origin/main",
      "HEAD",
    );
    git(harness.repositoryPath, "checkout", "-q", "-b", "feature");
    await writeFile(join(harness.repositoryPath, "probe.txt"), "feature\n");
    const opened = await harness.open({
      kind: "local_branch",
      baseRef: value(parseLocalBaseRef("refs/remotes/origin/main")),
    });

    value(await harness.retention.sweepProfile(profileId));
    const keptWithBase = await reviewKept(harness, opened);
    git(harness.repositoryPath, "update-ref", "-d", "refs/remotes/origin/main");
    value(await harness.retention.sweepProfile(profileId));

    expect(keptWithBase).toBe(true);
    expect(await reviewKept(harness, opened)).toBe(false);
  });

  it("keeps a local Review whose branch was deleted within the last 14 days", async () => {
    const harness = await localApplyHarness();
    git(harness.repositoryPath, "checkout", "-q", "-b", "feature");
    const { first } = await refreshedReview(harness, 0);
    git(harness.repositoryPath, "checkout", "-q", "main");
    git(harness.repositoryPath, "branch", "-q", "-D", "feature");

    value(await harness.retention.sweepProfile(profileId));

    expect(
      value(await harness.reviews.load(profileId, first.review.id))
        .currentSessionId,
    ).toBe(first.session.id);
  });

  it("keeps a local Review whose branch was deleted while it holds a Local draft", async () => {
    const harness = await localApplyHarness(undefined, {
      retentionNow: () => fifteenDaysLater,
    });
    git(harness.repositoryPath, "checkout", "-q", "-b", "feature");
    const { first } = await refreshedReview(harness, 0);
    value(
      await harness.drafts.addNote({
        view: "combined",
        profileId,
        reviewId: first.review.id,
        sessionId: first.session.id,
        anchor: {
          path: value(parseRepoRelativePath("probe.txt")),
          side: "new",
          startLine: 1,
          line: 1,
        },
        text: "Keep this.",
      }),
    );
    git(harness.repositoryPath, "checkout", "-q", "main");
    git(harness.repositoryPath, "branch", "-q", "-D", "feature");

    value(await harness.retention.sweepProfile(profileId));

    expect(
      value(await harness.reviews.load(profileId, first.review.id))
        .currentSessionId,
    ).toBe(first.session.id);
    expect(localRefs(harness.repositoryPath)).toHaveLength(1);
  });

  it("keeps a Review whose deleted branch cannot be read because Git failed", async () => {
    const harness = await localApplyHarness(
      async (argv, run) =>
        argv.some((arg) => arg.includes("refs/heads/feature"))
          ? err({ _tag: "GitReadFailed" as const })
          : run(),
      { retentionNow: () => fifteenDaysLater },
    );
    const workbench = await reviewOfDeletedBranch(harness);

    value(await harness.retention.sweepProfile(profileId));

    expect(await reviewKept(harness, workbench)).toBe(true);
  });

  it("removes a Review of a linked worktree that was removed and left alone for 14 days", async () => {
    const harness = await localApplyHarness(undefined, {
      retentionNow: () => fifteenDaysLater,
    });
    const workbench = await reviewOfRemovedWorktree(harness);

    value(await harness.retention.sweepProfile(profileId));

    expect(await reviewKept(harness, workbench)).toBe(false);
    expect(localRefs(harness.repositoryPath)).toEqual([]);
    expect(sessionWorktrees(harness.repositoryPath)).toEqual([]);
  });

  it("removes a Review of a linked worktree once the profile's local path is re-pointed to that worktree", async () => {
    const harness = await localApplyHarness(undefined, {
      retentionNow: () => fifteenDaysLater,
    });
    const linked = join(dirname(harness.repositoryPath), "linked");
    git(harness.repositoryPath, "worktree", "add", "-q", linked, "-b", "feat");
    const workbench = await harness.open(
      sharedAgainstMain(value(parseAbsolutePath(linked))),
    );
    const profiles = new ProfileStore(harness.paths);
    const profile = value(await profiles.load(profileId));
    value(
      await profiles.save({
        ...profile,
        repos: profile.repos.map((repository) => ({
          ...repository,
          localPath: value(parseAbsolutePath(linked)),
        })),
      }),
    );

    value(await harness.retention.sweepProfile(profileId));

    expect(await reviewKept(harness, workbench)).toBe(false);
  });

  it("keeps a Review of a locked linked worktree whose directory is missing, as on removable media", async () => {
    const harness = await localApplyHarness(undefined, {
      retentionNow: () => fifteenDaysLater,
    });
    const linked = join(dirname(harness.repositoryPath), "linked");
    git(harness.repositoryPath, "worktree", "add", "-q", linked, "-b", "feat");
    const workbench = await harness.open(
      sharedAgainstMain(value(parseAbsolutePath(linked))),
    );
    git(harness.repositoryPath, "worktree", "lock", linked);
    await rm(linked, { recursive: true, force: true });

    value(await harness.retention.sweepProfile(profileId));

    expect(await reviewKept(harness, workbench)).toBe(true);
  });

  it("keeps a Review of a removed linked worktree when Git cannot list worktrees", async () => {
    const harness = await localApplyHarness(
      async (argv, run) =>
        argv.includes("worktree") && argv.includes("list")
          ? err({ _tag: "GitReadFailed" as const })
          : run(),
      { retentionNow: () => fifteenDaysLater },
    );
    const workbench = await reviewOfRemovedWorktree(harness);

    value(await harness.retention.sweepProfile(profileId));

    expect(await reviewKept(harness, workbench)).toBe(true);
  });

  it("keeps a Review of a removed linked worktree while it holds a Local draft", async () => {
    const harness = await localApplyHarness(undefined, {
      retentionNow: () => fifteenDaysLater,
    });
    const workbench = await reviewOfRemovedWorktree(harness, async (opened) => {
      value(
        await harness.drafts.addNote({
          view: "combined",
          profileId,
          reviewId: opened.review.id,
          sessionId: opened.session.id,
          anchor: {
            path: value(parseRepoRelativePath("probe.txt")),
            side: "new",
            startLine: 1,
            line: 1,
          },
          text: "Keep this.",
        }),
      );
    });

    value(await harness.retention.sweepProfile(profileId));

    expect(await reviewKept(harness, workbench)).toBe(true);
  });

  it.each([
    ["an active preparation", beginPreparation],
    [
      "only a worktree directory",
      (harness: LocalApplyHarness, sessionId: ReviewSessionId) =>
        mkdir(harness.paths.worktreeDirectory(profileId, sessionId), {
          recursive: true,
        }).then(() => undefined),
    ],
    [
      "an unreadable session record",
      async (harness: LocalApplyHarness, sessionId: ReviewSessionId) => {
        await mkdir(harness.paths.sessionDirectory(profileId, sessionId), {
          recursive: true,
        });
        await writeFile(harness.paths.sessionFile(profileId, sessionId), "{");
      },
    ],
  ] as const)(
    "keeps a managed ref whose session has %s",
    async (_label, arrange) => {
      const harness = await localApplyHarness();
      const sessionId = value(parseReviewSessionId(orphanSessionId));
      const ref = `refs/patchdesk/local/${profileId}/${sessionId}/head`;
      git(harness.repositoryPath, "update-ref", ref, "HEAD");
      await arrange(harness, sessionId);

      value(await harness.retention.sweepProfile(profileId));

      expect(localRefs(harness.repositoryPath)).toContain(ref);
    },
  );

  it.each([
    [
      "a preparation in progress",
      (harness: LocalApplyHarness, workbench: ReviewWorkbenchProjection) =>
        beginPreparation(harness, workbench.session.id),
    ],
    [
      "an active Analysis run",
      (harness: LocalApplyHarness, workbench: ReviewWorkbenchProjection) =>
        beginRun(harness.insights, workbench, "analysis"),
    ],
  ] as const)(
    "keeps a Review whose branch was deleted while it has %s",
    async (_label, arrange) => {
      const harness = await localApplyHarness(undefined, {
        retentionNow: () => fifteenDaysLater,
      });
      const workbench = await reviewOfDeletedBranch(harness);
      await arrange(harness, workbench);

      value(await harness.retention.sweepProfile(profileId));

      expect(await reviewKept(harness, workbench)).toBe(true);
    },
  );

  it.each(["analysis", "brief"] as const)(
    "keeps a superseded session while its %s run is active",
    async (type) => {
      const harness = await localApplyHarness();
      const { first } = await refreshedReview(harness, 0);
      await beginRun(harness.insights, first, type);
      await writeFile(join(harness.repositoryPath, "probe.txt"), "edit 1\n");

      value(await harness.opening.refresh(profileId, first.review.id));

      expect(
        await present(
          harness.paths.worktreeDirectory(profileId, first.session.id),
        ),
      ).toBe(true);
      expect(
        await present(harness.paths.patchFile(profileId, first.session.id)),
      ).toBe(true);
    },
  );

  it("keeps a Review whose branch was deleted once its repository has no local path", async () => {
    const harness = await localApplyHarness(undefined, {
      retentionNow: () => fifteenDaysLater,
    });
    const workbench = await reviewOfDeletedBranch(harness);
    const profiles = new ProfileStore(harness.paths);
    const profile = value(await profiles.load(profileId));
    value(
      await profiles.save({
        ...profile,
        repos: profile.repos.map(
          ({ localPath: _localPath, ...repository }) => repository,
        ),
      }),
    );

    value(await harness.retention.sweepProfile(profileId));

    expect(await reviewKept(harness, workbench)).toBe(true);
  });

  it("keeps a shared Review of a detached HEAD past 14 days while its base exists", async () => {
    const harness = await localApplyHarness(undefined, {
      retentionNow: () => fifteenDaysLater,
    });
    git(harness.repositoryPath, "checkout", "-q", "--detach");
    const { first } = await refreshedReview(harness, 0);

    value(await harness.retention.sweepProfile(profileId));

    expect(await reviewKept(harness, first)).toBe(true);
  });

  it.each([
    ["working_tree", false],
    ["working_tree", true],
    ["branch", false],
    ["branch", true],
  ] as const)(
    "keeps a legacy %s Review when its repository path is missing (holds a note: %s)",
    async (kind, withNote) => {
      let gitReads = 0;
      const harness = await localApplyHarness(
        (argv, run) => {
          if (argv.includes("-C")) gitReads += 1;
          return run();
        },
        { retentionNow: () => fifteenDaysLater },
      );
      const stored = await storeLegacyReview(harness, withNote, kind);
      const cache = harness.paths.worktreeDirectory(
        profileId,
        stored.currentSessionId,
      );
      await mkdir(cache, { recursive: true });
      await rm(harness.repositoryPath, { recursive: true });

      value(await harness.retention.sweepProfile(profileId));
      value(await harness.retention.sweepProfile(profileId));

      expect((await harness.reviews.load(profileId, stored.id))._tag).toBe(
        "ok",
      );
      expect(await present(cache)).toBe(true);
      expect(gitReads).toBe(0);
      const events = value(await harness.diagnostics.recent(profileId));
      expect(
        events.filter((event) =>
          event.detail?.includes("repository path is missing"),
        ),
      ).toEqual([
        expect.objectContaining({
          category: "cleanup",
          retryable: false,
          sessionId: stored.currentSessionId,
        }),
      ]);
      expect(events.filter((event) => event.retryable)).toHaveLength(0);
    },
  );

  it.each([
    ["removes", false],
    ["keeps", true],
  ] as const)(
    "%s a working-tree Review stored before the shared Review and left alone for 14 days (holds a note: %s)",
    async (_action, withNote) => {
      const harness = await localApplyHarness(undefined, {
        retentionNow: () => fifteenDaysLater,
      });
      const stored = await storeLegacyReview(harness, withNote);

      value(await harness.retention.sweepProfile(profileId));

      expect((await harness.reviews.load(profileId, stored.id))._tag).toBe(
        withNote ? "ok" : "err",
      );
    },
  );
});
