import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
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
import { err, ok } from "../../src/domain/result";
import type { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
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

function worktrees(
  paths: PatchdeskPaths,
  // Every `git worktree remove` target this service is asked for, in order.
  // A test that must prove recovery left a worktree alone reads this rather
  // than only checking the directory still exists.
  removals: Array<string> = [],
): ReviewWorktreeService {
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
          if (target !== undefined) {
            removals.push(target);
            await rm(target, { recursive: true, force: true }).catch(
              () => undefined,
            );
          }
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
    readonly targets: ReadonlyArray<string>;
    readonly state?: "preparing" | "committing";
    readonly worktree?: {
      readonly path: string;
      readonly repositoryPath: string;
    };
    // Only ever set by the "pre-existing on-disk journal" upgrade-path test
    // below: `stagingRoot` was removed from `JournalContent` and its schema
    // in M5, but a real journal written before that fix can still have this
    // key on disk, and `journalContentSchema`'s `v.looseObject` must keep
    // tolerating it rather than failing the whole journal closed.
    readonly stagingRoot?: string;
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

type SessionLoader = Pick<ReviewSessionStore, "load">;

/**
 * A Session store that fails the test if recovery ever consults it. Only a
 * `committing` journal asks the store whether its Session landed, so every
 * other journal state must reach its outcome without a single `load` call.
 * Passing this rather than a benign stub keeps `sessions` an assertion about
 * what recovery reads, not just an argument the compiler now demands.
 */
function unconsultedSessions(): SessionLoader {
  return {
    load: () => {
      throw new Error(
        "sessions.load must not be consulted for this journal state",
      );
    },
  };
}

/**
 * A Session store that has no Session saved for the id recovery asks about —
 * exactly what a crash between `markCommitting()` and `sessions.save()`
 * leaves behind. This is the honest way to express "the save never landed":
 * a store that answers, not an absent store.
 */
function noSavedSession(): SessionLoader {
  return {
    load: async () =>
      err({
        _tag: "StorageFailure" as const,
        operation: "read" as const,
        reason: "not_found" as const,
      }),
  };
}

/**
 * A Session as the store would hand it back. `prNumberOverride` builds one
 * whose identity-derived id is deliberately *not* the id recovery asked
 * about, which is the store answering "that is not the Session you meant".
 */
function persistedSession(
  subject: Awaited<ReturnType<typeof fixture>>,
  prNumberOverride?: number,
) {
  const host = must(parseGitHubHost("github.com"));
  const owner = must(parseGitHubOwner("centraldigital"));
  const repo = must(parseGitHubRepoName("patchdesk"));
  const prNumber = must(parsePullRequestNumber(prNumberOverride ?? 42));
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
      targets: [sentinel],
    });

    await expect(
      ReviewPreparationJournal.recover(
        subject.paths,
        worktrees(subject.paths),
        unconsultedSessions(),
      ),
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
      ReviewPreparationJournal.recover(
        subject.paths,
        worktrees(subject.paths),
        unconsultedSessions(),
      ),
    ).resolves.toEqual({ recovered: 0, failed: 1 });

    await expectPresent(sentinel);
    await expectPresent(subject.journalFile);
  });

  it("reads and recovers a pre-existing on-disk journal that still has the removed stagingRoot field", async () => {
    // M5 removed `stagingRoot` from `JournalContent` and its schema, but a
    // real journal written before that fix can still have this key on disk
    // after an upgrade. `journalContentSchema` uses `v.looseObject`, which
    // tolerates the unrecognized key instead of failing the whole journal
    // closed, so this journal must still read and recover exactly like one
    // written in the current shape (no `schemaVersion` bump was needed).
    const subject = await fixture();
    await writePersistedJournal(subject.journalFile, {
      profileId: subject.profileId,
      sessionId: subject.sessionId,
      targets: [],
      // Legacy field: a real pre-upgrade journal would have this. The new
      // code never reads it and must not choke on its presence.
      stagingRoot: join(subject.sessionDirectory, ".staging"),
    });

    await expect(
      ReviewPreparationJournal.recover(
        subject.paths,
        worktrees(subject.paths),
        unconsultedSessions(),
      ),
    ).resolves.toEqual({ recovered: 1, failed: 0 });

    await expect(access(subject.journalFile)).rejects.toThrow();
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
    const target = subject.paths.preparedContextFile(
      subject.profileId,
      subject.sessionId,
    );
    // A `.staging` directory is never written by this file (confirmed by
    // `git log -S`), and nothing derives or sweeps it anymore since M5
    // removed `stagingRoot`. Creating one by hand here, alongside the
    // recorded `target`, proves recovery leaves it alone rather than
    // silently continuing to clean it up.
    const untrackedStagingLeftover = join(
      subject.sessionDirectory,
      ".staging",
      "artifact.tmp",
    );
    await mkdir(join(untrackedStagingLeftover, ".."), { recursive: true });
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(untrackedStagingLeftover, "staged", "utf8");
    await writeFile(target, "target", "utf8");
    expect((await journal.record(target))._tag).toBe("ok");
    expect(
      JSON.parse(await readFile(subject.journalFile, "utf8")),
    ).toMatchObject({ targets: [target] });
    expect(
      JSON.parse(await readFile(subject.journalFile, "utf8")),
    ).not.toHaveProperty("stagingRoot");

    await expect(
      ReviewPreparationJournal.recover(
        subject.paths,
        worktrees(subject.paths),
        unconsultedSessions(),
      ),
    ).resolves.toEqual({ recovered: 1, failed: 0 });

    await expect(access(target)).rejects.toThrow();
    await expect(access(subject.journalFile)).rejects.toThrow();
    // Not tracked as a deletion target, so recovery leaves it in place.
    await expectPresent(untrackedStagingLeftover);
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

  it("keeps the patch file and the worktree of a committing journal whose session loads and matches", async () => {
    // The pin for this fix. Every artifact the `no saved session` test below
    // watches recovery destroy must survive here, where the only difference
    // is that the store answers with the matching Session. Recovery used to
    // reach the destroying branch whenever `sessions` was simply left out,
    // so "a store was consulted and it said yes" is the whole distinction
    // this test holds in place.
    const subject = await fixture();
    const patch = subject.paths.patchFile(subject.profileId, subject.sessionId);
    const context = subject.paths.preparedContextFile(
      subject.profileId,
      subject.sessionId,
    );
    await mkdir(join(patch, ".."), { recursive: true });
    await mkdir(join(context, ".."), { recursive: true });
    await writeFile(patch, "patch", "utf8");
    await writeFile(context, "context", "utf8");

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
      targets: [patch, context],
      state: "committing",
      worktree: { path: worktreePath, repositoryPath },
    });
    const persisted = persistedSession(subject);
    const removals: Array<string> = [];

    await expect(
      ReviewPreparationJournal.recover(
        subject.paths,
        worktrees(subject.paths, removals),
        { load: async () => ok(persisted) },
      ),
    ).resolves.toEqual({ recovered: 1, failed: 0 });

    await expectPresent(patch);
    await expectPresent(context);
    await expectPresent(worktreePath);
    // Not merely "the directory is still there": `git worktree remove` was
    // never run for it either.
    expect(removals).toEqual([]);
    await expect(access(subject.journalFile)).rejects.toThrow();
  });

  it("cleans up a committing journal when the store returns a session whose id does not match", async () => {
    const subject = await fixture();
    const target = subject.paths.patchFile(
      subject.profileId,
      subject.sessionId,
    );
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "patch", "utf8");
    await writePersistedJournal(subject.journalFile, {
      profileId: subject.profileId,
      sessionId: subject.sessionId,
      targets: [target],
      state: "committing",
    });
    // A Session that loads, but is a different Session — a stale or
    // misfiled read. The real store already re-checks the id it was asked
    // for, so this is the guard that keeps recovery from trusting a store
    // that does not. It is a legitimate cleanup path: no Session for *this*
    // id landed, so this journal's artifacts are still orphans.
    const other = persistedSession(subject, 43);
    expect(other.id).not.toBe(subject.sessionId);

    await expect(
      ReviewPreparationJournal.recover(
        subject.paths,
        worktrees(subject.paths),
        { load: async () => ok(other) },
      ),
    ).resolves.toEqual({ recovered: 1, failed: 0 });

    await expect(access(target)).rejects.toThrow();
    await expect(access(subject.journalFile)).rejects.toThrow();
  });

  it("cleans up a committing journal's target and worktree when the store reports no saved session", async () => {
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
      targets: [target],
      state: "committing",
      worktree: { path: worktreePath, repositoryPath },
    });
    await expectPresent(target);
    await expectPresent(worktreePath);

    // A crash between `journal.markCommitting()` and `sessions.save()` leaves
    // exactly this — a `committing` journal with no persisted Session behind
    // it — and recovery must clean it up exactly like a `preparing` journal
    // would, not just delete the journal file and strand the target and
    // worktree. The store is what reports the absence: this test used to omit
    // `sessions` entirely and so proved only that a *missing store* deleted
    // the artifacts, which was the inverted default, not this behavior.
    await expect(
      ReviewPreparationJournal.recover(
        subject.paths,
        worktrees(subject.paths),
        noSavedSession(),
      ),
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
      unconsultedSessions(),
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
      unconsultedSessions(),
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
      ReviewPreparationJournal.recover(
        subject.paths,
        worktrees(subject.paths),
        unconsultedSessions(),
      ),
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
        unconsultedSessions(),
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
          unconsultedSessions(),
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
