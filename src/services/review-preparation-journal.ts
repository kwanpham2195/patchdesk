import { access, lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { readJsonFile, writeAtomicJson } from "../adapters/storage/json-file";
import {
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import type { ReviewWorktreeService } from "./review-worktree-service";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewLifecycleGate } from "./review-lifecycle-gate";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";

export type PreparationJournalFailure = { readonly _tag: "PreparationJournalFailed" };
export type PreparationCleanupFailure = { readonly _tag: "PreparationCleanupFailed" };

export type ReviewPreparationOperation = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly phase: "preparing" | "committing";
};

type JournalWorktree = { readonly path: string; readonly repositoryPath: string };

type ValidatedDeletionSet = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly journalFile: string;
  readonly stagingRoot: string;
  readonly targets: ReadonlyArray<string>;
  readonly worktree?: JournalWorktree;
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
  readonly stagingRoot: string;
  readonly targets: ReadonlyArray<string>;
  readonly worktree?: JournalWorktree;
};

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

  /** Create the journal before any artifact write for this Session. */
  static async begin(
    paths: PatchdeskPaths,
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<Result<ReviewPreparationJournal, PreparationJournalFailure>> {
    const sessionDirectory = paths.sessionDirectory(profileId, sessionId);
    const stagingRoot = join(sessionDirectory, ".staging");
    const journal = new ReviewPreparationJournal(paths, journalFile(paths, profileId, sessionId), {
      schemaVersion: 1,
      profileId,
      sessionId,
      state: "preparing",
      stagingRoot,
      targets: [],
    });
    const written = await journal.write();
    return written._tag === "ok" ? ok(journal) : written;
  }

  get stagingRoot(): string {
    return this.content.stagingRoot;
  }

  get profileId(): WorkspaceProfileId {
    return this.content.profileId as WorkspaceProfileId;
  }

  get sessionId(): ReviewSessionId {
    return this.content.sessionId as ReviewSessionId;
  }

  /** Read the active operation for one session without exposing journal paths. */
  static async activeFor(
    paths: PatchdeskPaths,
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    diagnostics?: Pick<ReviewDiagnosticService, "record">,
  ): Promise<Result<ReviewPreparationOperation | undefined, PreparationJournalFailure>> {
    const stored = await readJsonFile(journalFile(paths, profileId, sessionId));
    if (stored._tag === "err") {
      if (stored.error.reason !== "not_found") {
        await recordJournalDiagnostic(diagnostics, profileId, sessionId, "journal-read");
      }
      return stored.error.reason === "not_found"
        ? ok(undefined)
        : err({ _tag: "PreparationJournalFailed" });
    }
    const content = parseJournal(stored.value);
    if (content === undefined) {
      await recordJournalDiagnostic(diagnostics, profileId, sessionId, "journal-parse");
      return err({ _tag: "PreparationJournalFailed" });
    }
    const parsedProfile = parseWorkspaceProfileId(content.profileId);
    const parsedSession = parseReviewSessionId(content.sessionId);
    if (parsedProfile._tag === "err" || parsedSession._tag === "err") {
      return err({ _tag: "PreparationJournalFailed" });
    }
    if (parsedProfile.value !== profileId || parsedSession.value !== sessionId) {
      return err({ _tag: "PreparationJournalFailed" });
    }
    return ok({
      profileId: parsedProfile.value,
      sessionId: parsedSession.value,
      phase: content.state,
    });
  }

  /** Append a created final artifact path before the next preparation effect. */
  async record(target: string): Promise<Result<void, PreparationJournalFailure>> {
    this.content = { ...this.content, targets: [...this.content.targets, target] };
    return this.write();
  }

  /** Record the managed worktree so cleanup can remove it through git safety checks. */
  async recordWorktree(worktree: JournalWorktree): Promise<Result<void, PreparationJournalFailure>> {
    this.content = { ...this.content, worktree };
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
    await rm(deletion.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
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
    if (deletion === undefined) return err({ _tag: "PreparationCleanupFailed" });
    let failed = false;
    for (const target of [...deletion.targets].reverse()) {
      await rm(target, { recursive: true, force: true }).catch(() => {
        failed = true;
      });
    }
    await rm(deletion.stagingRoot, { recursive: true, force: true }).catch(() => {
      failed = true;
    });
    if (deletion.worktree !== undefined && await exists(deletion.worktree.path)) {
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
   */
  static async recover(
    paths: PatchdeskPaths,
    worktrees: ReviewWorktreeService,
    sessions?: Pick<ReviewSessionStore, "load">,
    lifecycleGate?: ReviewLifecycleGate,
    diagnostics?: Pick<ReviewDiagnosticService, "record">,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const journals = await findJournals(paths);
    let recovered = 0;
    let failed = 0;
    for (const filePath of journals) {
      const stored = await readJsonFile(filePath);
      if (stored._tag === "err") {
        failed += 1;
        await recordRecoveredJournalDiagnostic(diagnostics, filePath, "journal-read");
        continue;
      }
      const content = parseJournal(stored.value);
      if (content === undefined) {
        failed += 1;
        await recordRecoveredJournalDiagnostic(diagnostics, filePath, "journal-parse");
        continue;
      }
      const journal = new ReviewPreparationJournal(paths, filePath, content);
      const process = async (): Promise<boolean> => {
        const deletion = await journal.validatedDeletionSet();
        if (deletion === undefined) return false;
        if (content.state === "committing") {
          if (sessions === undefined) return false;
          const session = await sessions.load(deletion.profileId, deletion.sessionId);
          if (session._tag !== "ok" || session.value.id !== deletion.sessionId) return false;
          return await rm(deletion.journalFile, { force: true }).then(() => true).catch(() => false);
        }
        const cleaned = await journal.cleanup(worktrees);
        return cleaned._tag === "ok";
      };
      const profileId = parseWorkspaceProfileId(content.profileId);
      const success = lifecycleGate !== undefined && profileId._tag === "ok"
        ? await lifecycleGate.withProfileLock(profileId.value, process)
        : await process();
      if (success) {
        recovered += 1;
      } else {
        failed += 1;
        const parsedSessionId = parseReviewSessionId(content.sessionId);
        if (diagnostics !== undefined && profileId._tag === "ok" && parsedSessionId._tag === "ok") {
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
    }
    return { recovered, failed };
  }

  private async write(): Promise<Result<void, PreparationJournalFailure>> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
    } catch {
      return err({ _tag: "PreparationJournalFailed" });
    }
    const written = await writeAtomicJson(this.filePath, this.content);
    return written._tag === "ok" ? ok(undefined) : err({ _tag: "PreparationJournalFailed" });
  }

  /** Verify every persisted deletion target before the first filesystem removal. */
  private async validatedDeletionSet(): Promise<ValidatedDeletionSet | undefined> {
    const profileId = parseWorkspaceProfileId(this.content.profileId);
    const sessionId = parseReviewSessionId(this.content.sessionId);
    if (profileId._tag === "err" || sessionId._tag === "err") return undefined;

    const sessionDirectory = this.paths.sessionDirectory(profileId.value, sessionId.value);
    const expectedJournalFile = journalFile(this.paths, profileId.value, sessionId.value);
    const expectedStagingRoot = join(sessionDirectory, ".staging");
    if (this.filePath !== expectedJournalFile || this.content.stagingRoot !== expectedStagingRoot) return undefined;

    if (!(await isSafeOwnedPath(this.paths.dataDirectory(), sessionDirectory, true))) return undefined;
    if (!(await isSafeOwnedPath(sessionDirectory, expectedJournalFile, true))) return undefined;
    if (!(await isSafeOwnedPath(sessionDirectory, expectedStagingRoot))) return undefined;

    const allowedTargets = new Set([
      this.paths.patchFile(profileId.value, sessionId.value),
      this.paths.preparedContextFile(profileId.value, sessionId.value),
      this.paths.preparedReviewInputFile(profileId.value, sessionId.value),
      this.paths.preparedDebugFile(profileId.value, sessionId.value),
    ]);
    for (const target of this.content.targets) {
      if (!allowedTargets.has(target) || !(await isSafeOwnedPath(sessionDirectory, target))) return undefined;
    }

    if (
      this.content.worktree !== undefined &&
      (
        this.content.worktree.path !== this.paths.worktreeDirectory(profileId.value, sessionId.value) ||
        !(await isSafeOwnedPath(this.paths.cacheDirectory(), this.content.worktree.path))
      )
    ) {
      return undefined;
    }
    return {
      profileId: profileId.value,
      sessionId: sessionId.value,
      journalFile: expectedJournalFile,
      stagingRoot: expectedStagingRoot,
      targets: this.content.targets,
      ...(this.content.worktree === undefined ? {} : { worktree: this.content.worktree }),
    };
  }
}

function journalFile(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  sessionId: ReviewSessionId,
): string {
  return join(paths.sessionDirectory(profileId, sessionId), "preparation.journal.json");
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
  const sessionId = parseReviewSessionId(basename(dirname(filePath)));
  const profileId = parseWorkspaceProfileId(basename(dirname(dirname(dirname(filePath)))));
  if (sessionId._tag === "err" || profileId._tag === "err") return;
  await diagnostics.record({
    profileId: profileId.value,
    sessionId: sessionId.value,
    category: "preparation",
    phase,
    retryable: true,
    detail: "Preparation journal evidence could not be recovered safely.",
  });
}

async function findJournals(paths: PatchdeskPaths): Promise<ReadonlyArray<string>> {
  const found: string[] = [];
  const profilesRoot = join(paths.dataDirectory(), "profiles");
  let profileEntries: ReadonlyArray<string>;
  try {
    profileEntries = await readdir(profilesRoot);
  } catch {
    return found;
  }
  for (const profileEntry of profileEntries) {
    const reviewsRoot = join(profilesRoot, profileEntry, "reviews");
    let sessionEntries: ReadonlyArray<string>;
    try {
      sessionEntries = await readdir(reviewsRoot);
    } catch {
      continue;
    }
    for (const sessionEntry of sessionEntries) {
      const candidate = join(reviewsRoot, sessionEntry, "preparation.journal.json");
      try {
        await stat(candidate);
        found.push(candidate);
      } catch {
        continue;
      }
    }
  }
  return found;
}

function parseJournal(input: unknown): JournalContent | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const raw = input as Record<string, unknown>;
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.profileId !== "string" ||
    typeof raw.sessionId !== "string" ||
    (raw.state !== "preparing" && raw.state !== "committing") ||
    typeof raw.stagingRoot !== "string" ||
    !Array.isArray(raw.targets) ||
    raw.targets.some((target) => typeof target !== "string")
  ) {
    return undefined;
  }
  const worktree = parseJournalWorktree(raw.worktree);
  if (raw.worktree !== undefined && worktree === undefined) return undefined;
  return {
    schemaVersion: 1,
    profileId: raw.profileId,
    sessionId: raw.sessionId,
    state: raw.state,
    stagingRoot: raw.stagingRoot,
    targets: raw.targets as ReadonlyArray<string>,
    ...(worktree === undefined ? {} : { worktree }),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isSafeOwnedPath(root: string, path: string, requirePath: boolean = false): Promise<boolean> {
  if (!isContainedPath(root, path)) return false;
  const entry = await lstat(path).catch(() => undefined);
  if (entry?.isSymbolicLink() || (requirePath && entry === undefined)) return false;
  const canonicalRoot = await realpath(root).catch(() => undefined);
  const canonicalParent = await realpathNearestExistingParent(dirname(path));
  return canonicalRoot !== undefined && canonicalParent !== undefined && isContainedPath(canonicalRoot, canonicalParent);
}

async function realpathNearestExistingParent(path: string): Promise<string | undefined> {
  let candidate = path;
  while (true) {
    const canonical = await realpath(candidate).catch(() => undefined);
    if (canonical !== undefined) return canonical;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

function isContainedPath(root: string, path: string): boolean {
  const relation = relative(resolve(root), resolve(path));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function parseJournalWorktree(input: unknown): JournalWorktree | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const raw = input as Record<string, unknown>;
  return typeof raw.path === "string" && typeof raw.repositoryPath === "string"
    ? { path: raw.path, repositoryPath: raw.repositoryPath }
    : undefined;
}

/** Rename a staged artifact into its final Session location, recording it first. */
export async function promoteStagedArtifact(
  journal: ReviewPreparationJournal,
  stagedPath: string,
  finalPath: string,
): Promise<Result<void, PreparationJournalFailure>> {
  const recorded = await journal.record(finalPath);
  if (recorded._tag === "err") return recorded;
  try {
    await mkdir(dirname(finalPath), { recursive: true });
    await rename(stagedPath, finalPath);
    return ok(undefined);
  } catch {
    return err({ _tag: "PreparationJournalFailed" });
  }
}
