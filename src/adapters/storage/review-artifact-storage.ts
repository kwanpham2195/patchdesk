import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";

import { err, ok, type Result } from "../../domain/result";
import { isPathContained } from "./path-containment";
import {
  parseReviewSessionId,
  type IsoTimestamp,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../../domain/ids";
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

const quarantineEntrySyntax =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)\.(\d{8}T\d{6})(?:\.[0-9a-f-]{36})?$/;

/**
 * Strict quarantine entry-name parser. Rejects anything that could escape
 * the quarantine directory or smuggle in path components.
 */
export function parseQuarantineEntryName(
  input: unknown,
): Result<string, InvalidQuarantineEntryName> {
  if (typeof input !== "string") {
    return err({ _tag: "InvalidQuarantineEntryName" });
  }
  const match = quarantineEntrySyntax.exec(input);
  const sessionId = match?.[1];
  const stamp = match?.[2];
  if (sessionId === undefined || stamp === undefined) {
    return err({ _tag: "InvalidQuarantineEntryName" });
  }
  if (
    parseReviewSessionId(sessionId)._tag === "err" &&
    !sessionId.startsWith("invalid-")
  ) {
    return err({ _tag: "InvalidQuarantineEntryName" });
  }
  if (stampToIso(stamp) === undefined) {
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
    const targetSession = this.paths.quarantinedSessionDirectory(
      profileId,
      entryName,
    );
    const targetWorktree = this.paths.quarantinedWorktreeDirectory(
      profileId,
      entryName,
    );

    if (
      !(await this.isUnderRoot(
        rootSession,
        this.paths.profileReviewsDirectory(profileId),
      ))
    ) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    if (
      !(await this.isUnderRoot(
        rootWorktree,
        this.paths.worktreeRootDirectory(profileId),
      ))
    ) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    if (
      !(await this.isUnderRoot(
        targetSession,
        this.paths.profileReviewsDirectory(profileId),
      ))
    ) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    if (
      !(await this.isUnderRoot(
        targetWorktree,
        this.paths.worktreeRootDirectory(profileId),
      ))
    ) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }

    const worktreeMoved = await this.renameIfPresent(
      rootWorktree,
      targetWorktree,
    );
    if (worktreeMoved._tag === "err") return worktreeMoved;
    try {
      await mkdir(dirname(targetSession), { recursive: true });
    } catch {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    return rename(rootSession, targetSession).then(
      (): Result<{ readonly entryName: string }, QuarantineFailure> =>
        ok({ entryName }),
      (
        cause: unknown,
      ): Result<{ readonly entryName: string }, QuarantineFailure> => {
        if (isNotFound(cause)) {
          return err({
            _tag: "StorageFailure",
            operation: "write",
            reason: "not_found",
          });
        }
        return err({
          _tag: "StorageFailure",
          operation: "write",
          reason: "io",
        });
      },
    );
  }

  /** Quarantine an invalid profile entry whose name cannot be parsed as a session ID. */
  async quarantineInvalidEntry(
    profileId: WorkspaceProfileId,
    entryName: string,
  ): Promise<Result<{ readonly entryName: string }, QuarantineFailure>> {
    if (!isSafeEntryName(entryName))
      return err({ _tag: "InvalidQuarantineEntryName" });
    const source = join(
      this.paths.profileReviewsDirectory(profileId),
      entryName,
    );
    const encoded = Buffer.from(entryName, "utf8")
      .toString("base64url")
      .slice(0, 32);
    const targetName = `invalid-${encoded}.${toQuarantineStamp(this.clock())}`;
    const target = this.paths.quarantinedSessionDirectory(
      profileId,
      targetName,
    );
    if (
      !(await this.isUnderRoot(
        source,
        this.paths.profileReviewsDirectory(profileId),
      ))
    ) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    if (
      !(await this.isUnderRoot(
        target,
        join(this.paths.profileReviewsDirectory(profileId), ".quarantine"),
      ))
    ) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    try {
      await mkdir(dirname(target), { recursive: true });
    } catch {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    const moved = await renameIfPresentPath(source, target);
    return moved._tag === "ok" ? ok({ entryName: targetName }) : moved;
  }

  /** Preserve any surviving session/worktree artifacts during upgrade reset. */
  async quarantineIfPresent(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<Result<{ readonly entryName: string }, QuarantineFailure>> {
    const entryName = `${sessionId}.${toQuarantineStamp(this.clock())}.${randomUUID()}`;
    const sourceSession = this.paths.sessionDirectory(profileId, sessionId);
    const sourceWorktree = this.paths.worktreeDirectory(profileId, sessionId);
    const targetSession = this.paths.quarantinedSessionDirectory(
      profileId,
      entryName,
    );
    const targetWorktree = this.paths.quarantinedWorktreeDirectory(
      profileId,
      entryName,
    );
    if (
      !(await this.isUnderRoot(
        sourceSession,
        this.paths.profileReviewsDirectory(profileId),
      )) ||
      !(await this.isUnderRoot(
        sourceWorktree,
        this.paths.worktreeRootDirectory(profileId),
      )) ||
      !(await this.isUnderRoot(
        targetSession,
        this.paths.profileReviewsDirectory(profileId),
      )) ||
      !(await this.isUnderRoot(
        targetWorktree,
        this.paths.worktreeRootDirectory(profileId),
      ))
    ) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    const worktree = await this.renameIfPresent(sourceWorktree, targetWorktree);
    if (worktree._tag === "err") return worktree;
    const session = await this.renameIfPresent(sourceSession, targetSession);
    return session._tag === "ok" ? ok({ entryName }) : session;
  }

  /** Preserve one unusable Review aggregate before a clean local restart. */
  async quarantineReview(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<{ readonly entryName: string }, QuarantineFailure>> {
    const entryName = `${reviewId}.${toQuarantineStamp(this.clock())}.${randomUUID()}`;
    const source = this.paths.reviewDirectory(profileId, reviewId);
    const target = this.paths.quarantinedReviewDirectory(profileId, entryName);
    if (
      !(await this.isUnderRoot(
        source,
        this.paths.profileWorkbenchesDirectory(profileId),
      )) ||
      !(await this.isUnderRoot(
        target,
        join(this.paths.profileWorkbenchesDirectory(profileId), ".quarantine"),
      ))
    ) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    try {
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
      return ok({ entryName });
    } catch (cause: unknown) {
      return err({
        _tag: "StorageFailure",
        operation: "write",
        reason: isNotFound(cause) ? "not_found" : "io",
      });
    }
  }

  /** Remove one disposable session and its rebuildable worktree idempotently. */
  async removeSession(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): Promise<Result<void, QuarantineFailure>> {
    const parsed = parseReviewSessionId(sessionId);
    if (parsed._tag === "err")
      return err({ _tag: "InvalidQuarantineEntryName" });
    const sessionRoot = this.paths.sessionDirectory(profileId, parsed.value);
    const worktreeRoot = this.paths.worktreeDirectory(profileId, parsed.value);
    if (
      !(await this.isUnderRoot(
        sessionRoot,
        this.paths.profileReviewsDirectory(profileId),
      ))
    ) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    if (
      !(await this.isUnderRoot(
        worktreeRoot,
        this.paths.worktreeRootDirectory(profileId),
      ))
    ) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    const removedSession = await removePath(sessionRoot);
    if (removedSession._tag === "err") return removedSession;
    const removedWorktree = await removePath(worktreeRoot);
    return removedWorktree;
  }

  /** Remove one validated quarantine entry and its paired worktree idempotently. */
  async removeQuarantined(
    profileId: WorkspaceProfileId,
    entryName: string,
  ): Promise<Result<void, QuarantineFailure>> {
    const parsed = parseQuarantineEntryName(entryName);
    if (parsed._tag === "err") return parsed;
    const sessionRoot = this.paths.quarantinedSessionDirectory(
      profileId,
      parsed.value,
    );
    const worktreeRoot = this.paths.quarantinedWorktreeDirectory(
      profileId,
      parsed.value,
    );
    const quarantineSessionRoot = join(
      this.paths.profileReviewsDirectory(profileId),
      ".quarantine",
    );
    const quarantineWorktreeRoot = join(
      this.paths.worktreeRootDirectory(profileId),
      ".quarantine",
    );
    if (!(await this.isUnderRoot(sessionRoot, quarantineSessionRoot))) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    if (!(await this.isUnderRoot(worktreeRoot, quarantineWorktreeRoot))) {
      return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    }
    const removedSession = await removePath(sessionRoot);
    if (removedSession._tag === "err") return removedSession;
    return removePath(worktreeRoot);
  }

  /**
   * List every validated quarantine entry for the given profile, paired with
   * the timestamp extracted from its name. The list is sorted newest first.
   */
  async listQuarantined(profileId: WorkspaceProfileId): Promise<
    Result<
      ReadonlyArray<{
        readonly entryName: string;
        readonly quarantinedAt: string;
      }>,
      QuarantineFailure
    >
  > {
    const root = join(
      this.paths.profileReviewsDirectory(profileId),
      ".quarantine",
    );
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(root);
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok([]);
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }
    const items: Array<{
      readonly entryName: string;
      readonly quarantinedAt: string;
    }> = [];
    for (const entry of entries) {
      const parsed = parseQuarantineEntryName(entry);
      if (parsed._tag === "err") continue;
      const match = quarantineEntrySyntax.exec(parsed.value);
      const stamp = match?.[2];
      if (stamp === undefined) continue;
      const iso = stampToIso(stamp);
      if (iso === undefined) continue;
      items.push({ entryName: parsed.value, quarantinedAt: iso });
    }
    items.sort((left, right) =>
      right.quarantinedAt.localeCompare(left.quarantinedAt),
    );
    return ok(items);
  }

  /**
   * Sum the bytes used by every direct child of the worktree cache root. The
   * result excludes any data the renderer is allowed to see.
   */
  async cacheBytes(
    profileId: WorkspaceProfileId,
  ): Promise<Result<number, StorageFailure>> {
    const children = await this.cacheChildren(profileId);
    if (children._tag === "err") return children;
    const root = this.paths.worktreeRootDirectory(profileId);
    const limit = createIoLimiter(8);
    const sizes = await Promise.all(
      children.value.map((entry) => measureBytes(join(root, entry), limit)),
    );
    return ok(sizes.reduce((total, size) => total + size, 0));
  }

  /**
   * Return the names of every direct child of the worktree cache root that
   * is not a symlink, the `.quarantine` directory, or a `.trash` directory.
   * The list is the only input the cache-clear service needs to identify
   * safe worktree removals.
   */
  async hasQuarantinedSession(
    profileId: WorkspaceProfileId,
    entryName: string,
  ): Promise<Result<boolean, StorageFailure>> {
    const path = this.paths.quarantinedSessionDirectory(profileId, entryName);
    try {
      const info = await lstat(path);
      return ok(!info.isSymbolicLink() && info.isDirectory());
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok(false);
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }
  }

  async hasQuarantinedWorktree(
    profileId: WorkspaceProfileId,
    entryName: string,
  ): Promise<Result<boolean, StorageFailure>> {
    const path = this.paths.quarantinedWorktreeDirectory(profileId, entryName);
    try {
      const info = await lstat(path);
      return ok(!info.isSymbolicLink());
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok(false);
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }
  }

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
    const candidates = entries.filter(
      (entry) =>
        entry !== ".quarantine" &&
        entry !== ".trash" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry),
    );
    const inspected = await mapConcurrent(candidates, 8, async (entry) => {
      try {
        return (await lstat(join(root, entry))).isSymbolicLink()
          ? undefined
          : entry;
      } catch {
        // Best-effort: a child removed during discovery is not a listing failure.
        return undefined;
      }
    });
    return ok(
      inspected.flatMap((entry) => (entry === undefined ? [] : [entry])),
    );
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
        await rm(target, { recursive: true, force: true });
      } catch (cause: unknown) {
        if (isNotFound(cause)) continue;
        return err({
          _tag: "StorageFailure",
          operation: "write",
          reason: "io",
        });
      }
    }
    return ok(undefined);
  }

  /**
   * Verify that a path is inside the given root and is not a symlink. This
   * is the safety check every destructive operation must pass.
   */
  private async isUnderRoot(path: string, root: string): Promise<boolean> {
    const absoluteRoot = resolve(root);
    let current = resolve(path);
    if (!isPathContained(absoluteRoot, current)) return false;
    for (;;) {
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) return false;
      } catch (cause: unknown) {
        if (!isNotFound(cause)) return false;
      }
      if (current === absoluteRoot) return true;
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
      if (!isPathContained(absoluteRoot, current)) return false;
    }
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

async function renameIfPresentPath(
  source: string,
  target: string,
): Promise<Result<void, StorageFailure>> {
  try {
    await rename(source, target);
    return ok(undefined);
  } catch (cause: unknown) {
    if (isNotFound(cause)) return ok(undefined);
    return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
  }
}

function isSafeEntryName(input: string): boolean {
  return (
    input.length > 0 &&
    input !== "." &&
    input !== ".." &&
    !input.includes("/") &&
    !input.includes("\\") &&
    input[0] !== "."
  );
}

async function removePath(path: string): Promise<Result<void, StorageFailure>> {
  try {
    await rm(path, { recursive: true, force: true });
    return ok(undefined);
  } catch (cause: unknown) {
    if (isNotFound(cause)) return ok(undefined);
    return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
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

async function mapConcurrent<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> {
  const values: Array<R> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    const index = next++;
    const item = items[index];
    if (item === undefined) return;
    values[index] = await map(item);
    return worker();
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return values;
}

type LimitedIo = <T>(work: () => Promise<T>) => Promise<T>;

function createIoLimiter(concurrency: number): LimitedIo {
  let active = 0;
  const queued: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    queued.shift()?.();
  };
  return <T>(work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active += 1;
        void work().then(resolve, reject).finally(release);
      };
      if (active < concurrency) start();
      else queued.push(start);
    });
}

async function measureBytes(path: string, limit: LimitedIo): Promise<number> {
  try {
    const info = await limit(() => lstat(path));
    if (info.isSymbolicLink()) return 0;
    if (!info.isDirectory()) return info.size;
    const entries = await limit(() => readdir(path, { withFileTypes: true }));
    const sizes = await Promise.all(
      entries.flatMap((entry) =>
        entry.isSymbolicLink()
          ? []
          : [measureBytes(join(path, entry.name), limit)],
      ),
    );
    return sizes.reduce((total, size) => total + size, 0);
  } catch {
    return 0;
  }
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
  const date = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`,
  );
  if (Number.isNaN(date.getTime())) return undefined;
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  )
    return undefined;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}
