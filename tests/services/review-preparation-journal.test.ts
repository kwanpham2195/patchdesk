import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  createReviewSessionId,
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { ReviewPreparationJournal } from "../../src/services/review-preparation-journal";
import type { Result } from "../../src/domain/result";
import { ReviewWorktreeService } from "../../src/services/review-worktree-service";
import { ok } from "../../src/domain/result";
import { createReviewSession } from "../../src/domain/review-session";

const roots: string[] = [];

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("fixture");
  return result.value;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-preparation-journal-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const profileId = must(parseWorkspaceProfileId("cfw"));
  const sessionId = createReviewSessionId({
    profileId,
    host: must(parseGitHubHost("github.com")),
    owner: must(parseGitHubOwner("centraldigital")),
    repo: must(parseGitHubRepoName("patchdesk")),
    prNumber: must(parsePullRequestNumber(42)),
    headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
  });
  const sessionDirectory = paths.sessionDirectory(profileId, sessionId);
  const journalFile = join(sessionDirectory, "preparation.journal.json");
  return { root, paths, profileId, sessionId, sessionDirectory, journalFile };
}

function worktrees(paths: PatchdeskPaths): ReviewWorktreeService {
  return new ReviewWorktreeService(paths, { run: async () => ok({ stdout: "" }) });
}

async function writePersistedJournal(
  filePath: string,
  content: {
    readonly profileId: string;
    readonly sessionId: string;
    readonly stagingRoot: string;
    readonly targets: ReadonlyArray<string>;
    readonly state?: "preparing" | "committing";
  },
): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, JSON.stringify({ schemaVersion: 1, state: "preparing", ...content }), "utf8");
}

async function expectPresent(path: string): Promise<void> {
  await expect(access(path)).resolves.toBeUndefined();
}

function persistedSession(subject: Awaited<ReturnType<typeof fixture>>) {
  const host = must(parseGitHubHost("github.com"));
  const owner = must(parseGitHubOwner("centraldigital"));
  const repo = must(parseGitHubRepoName("patchdesk"));
  const prNumber = must(parsePullRequestNumber(42));
  const headSha = must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12"));
  return createReviewSession({
    key: { profileId: subject.profileId, host, owner, repo, prNumber, headSha },
    pr: {
      headSha,
      baseSha: headSha,
      isDraft: false,
      isOpen: true,
    },
    patchPath: must(parseAbsolutePath(subject.paths.patchFile(subject.profileId, subject.sessionId))),
    worktree: {
      path: must(parseAbsolutePath(subject.paths.worktreeDirectory(subject.profileId, subject.sessionId))),
      headSha,
    },
    createdAt: must(parseIsoTimestamp("2026-08-01T00:00:00.000Z")),
  });
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ReviewPreparationJournal", () => {
  it("exposes an active operation without exposing journal paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-preparation-journal-"));
    roots.push(root);
    const paths = PatchdeskPaths.forTest(root);
    const profileId = parseWorkspaceProfileId("cfw");
    const host = parseGitHubHost("github.com");
    const owner = parseGitHubOwner("centraldigital");
    const repo = parseGitHubRepoName("patchdesk");
    const prNumber = parsePullRequestNumber(42);
    const headSha = parseGitSha("abcdef1234567890abcdef1234567890abcdef12");
    const sessionId = createReviewSessionId({
      profileId: must(profileId),
      host: must(host),
      owner: must(owner),
      repo: must(repo),
      prNumber: must(prNumber),
      headSha: must(headSha),
    });
    const profile = must(profileId);
    const journal = await ReviewPreparationJournal.begin(paths, profile, sessionId);
    expect(journal).toMatchObject({ _tag: "ok" });
    await expect(ReviewPreparationJournal.activeFor(paths, profile, sessionId)).resolves.toEqual({
      _tag: "ok",
      value: { profileId: profile, sessionId, phase: "preparing" },
    });
    if (journal._tag === "ok") await journal.value.complete();
    await expect(ReviewPreparationJournal.activeFor(paths, profile, sessionId)).resolves.toEqual({ _tag: "ok", value: undefined });
  });

  it("preserves an outside sentinel when a persisted target is absolute", async () => {
    const subject = await fixture();
    const sentinel = join(subject.root, "outside-absolute-sentinel");
    await writeFile(sentinel, "keep", "utf8");
    await writePersistedJournal(subject.journalFile, {
      profileId: subject.profileId,
      sessionId: subject.sessionId,
      stagingRoot: join(subject.sessionDirectory, ".staging"),
      targets: [sentinel],
    });

    await expect(ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths))).resolves.toEqual({ recovered: 0, failed: 1 });

    await expectPresent(sentinel);
    await expectPresent(subject.journalFile);
  });

  it("preserves an outside sentinel when a persisted target lexically escapes the Session", async () => {
    const subject = await fixture();
    const sentinel = join(subject.root, "outside-parent-sentinel");
    await writeFile(sentinel, "keep", "utf8");
    await writePersistedJournal(subject.journalFile, {
      profileId: subject.profileId,
      sessionId: subject.sessionId,
      stagingRoot: join(subject.sessionDirectory, ".staging"),
      targets: [join(subject.sessionDirectory, "..", "..", "..", "..", "..", "..", "outside-parent-sentinel")],
    });

    await expect(ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths))).resolves.toEqual({ recovered: 0, failed: 1 });

    await expectPresent(sentinel);
    await expectPresent(subject.journalFile);
  });

  it("preserves a symlinked staging root and its outside sentinel", async () => {
    const subject = await fixture();
    const sentinelDirectory = join(subject.root, "outside-symlink-sentinel");
    const sentinel = join(sentinelDirectory, "sentinel");
    await mkdir(sentinelDirectory, { recursive: true });
    await writeFile(sentinel, "keep", "utf8");
    await mkdir(subject.sessionDirectory, { recursive: true });
    await symlink(sentinelDirectory, join(subject.sessionDirectory, ".staging"));
    await writePersistedJournal(subject.journalFile, {
      profileId: subject.profileId,
      sessionId: subject.sessionId,
      stagingRoot: join(subject.sessionDirectory, ".staging"),
      targets: [],
    });

    await expect(ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths))).resolves.toEqual({ recovered: 0, failed: 1 });

    await expectPresent(sentinel);
    await expectPresent(subject.journalFile);
  });

  it("preserves an outside sentinel when the persisted staging root differs from the derived root", async () => {
    const subject = await fixture();
    const sentinel = join(subject.root, "outside-staging-sentinel");
    await writeFile(sentinel, "keep", "utf8");
    await writePersistedJournal(subject.journalFile, {
      profileId: subject.profileId,
      sessionId: subject.sessionId,
      stagingRoot: sentinel,
      targets: [],
    });

    await expect(ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths))).resolves.toEqual({ recovered: 0, failed: 1 });

    await expectPresent(sentinel);
    await expectPresent(subject.journalFile);
  });

  it("recovers an interrupted preparation by deleting only its derived Session paths", async () => {
    const subject = await fixture();
    const journal = must(await ReviewPreparationJournal.begin(subject.paths, subject.profileId, subject.sessionId));
    const staged = join(journal.stagingRoot, "artifact.tmp");
    const target = subject.paths.preparedContextFile(subject.profileId, subject.sessionId);
    await mkdir(join(staged, ".."), { recursive: true });
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(staged, "staged", "utf8");
    await writeFile(target, "target", "utf8");
    expect((await journal.record(target))._tag).toBe("ok");
    expect(JSON.parse(await readFile(subject.journalFile, "utf8"))).toMatchObject({
      stagingRoot: journal.stagingRoot,
      targets: [target],
    });

    await expect(ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths))).resolves.toEqual({ recovered: 1, failed: 0 });

    await expect(access(target)).rejects.toThrow();
    await expect(access(journal.stagingRoot)).rejects.toThrow();
    await expect(access(subject.journalFile)).rejects.toThrow();
  });

  it("removes a committed journal while retaining its prepared artifacts", async () => {
    const subject = await fixture();
    const journal = must(await ReviewPreparationJournal.begin(subject.paths, subject.profileId, subject.sessionId));
    const target = subject.paths.preparedContextFile(subject.profileId, subject.sessionId);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "target", "utf8");
    expect((await journal.record(target))._tag).toBe("ok");
    expect((await journal.markCommitting())._tag).toBe("ok");
    const persisted = persistedSession(subject);
    const sessions = {
      load: async () => ok(persisted),
    };

    await expect(ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths), sessions)).resolves.toEqual({ recovered: 1, failed: 0 });

    await expectPresent(target);
    await expect(access(subject.journalFile)).rejects.toThrow();
  });
});
