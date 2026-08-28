import {
  access,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import * as v from "valibot";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { readJsonFile, writeAtomicJson } from "../adapters/storage/json-file";
import { isPathContained } from "../adapters/storage/path-containment";
import {
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import { mapConcurrent } from "../domain/map-concurrent";
import { err, ok, type Result } from "../domain/result";
import type { ReviewWorktreeService } from "./review-worktree-service";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewLifecycleGate } from "./review-lifecycle-gate";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";

/**
 * `reason` is optional rather than a required discriminant: every
 * pre-existing construction site reports a generic storage failure and the
 * caller already treats those uniformly (`SessionStorageUnavailable`), so
 * forcing them to each name a reason would be a bigger diff for no behavior
 * change. Only `begin()`'s new "a live journal is already there" case needs
 * to be distinguished, so it is the only site that sets `reason`.
 */
export type PreparationJournalFailure = {
  readonly _tag: "PreparationJournalFailed";
  readonly reason?: "journal_exists";
};
export type PreparationCleanupFailure = {
  readonly _tag: "PreparationCleanupFailed";
};

export type ReviewPreparationOperation = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly phase: "preparing" | "committing";
};

type JournalWorktree = {
  readonly path: string;
  readonly repositoryPath: string;
};

type ValidatedDeletionSet = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly journalFile: string;
  readonly targets: ReadonlyArray<string>;
  readonly worktree?: JournalWorktree;
};

/** Mutable draft of `ValidatedDeletionSet`, built in statements so the
 * optional `worktree` field is added only when present. */
type MutableValidatedDeletionSet = {
  -readonly [K in keyof ValidatedDeletionSet]: ValidatedDeletionSet[K];
};

/**
 * Durable record of one in-flight Session preparation. It stays in the main
 * process: it is never projected to the renderer and never logged. The
 * repository path is recorded only so crash recovery can run the safety-checked
 * `git worktree remove` for an interrupted preparation.
 */
type JournalContent = {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly sessionId: string;
  readonly state: "preparing" | "committing";
  readonly targets: ReadonlyArray<string>;
  readonly worktree?: JournalWorktree;
};

/**
 * `preparation.journal.json` is a durable record Patchdesk fully owns on
 * both the write and read side, so per ADR 0022 structural drift fails the
 * whole read closed. `v.looseObject` (rather than `v.strictObject`) matches
 * this file's existing tolerance for unrecognized fields on real journals
 * already on disk: an unknown field never invalidated the journal before
 * this schema existed, and it still doesn't now, though only the fields
 * named below ever survive into a parsed `JournalContent`.
 *
 * This tolerance is also what lets a pre-existing on-disk journal written
 * before `stagingRoot` was removed (M5) keep parsing today: `looseObject`
 * ignores the now-unlisted `stagingRoot` key rather than rejecting it, and
 * `toJournalContent` below never copies it into the narrower
 * `JournalContent` shape, so the stale key is dropped the next time this
 * journal is rewritten. No `schemaVersion` bump was needed for this removal.
 */
const journalWorktreeSchema = v.looseObject({
  path: v.string(),
  repositoryPath: v.string(),
});

const journalContentSchema = v.looseObject({
  schemaVersion: v.literal(1),
  profileId: v.string(),
  sessionId: v.string(),
  state: v.picklist(["preparing", "committing"]),
  targets: v.array(v.string()),
  worktree: v.optional(journalWorktreeSchema),
});

/** Mutable draft of `JournalContent`, built in statements so the optional
 * `worktree` field is added only when present. */
type MutableJournalContent = {
  -readonly [K in keyof JournalContent]: JournalContent[K];
};

function toJournalWorktree(
  worktree: v.InferOutput<typeof journalWorktreeSchema> | undefined,
): JournalWorktree | undefined {
  return worktree === undefined
    ? undefined
    : { path: worktree.path, repositoryPath: worktree.repositoryPath };
}

/** Project a schema-validated journal payload onto the narrower `JournalContent` shape. */
function toJournalContent(
  parsed: v.InferOutput<typeof journalContentSchema>,
): JournalContent {
  const worktree = toJournalWorktree(parsed.worktree);
  const content: MutableJournalContent = {
    schemaVersion: 1,
    profileId: parsed.profileId,
    sessionId: parsed.sessionId,
    state: parsed.state,
    targets: parsed.targets,
  };
  if (worktree !== undefined) content.worktree = worktree;
  return content;
}

/**
 * Tracks artifact paths created while preparing an immutable Session so a
 * failure, head change, or crash can remove every one of them. A retained
 * journal is an internal active-operation signal; it never becomes renderer
 * state or a reason to relaunch preparation.
 */
export class ReviewPreparationJournal {
  private constructor(
    private readonly paths: PatchdeskPaths,
    private readonly filePath: string,
    private content: JournalContent,
  ) {}

  /**
   * Create the journal before any artifact write for this Session. Reads
   * the journal file first: a crash between `markCommitting()` and
   * `sessions.save()` leaves a `committing` journal on disk with no journal
   * object in memory to detect it, so `begin()` must check the file itself
   * rather than overwrite whatever is there. Any file already present —
   * parsed or not — reports `journal_exists` rather than being silently
   * replaced; the caller recovers that session and retries once.
   */
  static async begin(
    paths: PatchdeskPaths,
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<Result<ReviewPreparationJournal, PreparationJournalFailure>> {
    const filePath = journalFile(paths, profileId, sessionId);
    const existing = await readJsonFile(filePath);
    if (existing._tag === "ok" || existing.error.reason !== "not_found")
      return err({
        _tag: "PreparationJournalFailed",
        reason: "journal_exists",
      });
    const journal = new ReviewPreparationJournal(paths, filePath, {
      schemaVersion: 1,
      profileId,
      sessionId,
      state: "preparing",
      targets: [],
    });
    const written = await journal.write();
    return written._tag === "ok" ? ok(journal) : written;
  }

  get profileId(): WorkspaceProfileId {
    // SAFETY: `this.content.profileId` is set once, here in `begin()`, directly
    // from its typed `profileId: WorkspaceProfileId` parameter, and never
    // reassigned afterward. `recover()` builds journals from unvalidated file
    // content with plain-string ids, but those instances stay private to
    // `recoverOne` and never reach a caller of this getter.
    return this.content.profileId as WorkspaceProfileId;
  }

  get sessionId(): ReviewSessionId {
    // SAFETY: mirrors `profileId` above — set once in `begin()` from a typed
    // `sessionId: ReviewSessionId` parameter and never reassigned.
    return this.content.sessionId as ReviewSessionId;
  }

  /** Read the active operation for one session without exposing journal paths. */
  static async activeFor(
    paths: PatchdeskPaths,
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    diagnostics?: Pick<ReviewDiagnosticService, "record">,
  ): Promise<
    Result<ReviewPreparationOperation | undefined, PreparationJournalFailure>
  > {
    const stored = await readJsonFile(journalFile(paths, profileId, sessionId));
    if (stored._tag === "err") {
      if (stored.error.reason !== "not_found") {
        await recordJournalDiagnostic(
          diagnostics,
          profileId,
          sessionId,
          "journal-read",
        );
      }
      return stored.error.reason === "not_found"
        ? ok(undefined)
        : err({ _tag: "PreparationJournalFailed" });
    }
    const parsed = v.safeParse(journalContentSchema, stored.value);
    const content = parsed.success
      ? toJournalContent(parsed.output)
      : undefined;
    if (content === undefined) {
      await recordJournalDiagnostic(
        diagnostics,
        profileId,
        sessionId,
        "journal-parse",
      );
      return err({ _tag: "PreparationJournalFailed" });
    }
    const parsedProfile = parseWorkspaceProfileId(content.profileId);
    const parsedSession = parseReviewSessionId(content.sessionId);
    if (parsedProfile._tag === "err" || parsedSession._tag === "err") {
      return err({ _tag: "PreparationJournalFailed" });
    }
    if (
      parsedProfile.value !== profileId ||
      parsedSession.value !== sessionId
    ) {
      return err({ _tag: "PreparationJournalFailed" });
    }
    return ok({
      profileId: parsedProfile.value,
      sessionId: parsedSession.value,
      phase: content.state,
    });
  }

  /** Append a created final artifact path before the next preparation effect. */
  async record(
    target: string,
  ): Promise<Result<void, PreparationJournalFailure>> {
    this.content = {
      ...this.content,
      targets: [...this.content.targets, target],
    };
    return this.write();
  }

  /** Record the managed worktree so cleanup can remove it through git safety checks. */
  async recordWorktree(
    worktree: JournalWorktree,
  ): Promise<Result<void, PreparationJournalFailure>> {
    this.content = { ...this.content, worktree };
    return this.write();
  }

  /**
   * Remove a pre-recorded worktree when preparation never created one on
   * disk (a metadata-only outcome, or an authentication/storage failure
   * reached before `git worktree add` ran).
   *
   * A merely absent worktree path does not need this: `validatedDeletionSet`
   * checks it with `isSafeOwnedPath` without `requirePath`, and resolves
   * through the nearest existing parent, so a missing directory still
   * validates. What this protects is the narrower case where the cache root
   * itself is gone or unreadable — the same storage fault that makes
   * `mkdir` fail. There `realpath` on the root fails, validation returns
   * undefined, and `complete`/`cleanup` would strand this journal forever
   * and report `PreparationCleanupUnavailable` in place of the real failure.
   *
   * The caller must confirm the worktree really is absent from disk first —
   * this never removes the record of a worktree that was actually created,
   * because that record is the only way to find it again.
   */
  async clearWorktree(): Promise<Result<void, PreparationJournalFailure>> {
    const { worktree: _worktree, ...contentWithoutWorktree } = this.content;
    this.content = contentWithoutWorktree;
    return this.write();
  }

  /**
   * Mark that every final artifact exists and the Session save may begin. A
   * committing journal tells recovery the persisted Session keeps its artifacts.
   */
  async markCommitting(): Promise<Result<void, PreparationJournalFailure>> {
    this.content = { ...this.content, state: "committing" };
    return this.write();
  }

  /** Best-effort journal removal after the Session is durably saved. */
  async complete(): Promise<void> {
    const deletion = await this.validatedDeletionSet();
    if (deletion === undefined) return;
    await rm(deletion.journalFile, { force: true }).catch(() => undefined);
  }

  /**
   * Remove every recorded staging and final artifact in reverse dependency
   * order. The journal is retained when any deletion fails so startup recovery
   * can retry; a retained journal is never a renderable Session.
   */
  async cleanup(
    worktrees: ReviewWorktreeService,
  ): Promise<Result<void, PreparationCleanupFailure>> {
    const deletion = await this.validatedDeletionSet();
    if (deletion === undefined)
      return err({ _tag: "PreparationCleanupFailed" });
    let failed = false;
    for (const target of [...deletion.targets].reverse()) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- reverse dependency order is the point of this sweep; a parallel one could remove a container before the artifact inside it and lose the per-target failure signal that keeps this journal for retry
      await rm(target, { recursive: true, force: true }).catch(() => {
        failed = true;
      });
    }
    if (
      deletion.worktree !== undefined &&
      (await exists(deletion.worktree.path))
    ) {
      const removed = await worktrees.cleanup({
        profileId: deletion.profileId,
        sessionId: deletion.sessionId,
        localPath: deletion.worktree.repositoryPath,
        targetPath: deletion.worktree.path,
      });
      if (removed._tag === "err") failed = true;
    }
    if (failed) return err({ _tag: "PreparationCleanupFailed" });
    await rm(deletion.journalFile, { force: true }).catch(() => undefined);
    await rmdir(dirname(deletion.journalFile)).catch(() => undefined);
    return ok(undefined);
  }

  /**
   * Delete artifacts recorded by interrupted preparations. A `preparing`
   * journal loses every recorded target; a `committing` journal already owns a
   * persisted Session, so only the journal itself is removed.
   *
   * `sessions` is required, not optional. A `committing` journal is only safe
   * to clean up once a store has said no matching Session is on disk, so an
   * absent store must not be expressible here: omitting it once meant "delete
   * the patch file, the worktree, and the journal" for every `committing`
   * journal on the machine, which is the most destructive outcome this class
   * has rather than the fail-safe one.
   */
  static async recover(
    paths: PatchdeskPaths,
    worktrees: ReviewWorktreeService,
    sessions: Pick<ReviewSessionStore, "load">,
    lifecycleGate?: ReviewLifecycleGate,
    diagnostics?: Pick<ReviewDiagnosticService, "record">,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const journals = await findJournals(paths);
    const groups = groupJournalPaths(journals);
    const recovered = await mapConcurrent(groups, 4, async (group) => {
      const results = await mapConcurrent(
        group,
        lifecycleGate === undefined ? 1 : 4,
        (filePath) =>
          ReviewPreparationJournal.recoverJournalFile(
            paths,
            worktrees,
            filePath,
            sessions,
            lifecycleGate,
            diagnostics,
          ),
      );
      return results.reduce(
        (total, result) => ({
          recovered: total.recovered + result.recovered,
          failed: total.failed + result.failed,
        }),
        { recovered: 0, failed: 0 },
      );
    });
    return recovered.reduce(
      (total, result) => ({
        recovered: total.recovered + result.recovered,
        failed: total.failed + result.failed,
      }),
      { recovered: 0, failed: 0 },
    );
  }

  /**
   * Recover exactly one session's journal, without the directory-wide scan
   * `recover()` does. Used by `ReviewSessionPreparation.begin()` retry: that
   * caller already holds this profile's `withProfileLock` (when a
   * `lifecycleGate` is configured), so it must never route back through
   * `recover()`'s own `withProfileLock` call for the same profile — that
   * would await a lock it is already holding and deadlock forever. Because
   * the caller's lock already excludes every other operation on this
   * profile, this method takes no lock of its own.
   *
   * `profileLockHeld` is a required, explicit acknowledgment of that
   * precondition rather than only a doc comment: this method runs
   * `cleanup`/`validatedDeletionSet` (`rm` of the patch file, prepared-
   * context file, staging root, and `git worktree remove`) with no locking
   * of its own, so calling it without the profile lock actually held races
   * a concurrent `recover()` sweep or another `prepare()` call for the same
   * profile. Passing the literal is not a runtime guarantee — it can be
   * forged with `as`, exactly like every branded `parse*Id` cast elsewhere
   * in this codebase (see `domain/ids.ts`) — but it forces a new call site
   * to name the precondition instead of silently missing it, and it makes
   * every call site claiming the precondition findable with one grep.
   *
   * `sessions` is required here for the same reason it is on `recover`: the
   * journal this clears can be `committing`, and without a store to ask, that
   * state cleans up the Session's artifacts instead of leaving them alone.
   */
  static async recoverSession(
    paths: PatchdeskPaths,
    worktrees: ReviewWorktreeService,
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    _profileLockHeld: "profile-lock-held",
    sessions: Pick<ReviewSessionStore, "load">,
    diagnostics?: Pick<ReviewDiagnosticService, "record">,
  ): Promise<boolean> {
    const result = await ReviewPreparationJournal.recoverJournalFile(
      paths,
      worktrees,
      journalFile(paths, profileId, sessionId),
      sessions,
      undefined,
      diagnostics,
    );
    return result.recovered === 1;
  }

  /**
   * Recover the one journal at `filePath`. Shared by `recover()`'s
   * directory-wide scan and `recoverSession()`'s single-session lookup; the
   * `lifecycleGate` parameter is only ever non-`undefined` from `recover()` —
   * `recoverSession()` always passes `undefined` because its caller already
   * holds that profile's lock (see the note on `recoverSession`).
   *
   * A `committing` journal means the Session save it was guarding may or may
   * not have completed before the crash: when a matching Session is on disk,
   * that save won, and only the journal itself is removed (the Session keeps
   * its artifacts). Otherwise — the store reports the Session is genuinely
   * absent (`reason: "not_found"`), or the loaded Session's id doesn't match
   * — the save never landed, so this falls through to the same
   * `cleanup(worktrees)` a `preparing` journal gets, removing every artifact
   * it recorded.
   *
   * Those two are the only fall-through conditions, and both are the store
   * answering "no". A load that fails for any other reason (`"io"`,
   * `"invalid_json"`, `"invalid_stored_value"`, `"sensitive_value"`) is not an
   * answer — it means this process could not find out whether the Session
   * landed, which is exactly as consistent with "it did land and a disk
   * hiccup is in the way" as with "it never landed". Treating "I don't know"
   * as "no" would delete a healthy Session's patch file and worktree on a
   * transient read error. So only `reason === "not_found"` reaches cleanup;
   * every other reason returns early, leaves the journal and every artifact
   * untouched, and reports failure so the next sweep (the next app startup,
   * or `recoverSession`'s one retry inside `prepare()`) asks the store again
   * — never a hot loop, since nothing here retries synchronously.
   *
   * "There is no store" is deliberately not a fall-through condition either:
   * `sessions` is non-optional all the way down from the two public entry
   * points, so the question is always asked of something and the destructive
   * branch can never be reached by a caller that simply forgot an argument.
   */
  private static async recoverJournalFile(
    paths: PatchdeskPaths,
    worktrees: ReviewWorktreeService,
    filePath: string,
    sessions: Pick<ReviewSessionStore, "load">,
    lifecycleGate: ReviewLifecycleGate | undefined,
    diagnostics: Pick<ReviewDiagnosticService, "record"> | undefined,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const stored = await readJsonFile(filePath);
    // `readJsonFile` returning "not_found" means there is no file at all —
    // nothing for the fallback below to derive-and-delete, so that case
    // keeps reporting a plain failure exactly as before this fix.
    const filePresent =
      stored._tag === "ok" || stored.error.reason !== "not_found";
    const parsed =
      stored._tag === "ok"
        ? v.safeParse(journalContentSchema, stored.value)
        : undefined;
    const content = parsed?.success
      ? toJournalContent(parsed.output)
      : undefined;
    if (content === undefined) {
      if (filePresent) {
        // Derive the profile id from the path itself — the file's own
        // content is exactly what could not be parsed — so this delete can
        // be serialized under the same profile lock the healthy-journal
        // branch below uses, rather than running unlocked ahead of it.
        const ids = deriveJournalIds(filePath);
        const recoverUnreadable = (): Promise<boolean> =>
          ReviewPreparationJournal.recoverUnreadableJournal(paths, filePath);
        const recovered =
          ids !== undefined && lifecycleGate !== undefined
            ? await lifecycleGate.withProfileLock(
                ids.profileId,
                recoverUnreadable,
              )
            : await recoverUnreadable();
        if (recovered) return { recovered: 1, failed: 0 };
      }
      await recordRecoveredJournalDiagnostic(
        diagnostics,
        filePath,
        stored._tag === "err" ? "journal-read" : "journal-parse",
      );
      return { recovered: 0, failed: 1 };
    }
    const journal = new ReviewPreparationJournal(paths, filePath, content);
    const process = async (): Promise<boolean> => {
      const deletion = await journal.validatedDeletionSet();
      if (deletion === undefined) return false;
      if (content.state === "committing") {
        const session = await sessions.load(
          deletion.profileId,
          deletion.sessionId,
        );
        if (session._tag === "ok" && session.value.id === deletion.sessionId) {
          return await rm(deletion.journalFile, { force: true })
            .then(() => true)
            .catch(() => false);
        }
        // The store could not answer at all — "not_found" is the only
        // reason that means "genuinely absent"; every other reason (`"io"`,
        // `"invalid_json"`, `"invalid_stored_value"`, `"sensitive_value"`)
        // means this read could not tell a missing Session from a healthy
        // one it merely failed to reach. Fail safe: leave the journal and
        // every recorded artifact exactly as they are and report failure so
        // the next sweep asks again, instead of treating "I don't know" as
        // "it's gone" and deleting a Session's patch file and worktree on a
        // disk hiccup.
        if (session._tag === "err" && session.error.reason !== "not_found")
          return false;
      }
      const cleaned = await journal.cleanup(worktrees);
      return cleaned._tag === "ok";
    };
    const profileId = parseWorkspaceProfileId(content.profileId);
    const success =
      lifecycleGate !== undefined && profileId._tag === "ok"
        ? await lifecycleGate.withProfileLock(profileId.value, process)
        : await process();
    if (!success) {
      const parsedSessionId = parseReviewSessionId(content.sessionId);
      if (
        diagnostics !== undefined &&
        profileId._tag === "ok" &&
        parsedSessionId._tag === "ok"
      ) {
        await diagnostics.record({
          profileId: profileId.value,
          sessionId: parsedSessionId.value,
          category: "preparation",
          phase: "journal-recovery",
          retryable: true,
          detail: "Preparation journal recovery failed.",
        });
      }
    }
    return success ? { recovered: 1, failed: 0 } : { recovered: 0, failed: 1 };
  }

  /**
   * Delete a journal this process could not read or parse — a corrupt file,
   * an `io` read failure, or a credential-shaped payload `readJsonFile`
   * refuses to hand back — so a later `begin()` retry (or a later
   * `recover()` sweep) is not permanently blocked by a file this process
   * can never make sense of.
   *
   * This no longer also sweeps a `.staging` directory (M5 removed that).
   * Code did once write there: commits `d7436e5` and `3da5372` passed
   * `stagingDirectory: journal.stagingRoot` into
   * `ReviewComparisonService.persist`, which wrote four artifacts under it
   * (`review-comparison-service.ts:121`). That writer was removed in
   * `e982d0d`, before this sweep was ever added, and this repo has no
   * release tags — so no shipped build ever wrote there, and no user's
   * disk can hold anything under `.staging` today.
   *
   * The deleted path is reconstructed from ids parsed out of `filePath`'s
   * own directory structure — the same derivation
   * `recordRecoveredJournalDiagnostic` uses — never from the unreadable
   * file's contents. If the derived ids don't reconstruct back to exactly
   * `filePath`, or it fails the containment check, nothing is deleted: an
   * orphaned unreadable journal is a smaller problem than a wrong delete.
   *
   * Trade-off: deleting a journal this process cannot parse means
   * discarding the record of which staged and final artifacts that
   * preparation attempt had already written. Those already on disk are left
   * in place, orphaned rather than tracked for cleanup. That is weighed
   * against the alternative this fix replaces: a pull request that opens
   * fine on `main` becoming permanently unopenable until a human deletes
   * `preparation.journal.json` by hand.
   */
  private static async recoverUnreadableJournal(
    paths: PatchdeskPaths,
    filePath: string,
  ): Promise<boolean> {
    const ids = deriveJournalIds(filePath);
    if (ids === undefined) return false;
    if (journalFile(paths, ids.profileId, ids.sessionId) !== filePath)
      return false;
    const sessionDirectory = paths.sessionDirectory(
      ids.profileId,
      ids.sessionId,
    );
    if (
      !(await isSafeOwnedPath(paths.dataDirectory(), sessionDirectory, true)) ||
      !(await isSafeOwnedPath(sessionDirectory, filePath, true))
    )
      return false;
    try {
      await rm(filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private async write(): Promise<Result<void, PreparationJournalFailure>> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
    } catch {
      return err({ _tag: "PreparationJournalFailed" });
    }
    const written = await writeAtomicJson(this.filePath, this.content);
    return written._tag === "ok"
      ? ok(undefined)
      : err({ _tag: "PreparationJournalFailed" });
  }

  /** Verify every persisted deletion target before the first filesystem removal. */
  private async validatedDeletionSet(): Promise<
    ValidatedDeletionSet | undefined
  > {
    const profileId = parseWorkspaceProfileId(this.content.profileId);
    const sessionId = parseReviewSessionId(this.content.sessionId);
    if (profileId._tag === "err" || sessionId._tag === "err") return undefined;

    const sessionDirectory = this.paths.sessionDirectory(
      profileId.value,
      sessionId.value,
    );
    const expectedJournalFile = journalFile(
      this.paths,
      profileId.value,
      sessionId.value,
    );
    if (this.filePath !== expectedJournalFile) return undefined;

    if (
      !(await isSafeOwnedPath(
        this.paths.dataDirectory(),
        sessionDirectory,
        true,
      ))
    )
      return undefined;
    if (!(await isSafeOwnedPath(sessionDirectory, expectedJournalFile, true)))
      return undefined;

    const allowedTargets = new Set([
      this.paths.patchFile(profileId.value, sessionId.value),
      this.paths.preparedContextFile(profileId.value, sessionId.value),
      this.paths.preparedReviewInputFile(profileId.value, sessionId.value),
      this.paths.preparedDebugFile(profileId.value, sessionId.value),
    ]);
    for (const target of this.content.targets) {
      if (
        !allowedTargets.has(target) ||
        !(await isSafeOwnedPath(sessionDirectory, target))
      )
        return undefined;
    }

    if (
      this.content.worktree !== undefined &&
      (this.content.worktree.path !==
        this.paths.worktreeDirectory(profileId.value, sessionId.value) ||
        !(await isSafeOwnedPath(
          this.paths.cacheDirectory(),
          this.content.worktree.path,
        )))
    ) {
      return undefined;
    }
    const deletion: MutableValidatedDeletionSet = {
      profileId: profileId.value,
      sessionId: sessionId.value,
      journalFile: expectedJournalFile,
      targets: this.content.targets,
    };
    if (this.content.worktree !== undefined)
      deletion.worktree = this.content.worktree;
    return deletion;
  }
}

function journalFile(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  sessionId: ReviewSessionId,
): string {
  return join(
    paths.sessionDirectory(profileId, sessionId),
    "preparation.journal.json",
  );
}

async function recordJournalDiagnostic(
  diagnostics: Pick<ReviewDiagnosticService, "record"> | undefined,
  profileId: WorkspaceProfileId,
  sessionId: ReviewSessionId,
  phase: "journal-read" | "journal-parse",
): Promise<void> {
  if (diagnostics === undefined) return;
  await diagnostics.record({
    profileId,
    sessionId,
    category: "preparation",
    phase,
    retryable: true,
    detail: "Preparation journal evidence could not be read safely.",
  });
}

async function recordRecoveredJournalDiagnostic(
  diagnostics: Pick<ReviewDiagnosticService, "record"> | undefined,
  filePath: string,
  phase: "journal-read" | "journal-parse",
): Promise<void> {
  if (diagnostics === undefined) return;
  const ids = deriveJournalIds(filePath);
  if (ids === undefined) return;
  await diagnostics.record({
    profileId: ids.profileId,
    sessionId: ids.sessionId,
    category: "preparation",
    phase,
    retryable: true,
    detail: "Preparation journal evidence could not be recovered safely.",
  });
}

/**
 * Recover the profile/session id pair a journal path was written under, from
 * the path's own directory structure alone (`.../profiles/<profileId>/
 * reviews/<sessionId>/preparation.journal.json`) — never from a corrupt or
 * unparseable file's contents. Shared by the diagnostic recorder above and
 * `recoverUnreadableJournal`, which additionally verifies the derived ids
 * reconstruct back to the exact same path before deleting anything.
 */
function deriveJournalIds(
  filePath: string,
): { profileId: WorkspaceProfileId; sessionId: ReviewSessionId } | undefined {
  const sessionId = parseReviewSessionId(basename(dirname(filePath)));
  const profileId = parseWorkspaceProfileId(
    basename(dirname(dirname(dirname(filePath)))),
  );
  if (sessionId._tag === "err" || profileId._tag === "err") return undefined;
  return { profileId: profileId.value, sessionId: sessionId.value };
}

async function findJournals(
  paths: PatchdeskPaths,
): Promise<ReadonlyArray<string>> {
  const profilesRoot = join(paths.dataDirectory(), "profiles");
  let profileEntries: ReadonlyArray<string>;
  try {
    profileEntries = await readdir(profilesRoot);
  } catch {
    return [];
  }
  const reviewDirectories = await mapConcurrent(
    profileEntries,
    4,
    async (profileEntry) => {
      const reviewsRoot = join(profilesRoot, profileEntry, "reviews");
      try {
        return { reviewsRoot, sessionEntries: await readdir(reviewsRoot) };
      } catch {
        return undefined;
      }
    },
  );
  const candidates = reviewDirectories.flatMap((directory) => {
    if (directory === undefined) return [];
    return directory.sessionEntries.map((sessionEntry) =>
      join(directory.reviewsRoot, sessionEntry, "preparation.journal.json"),
    );
  });
  const exists = await mapConcurrent(candidates, 8, async (candidate) => {
    try {
      await stat(candidate);
      return true;
    } catch {
      return false;
    }
  });
  return candidates.flatMap((candidate, index) =>
    exists[index] ? [candidate] : [],
  );
}

function groupJournalPaths(
  paths: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> {
  const groups = new Map<string, Array<string>>();
  for (const path of paths) {
    const key = dirname(dirname(path));
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [path]);
    else group.push(path);
  }
  return [...groups.values()];
}

/** Exported so `ReviewSessionPreparation` can check before deciding whether
 * `clearWorktree` is safe to call for a metadata-only outcome. */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isSafeOwnedPath(
  root: string,
  path: string,
  requirePath: boolean = false,
): Promise<boolean> {
  if (!isPathContained(root, path)) return false;
  const entry = await lstat(path).catch(() => undefined);
  if (entry?.isSymbolicLink() || (requirePath && entry === undefined))
    return false;
  const [canonicalRoot, canonicalParent] = await Promise.all([
    realpath(root).catch(() => undefined),
    realpathNearestExistingParent(dirname(path)),
  ]);
  return (
    canonicalRoot !== undefined &&
    canonicalParent !== undefined &&
    isPathContained(canonicalRoot, canonicalParent)
  );
}

async function realpathNearestExistingParent(
  path: string,
): Promise<string | undefined> {
  let candidate = path;
  while (true) {
    const canonical = await realpath(candidate).catch(() => undefined);
    if (canonical !== undefined) return canonical;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}
