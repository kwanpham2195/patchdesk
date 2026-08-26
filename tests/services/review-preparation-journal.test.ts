import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import { ReviewLifecycleGate } from "../../src/services/review-lifecycle-gate";

/**
 * Records every `withProfileLock` call (as a string profile id) while still
 * running the operation through the real gate, so a test can assert both
 * "the lock was taken" and "the operation actually ran serialized" from one
 * instance.
 */
class InstrumentedGate extends ReviewLifecycleGate {
  readonly calls: string[] = [];
  override async withProfileLock<T>(
    profileId: Parameters<ReviewLifecycleGate["withProfileLock"]>[0],
    operation: () => Promise<T>,
  ): Promise<T> {
    this.calls.push(String(profileId));
    return super.withProfileLock(profileId, operation);
  }
}

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
    baseSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
  });
  const sessionDirectory = paths.sessionDirectory(profileId, sessionId);
  const journalFile = join(sessionDirectory, "preparation.journal.json");
  return { root, paths, profileId, sessionId, sessionDirectory, journalFile };
}

function worktrees(paths: PatchdeskPaths): ReviewWorktreeService {
  return new ReviewWorktreeService(
    paths,
    {
      // Mirrors real `git worktree remove`'s effect on disk: everything
      // else this fixture exercises never inspects the git executor's
      // stdout, so the stub only needs to actually delete the directory a
      // real worktree removal would.
      run: async (argv) => {
        if (argv[3] === "worktree" && argv[4] === "remove") {
          const target = argv[5];
          if (target !== undefined)
            await rm(target, { recursive: true, force: true }).catch(
              () => undefined,
            );
        }
        return ok({ stdout: "" });
      },
    },
    { environmentFor: async () => ok({}), forget: () => undefined },
    async () => "/usr/local/bin/gh",
  );
}

async function writePersistedJournal(
  filePath: string,
  content: {
    readonly profileId: string;
    readonly sessionId: string;
    readonly stagingRoot: string;
    readonly targets: ReadonlyArray<string>;
    readonly state?: "preparing" | "committing";
    readonly worktree?: {
      readonly path: string;
      readonly repositoryPath: string;
    };
  },
): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({ schemaVersion: 1, state: "preparing", ...content }),
    "utf8",
  );
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
    key: {
      profileId: subject.profileId,
      host,
      owner,
      repo,
      prNumber,
      headSha,
      baseSha: headSha,
    },
    pr: {
      headSha,
      baseSha: headSha,
      isDraft: false,
      isOpen: true,
    },
    patchPath: must(
      parseAbsolutePath(
        subject.paths.patchFile(subject.profileId, subject.sessionId),
      ),
    ),
    worktree: {
      path: must(
        parseAbsolutePath(
          subject.paths.worktreeDirectory(subject.profileId, subject.sessionId),
        ),
      ),
      headSha,
    },
    createdAt: must(parseIsoTimestamp("2026-08-01T00:00:00.000Z")),
  });
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ReviewPreparationJournal", () => {
  it("exposes an active operation without exposing journal paths", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "patchdesk-preparation-journal-"),
    );
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
      baseSha: must(headSha),
    });
    const profile = must(profileId);
    const journal = await ReviewPreparationJournal.begin(
      paths,
      profile,
      sessionId,
    );
    expect(journal).toMatchObject({ _tag: "ok" });
    await expect(
      ReviewPreparationJournal.activeFor(paths, profile, sessionId),
    ).resolves.toEqual({
      _tag: "ok",
      value: { profileId: profile, sessionId, phase: "preparing" },
    });
    if (journal._tag === "ok") await journal.value.complete();
    await expect(
      ReviewPreparationJournal.activeFor(paths, profile, sessionId),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
  });

  it("completes and removes the journal after a metadata-only preparation clears its never-created worktree", async () => {
    const subject = await fixture();
    const journal = must(
      await ReviewPreparationJournal.begin(
        subject.paths,
        subject.profileId,
        subject.sessionId,
      ),
    );
    // Mirrors `ReviewSessionPreparation`: it records the worktree it expects
    // to create before calling `prepare`, then clears the record when
    // `prepare` returns metadata-only without ever creating one. Without
    // clearing it, `complete` would find the recorded path doesn't resolve
    // and leave the journal behind (see `validatedDeletionSet`).
    expect(
      (
        await journal.recordWorktree({
          path: subject.paths.worktreeDirectory(
            subject.profileId,
            subject.sessionId,
          ),
          repositoryPath: join(subject.root, "repo"),
        })
      )._tag,
    ).toBe("ok");
    expect((await journal.clearWorktree())._tag).toBe("ok");

    await journal.complete();
    await journal.complete();

    await expect(access(subject.journalFile)).rejects.toThrow();
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

    await expect(
      ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths)),
    ).resolves.toEqual({ recovered: 0, failed: 1 });

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
      targets: [
        join(
          subject.sessionDirectory,
          "..",
          "..",
          "..",
          "..",
          "..",
          "..",
          "outside-parent-sentinel",
        ),
      ],
    });

    await expect(
      ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths)),
    ).resolves.toEqual({ recovered: 0, failed: 1 });

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
    await symlink(
      sentinelDirectory,
      join(subject.sessionDirectory, ".staging"),
    );
    await writePersistedJournal(subject.journalFile, {
      profileId: subject.profileId,
      sessionId: subject.sessionId,
      stagingRoot: join(subject.sessionDirectory, ".staging"),
      targets: [],
    });

    await expect(
      ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths)),
    ).resolves.toEqual({ recovered: 0, failed: 1 });

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

    await expect(
      ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths)),
    ).resolves.toEqual({ recovered: 0, failed: 1 });

    await expectPresent(sentinel);
    await expectPresent(subject.journalFile);
  });

  it("recovers an interrupted preparation by deleting only its derived Session paths", async () => {
    const subject = await fixture();
    const journal = must(
      await ReviewPreparationJournal.begin(
        subject.paths,
        subject.profileId,
        subject.sessionId,
      ),
    );
    const staged = join(journal.stagingRoot, "artifact.tmp");
    const target = subject.paths.preparedContextFile(
      subject.profileId,
      subject.sessionId,
    );
    await mkdir(join(staged, ".."), { recursive: true });
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(staged, "staged", "utf8");
    await writeFile(target, "target", "utf8");
    expect((await journal.record(target))._tag).toBe("ok");
    expect(
      JSON.parse(await readFile(subject.journalFile, "utf8")),
    ).toMatchObject({
      stagingRoot: journal.stagingRoot,
      targets: [target],
    });

    await expect(
      ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths)),
    ).resolves.toEqual({ recovered: 1, failed: 0 });

    await expect(access(target)).rejects.toThrow();
    await expect(access(journal.stagingRoot)).rejects.toThrow();
    await expect(access(subject.journalFile)).rejects.toThrow();
  });

  it("removes a committed journal while retaining its prepared artifacts", async () => {
    const subject = await fixture();
    const journal = must(
      await ReviewPreparationJournal.begin(
        subject.paths,
        subject.profileId,
        subject.sessionId,
      ),
    );
    const target = subject.paths.preparedContextFile(
      subject.profileId,
      subject.sessionId,
    );
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "target", "utf8");
    expect((await journal.record(target))._tag).toBe("ok");
    expect((await journal.markCommitting())._tag).toBe("ok");
    const persisted = persistedSession(subject);
    const sessions = {
      load: async () => ok(persisted),
    };

    await expect(
      ReviewPreparationJournal.recover(
        subject.paths,
        worktrees(subject.paths),
        sessions,
      ),
    ).resolves.toEqual({ recovered: 1, failed: 0 });

    await expectPresent(target);
    await expect(access(subject.journalFile)).rejects.toThrow();
  });

  it("cleans up a committing journal's target and worktree when no session was ever saved", async () => {
    const subject = await fixture();
    const target = subject.paths.patchFile(
      subject.profileId,
      subject.sessionId,
    );
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "patch", "utf8");

    const worktreePath = subject.paths.worktreeDirectory(
      subject.profileId,
      subject.sessionId,
    );
    const repositoryPath = join(subject.root, "repo");
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await writeFile(
      join(worktreePath, "worktree.json"),
      JSON.stringify({
        profileId: subject.profileId,
        sessionId: subject.sessionId,
      }),
      "utf8",
    );
    await writePersistedJournal(subject.journalFile, {
      profileId: subject.profileId,
      sessionId: subject.sessionId,
      stagingRoot: join(subject.sessionDirectory, ".staging"),
      targets: [target],
      state: "committing",
      worktree: { path: worktreePath, repositoryPath },
    });
    await expectPresent(target);
    await expectPresent(worktreePath);

    // No `sessions` store is passed here: a crash between
    // `journal.markCommitting()` and `sessions.save()` leaves exactly this —
    // a `committing` journal with no persisted Session behind it — and
    // recovery must clean it up exactly like a `preparing` journal would,
    // not just delete the journal file and strand the target and worktree.
    await expect(
      ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths)),
    ).resolves.toEqual({ recovered: 1, failed: 0 });

    await expect(access(target)).rejects.toThrow();
    await expect(access(worktreePath)).rejects.toThrow();
    await expect(access(subject.journalFile)).rejects.toThrow();
  });

  it("returns journal_exists rather than overwriting a live journal, leaving it byte-identical", async () => {
    const subject = await fixture();
    const first = must(
      await ReviewPreparationJournal.begin(
        subject.paths,
        subject.profileId,
        subject.sessionId,
      ),
    );
    const target = subject.paths.preparedContextFile(
      subject.profileId,
      subject.sessionId,
    );
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "target", "utf8");
    expect((await first.record(target))._tag).toBe("ok");
    const before = await readFile(subject.journalFile, "utf8");

    const second = await ReviewPreparationJournal.begin(
      subject.paths,
      subject.profileId,
      subject.sessionId,
    );

    expect(second).toEqual({
      _tag: "err",
      error: { _tag: "PreparationJournalFailed", reason: "journal_exists" },
    });
    expect(await readFile(subject.journalFile, "utf8")).toBe(before);
  });

  it("recoverSession clears a corrupt (invalid JSON) journal so the begin retry succeeds", async () => {
    const subject = await fixture();
    await mkdir(subject.sessionDirectory, { recursive: true });
    await writeFile(subject.journalFile, "{ truncated", "utf8");

    const recovered = await ReviewPreparationJournal.recoverSession(
      subject.paths,
      worktrees(subject.paths),
      subject.profileId,
      subject.sessionId,
      "profile-lock-held",
    );

    expect(recovered).toBe(true);
    await expect(access(subject.journalFile)).rejects.toThrow();

    const retried = await ReviewPreparationJournal.begin(
      subject.paths,
      subject.profileId,
      subject.sessionId,
    );
    expect(retried._tag).toBe("ok");
  });

  it("recoverSession clears a schema-invalid journal (unsupported schemaVersion) the same way", async () => {
    const subject = await fixture();
    await mkdir(subject.sessionDirectory, { recursive: true });
    await writeFile(
      subject.journalFile,
      JSON.stringify({
        schemaVersion: 2,
        profileId: subject.profileId,
        sessionId: subject.sessionId,
        state: "preparing",
        stagingRoot: join(subject.sessionDirectory, ".staging"),
        targets: [],
      }),
      "utf8",
    );

    const recovered = await ReviewPreparationJournal.recoverSession(
      subject.paths,
      worktrees(subject.paths),
      subject.profileId,
      subject.sessionId,
      "profile-lock-held",
    );

    expect(recovered).toBe(true);
    await expect(access(subject.journalFile)).rejects.toThrow();

    const retried = await ReviewPreparationJournal.begin(
      subject.paths,
      subject.profileId,
      subject.sessionId,
    );
    expect(retried._tag).toBe("ok");
  });

  it("startup recover() clears a corrupt journal instead of failing on it", async () => {
    const subject = await fixture();
    await mkdir(subject.sessionDirectory, { recursive: true });
    await writeFile(subject.journalFile, "{ truncated", "utf8");

    await expect(
      ReviewPreparationJournal.recover(subject.paths, worktrees(subject.paths)),
    ).resolves.toEqual({ recovered: 1, failed: 0 });

    await expect(access(subject.journalFile)).rejects.toThrow();
  });

  it("recover() takes the profile lock before deleting an unreadable journal, when given a gate", async () => {
    const subject = await fixture();
    await mkdir(subject.sessionDirectory, { recursive: true });
    await writeFile(subject.journalFile, "{ truncated", "utf8");
    const gate = new InstrumentedGate();

    await expect(
      ReviewPreparationJournal.recover(
        subject.paths,
        worktrees(subject.paths),
        undefined,
        gate,
      ),
    ).resolves.toEqual({ recovered: 1, failed: 0 });

    // The delete only ran if the lock was actually taken for this profile —
    // this is the same instrumented-gate technique the evaluator used to
    // prove ATK-9's absence of any lock call; here it must show exactly one.
    expect(gate.calls).toEqual([subject.profileId]);
    await expect(access(subject.journalFile)).rejects.toThrow();
  });

  it("recoverSession does not take a profile lock, and still completes when called from inside one already held", async () => {
    const subject = await fixture();
    await mkdir(subject.sessionDirectory, { recursive: true });
    await writeFile(subject.journalFile, "{ truncated", "utf8");
    const gate = new InstrumentedGate();

    // Mirrors `ReviewSessionPreparation.prepareCurrent`'s real call shape:
    // `recoverSession` is invoked from inside a profile lock the caller
    // already holds. If `recoverSession` ever started taking its own lock,
    // this would hang forever on the non-reentrant gate; the timeout race
    // makes that failure fast and unambiguous instead of hanging the suite.
    const deadlineMs = 2000;
    const withTimeout = Promise.race([
      gate.withProfileLock(subject.profileId, () =>
        ReviewPreparationJournal.recoverSession(
          subject.paths,
          worktrees(subject.paths),
          subject.profileId,
          subject.sessionId,
          "profile-lock-held",
        ),
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `recoverSession did not complete within ${deadlineMs}ms — ` +
                  "likely deadlocked on the non-reentrant profile lock",
              ),
            ),
          deadlineMs,
        ),
      ),
    ]);

    await expect(withTimeout).resolves.toBe(true);
    await expect(access(subject.journalFile)).rejects.toThrow();
    // Exactly the one call this test itself made — recoverSession's internal
    // path to recoverJournalFile always passes `lifecycleGate: undefined`,
    // so it never adds a second entry here.
    expect(gate.calls).toEqual([subject.profileId]);
  });
});
