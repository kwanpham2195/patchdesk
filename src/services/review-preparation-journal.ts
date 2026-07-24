import { access, mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { readJsonFile, writeAtomicJson } from "../adapters/storage/json-file";
import type { ReviewSessionId, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import type { ReviewWorktreeService } from "./review-worktree-service";

export type PreparationJournalFailure = { readonly _tag: "PreparationJournalFailed" };
export type PreparationCleanupFailure = { readonly _tag: "PreparationCleanupFailed" };

type JournalWorktree = { readonly path: string; readonly repositoryPath: string };

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
 * journal never makes a Session reusable; startup recovery only deletes.
 */
export class ReviewPreparationJournal {
  private constructor(
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
    const journal = new ReviewPreparationJournal(journalFile(paths, profileId, sessionId), {
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
    await rm(this.content.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(this.filePath, { force: true }).catch(() => undefined);
  }

  /**
   * Remove every recorded staging and final artifact in reverse dependency
   * order. The journal is retained when any deletion fails so startup recovery
   * can retry; a retained journal is never a renderable Session.
   */
  async cleanup(
    worktrees: ReviewWorktreeService,
  ): Promise<Result<void, PreparationCleanupFailure>> {
    let failed = false;
    for (const target of [...this.content.targets].reverse()) {
      await rm(target, { recursive: true, force: true }).catch(() => {
        failed = true;
      });
    }
    await rm(this.content.stagingRoot, { recursive: true, force: true }).catch(() => {
      failed = true;
    });
    if (this.content.worktree !== undefined && await exists(this.content.worktree.path)) {
      const removed = await worktrees.cleanup({
        profileId: this.content.profileId as WorkspaceProfileId,
        sessionId: this.content.sessionId as ReviewSessionId,
        localPath: this.content.worktree.repositoryPath,
        targetPath: this.content.worktree.path,
      });
      if (removed._tag === "err") failed = true;
    }
    if (failed) return err({ _tag: "PreparationCleanupFailed" });
    await rm(this.filePath, { force: true }).catch(() => undefined);
    await rmdir(dirname(this.filePath)).catch(() => undefined);
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
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const journals = await findJournals(paths);
    let recovered = 0;
    let failed = 0;
    for (const filePath of journals) {
      const stored = await readJsonFile(filePath);
      if (stored._tag === "err") {
        failed += 1;
        continue;
      }
      const content = parseJournal(stored.value);
      if (content === undefined) {
        failed += 1;
        continue;
      }
      const journal = new ReviewPreparationJournal(filePath, content);
      if (content.state === "committing" && await exists(paths.sessionFile(
        content.profileId as WorkspaceProfileId,
        content.sessionId as ReviewSessionId,
      ))) {
        const removed = await rm(filePath, { force: true })
          .then(() => true)
          .catch(() => false);
        if (removed) recovered += 1;
        else failed += 1;
        continue;
      }
      const cleaned = await journal.cleanup(worktrees);
      if (cleaned._tag === "ok") recovered += 1;
      else failed += 1;
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
}

function journalFile(
  paths: PatchdeskPaths,
  profileId: WorkspaceProfileId,
  sessionId: ReviewSessionId,
): string {
  return join(paths.sessionDirectory(profileId, sessionId), "preparation.journal.json");
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
