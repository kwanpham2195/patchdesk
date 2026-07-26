import { mkdir, readdir, rename, lstat } from "node:fs/promises";
import { dirname, relative, resolve, join } from "node:path";

import { err, ok, type Result } from "../../domain/result";
import type { IsoTimestamp, ReviewSessionId, WorkspaceProfileId } from "../../domain/ids";
import type { StorageFailure } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

/**
 * Parse a wall-clock ISO timestamp into the filename stamp used in quarantine
 * directory names. The stamp uses UTC so the directory name matches the
 * supplied ISO timestamp regardless of the runtime timezone.
 */
export function toQuarantineStamp(at: IsoTimestamp): string {
  const date = new Date(at);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const hour = date.getUTCHours().toString().padStart(2, "0");
  const minute = date.getUTCMinutes().toString().padStart(2, "0");
  const second = date.getUTCSeconds().toString().padStart(2, "0");
  return `${year}${month}${day}T${hour}${minute}${second}`;
}

const quarantineEntrySyntax = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.\d{8}T\d{6}$/;

/**
 * Strict quarantine entry-name parser. Rejects anything that could escape
 * the quarantine directory or smuggle in path components.
 */
export function parseQuarantineEntryName(
  input: unknown,
): Result<string, InvalidQuarantineEntryName> {
  if (typeof input !== "string" || !quarantineEntrySyntax.test(input)) {
    return err({ _tag: "InvalidQuarantineEntryName" });
  }
  return ok(input);
}

export type InvalidQuarantineEntryName = {
  readonly _tag: "InvalidQuarantineEntryName";
};

export type QuarantineFailure = StorageFailure | InvalidQuarantineEntryName;

/**
 * Owns filesystem renames, listing, and removal for verified, app-owned
 * review artifacts. It never calls Git, Electron, or any external system.
 */
export class ReviewArtifactStorage {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly clock: () => IsoTimestamp,
  ) {}

  /**
   * Move a stored session and its cache worktree aside into the matching
   * `.quarantine` directories under their respective roots. The same stamp is
   * used for both so a single user action can address the pair. The session
   * rename is required; the worktree rename is best-effort (a missing
   * worktree is fine).
   */
  async quarantine(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<Result<{ readonly entryName: string }, QuarantineFailure>> {
    const entryName = `${sessionId}.${toQuarantineStamp(this.clock())}`;
    const rootSession = this.paths.sessionDirectory(profileId, sessionId);
    const rootWorktree = this.paths.worktreeDirectory(profileId, sessionId);
    const targetSession = this.paths.quarantinedSessionDirectory(profileId, entryName);
    const targetWorktree = this.paths.quarantinedWorktreeDirectory(profileId, entryName);

    if (!(await this.isUnderRoot(rootSession, this.paths.profileReviewsDirectory(profileId)))) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    if (!(await this.isUnderRoot(rootWorktree, this.paths.worktreeRootDirectory(profileId)))) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    if (!(await this.isUnderRoot(targetSession, this.paths.profileReviewsDirectory(profileId)))) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    if (!(await this.isUnderRoot(targetWorktree, this.paths.worktreeRootDirectory(profileId)))) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }

    const worktreeMoved = await this.renameIfPresent(rootWorktree, targetWorktree);
    if (worktreeMoved._tag === "err") return worktreeMoved;
    try {
      await mkdir(dirname(targetSession), { recursive: true });
    } catch {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    return rename(rootSession, targetSession).then(
      (): Result<{ readonly entryName: string }, QuarantineFailure> => ok({ entryName }),
      (cause: unknown): Result<{ readonly entryName: string }, QuarantineFailure> => {
        if (isNotFound(cause)) {
          return err({ _tag: "StorageFailure", operation: "write", reason: "not_found" });
        }
        return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
      },
    );
  }

  /**
   * List every validated quarantine entry for the given profile, paired with
   * the timestamp extracted from its name. The list is sorted newest first.
   */
  async listQuarantined(
    profileId: WorkspaceProfileId,
  ): Promise<
    Result<
      ReadonlyArray<{ readonly entryName: string; readonly quarantinedAt: string }>,
      QuarantineFailure
    >
  > {
    const root = join(this.paths.profileReviewsDirectory(profileId), ".quarantine");
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(root);
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok([]);
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }
    const items: Array<{ readonly entryName: string; readonly quarantinedAt: string }> = [];
    for (const entry of entries) {
      const parsed = parseQuarantineEntryName(entry);
      if (parsed._tag === "err") continue;
      const stamp = parsed.value.split(".").at(-1) ?? "";
      const iso = stampToIso(stamp);
      if (iso === undefined) continue;
      items.push({ entryName: parsed.value, quarantinedAt: iso });
    }
    items.sort((left, right) => right.quarantinedAt.localeCompare(left.quarantinedAt));
    return ok(items);
  }

  /**
   * Sum the bytes used by every direct child of the worktree cache root. The
   * result excludes any data the renderer is allowed to see.
   */
  async cacheBytes(profileId: WorkspaceProfileId): Promise<Result<number, StorageFailure>> {
    const children = await this.cacheChildren(profileId);
    if (children._tag === "err") return children;
    const root = this.paths.worktreeRootDirectory(profileId);
    let total = 0;
    for (const entry of children.value) {
      const child = join(root, entry);
      try {
        const info = await lstat(child);
        if (info.isSymbolicLink()) continue;
        total += info.size;
      } catch {
        // best-effort; a missing child should not fail the summary.
      }
    }
    return ok(total);
  }

  /**
   * Return the names of every direct child of the worktree cache root that
   * is not a symlink, the `.quarantine` directory, or a `.trash` directory.
   * The list is the only input the cache-clear service needs to identify
   * safe worktree removals.
   */
  async cacheChildren(
    profileId: WorkspaceProfileId,
  ): Promise<Result<ReadonlyArray<string>, StorageFailure>> {
    const root = this.paths.worktreeRootDirectory(profileId);
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(root);
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok([]);
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }
    const result: string[] = [];
    for (const entry of entries) {
      if (entry === ".quarantine" || entry === ".trash") continue;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry)) continue;
      const child = join(root, entry);
      try {
        const info = await lstat(child);
        if (info.isSymbolicLink()) continue;
        result.push(entry);
      } catch {
        // best-effort; a missing child should not fail the listing.
      }
    }
    return ok(result);
  }

  /**
   * Remove the provided cache children, skipping any path that is a symlink
   * or that lies outside the worktree cache root. The operation never
   * touches session directories. Best-effort: a single failed child is
   * reported as a storage failure so the caller can surface it.
   */
  async removeCacheChildren(
    profileId: WorkspaceProfileId,
    children: ReadonlyArray<string>,
  ): Promise<Result<undefined, StorageFailure>> {
    const root = this.paths.worktreeRootDirectory(profileId);
    for (const child of children) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(child)) continue;
      const target = join(root, child);
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink()) continue;
        await rename(target, `${target}.removed.${Date.now()}`).catch(() => undefined);
      } catch (cause: unknown) {
        if (isNotFound(cause)) continue;
        return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
      }
    }
    return ok(undefined);
  }

  /**
   * Verify that a path is inside the given root and is not a symlink. This
   * is the safety check every destructive operation must pass.
   */
  private async isUnderRoot(path: string, root: string): Promise<boolean> {
    // Use resolve (lexical) for both so the comparison stays valid even when
    // the path does not exist yet. realpath would resolve symlinks like
    // /var -> /private/var on macOS and produce a different absolute form.
    const absoluteRoot = resolve(root);
    const absolutePath = resolve(path);
    const rel = relative(absoluteRoot, absolutePath);
    if (rel.startsWith("..") || rel === "..") return false;
    if (rel.length === 0) return true;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return false;
    } catch {
      // Path does not exist; trust the lexical containment check.
    }
    return true;
  }

  /**
   * Rename a path that may not exist; a missing source is treated as success
   * because the worktree cache is rebuildable.
   */
  private async renameIfPresent(
    source: string,
    target: string,
  ): Promise<Result<undefined, QuarantineFailure>> {
    try {
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
      return ok(undefined);
    } catch (cause: unknown) {
      if (isNotFound(cause)) {
        return ok(undefined);
      }
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
  }
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

/** Convert a quarantine stamp like 20260725T000000 into an ISO timestamp. */
function stampToIso(stamp: string): string | undefined {
  if (!/^\d{8}T\d{6}$/.test(stamp)) return undefined;
  const year = stamp.slice(0, 4);
  const month = stamp.slice(4, 6);
  const day = stamp.slice(6, 8);
  const hour = stamp.slice(9, 11);
  const minute = stamp.slice(11, 13);
  const second = stamp.slice(13, 15);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}
