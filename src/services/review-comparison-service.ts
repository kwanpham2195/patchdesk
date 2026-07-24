import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { writeAtomicJson } from "../adapters/storage/json-file";
import type {
  GitSha,
  IsoTimestamp,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import {
  parseGitSha,
  parseIsoTimestamp,
} from "../domain/ids";
import type { RevisionComparison } from "../domain/review-comparison";
import type { PriorFindingEvidence } from "../domain/finding-lifecycle";
import { err, ok, type Result } from "../domain/result";
import type { GitReadExecutor } from "./review-worktree-service";

export type ComparisonFailure = {
  readonly _tag: "ReviewComparisonFailed";
  readonly reason: "missing_local_path" | "git_read" | "head_changed" | "storage";
};

export type PreparedComparison = {
  readonly comparison: RevisionComparison;
  readonly comparisonPatchPath: string;
  readonly comparisonMetadataPath: string;
  readonly previousFindingsPath: string;
  readonly lifecyclePath: string;
};

/** Creates exact managed-ref, two-tree comparison evidence without touching a user branch or worktree. */
export class ReviewComparisonService {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly git: GitReadExecutor,
    private readonly now: () => IsoTimestamp,
  ) {}

  async prepare(input: {
    readonly profileId: WorkspaceProfileId;
    readonly targetSessionId: ReviewSessionId;
    readonly baseSessionId: ReviewSessionId;
    readonly baseHeadSha: GitSha;
    readonly headSha: GitSha;
    readonly localPath?: string;
    readonly previousFindings: ReadonlyArray<PriorFindingEvidence>;
    /** Journal-owned staging directory; finals stay untouched until the caller promotes. */
    readonly stagingDirectory?: string;
  }): Promise<Result<PreparedComparison, ComparisonFailure>> {
    if (input.localPath === undefined)
      return err({ _tag: "ReviewComparisonFailed", reason: "missing_local_path" });
    const root = await this.git.run(["git", "-C", input.localPath, "rev-parse", "--show-toplevel"]);
    if (root._tag === "err") return failure("git_read");
    const baseRef = managedRef(input.profileId, input.targetSessionId, "base");
    const headRef = managedRef(input.profileId, input.targetSessionId, "head");
    // `git fetch` updates FETCH_HEAD, so keep the exact-SHA operations serialized even
    // though their target refs differ. This avoids racing a user repository's git state.
    const fetchedBase = await this.git.run(["git", "-C", root.value.stdout.trim(), "fetch", "origin", `${input.baseHeadSha}:${baseRef}`, "--no-tags"]);
    if (fetchedBase._tag === "err") return failure("git_read");
    const fetchedHead = await this.git.run(["git", "-C", root.value.stdout.trim(), "fetch", "origin", `${input.headSha}:${headRef}`, "--no-tags"]);
    if (fetchedHead._tag === "err") return failure("git_read");
    const [resolvedBase, resolvedHead] = await Promise.all([
      resolveRef(this.git, root.value.stdout.trim(), baseRef),
      resolveRef(this.git, root.value.stdout.trim(), headRef),
    ]);
    if (resolvedBase._tag === "err" || resolvedHead._tag === "err") return failure("git_read");
    if (resolvedBase.value !== input.baseHeadSha || resolvedHead.value !== input.headSha)
      return failure("head_changed");
    const ancestryCheck = await this.git.run(["git", "-C", root.value.stdout.trim(), "merge-base", "--is-ancestor", baseRef, headRef]);
    const ancestry: RevisionComparison["ancestry"] = ancestryCheck._tag === "ok" ? "fast_forward" : "rewritten";
    const [patch, names, numstat, commits] = await Promise.all([
      this.git.run(["git", "-C", root.value.stdout.trim(), "diff", "--no-ext-diff", "--find-renames", baseRef, headRef]),
      this.git.run(["git", "-C", root.value.stdout.trim(), "diff", "--name-status", "--find-renames", baseRef, headRef]),
      this.git.run(["git", "-C", root.value.stdout.trim(), "diff", "--numstat", "--find-renames", baseRef, headRef]),
      this.git.run(["git", "-C", root.value.stdout.trim(), "log", "--format=%H%x00%an%x00%aI%x00%s", `${baseRef}..${headRef}`]),
    ]);
    if (patch._tag === "err" || names._tag === "err" || numstat._tag === "err" || commits._tag === "err") return failure("git_read");
    const parsedFiles = parseFiles(names.value.stdout, numstat.value.stdout);
    const parsedCommits = parseCommits(commits.value.stdout);
    if (parsedFiles === undefined || parsedCommits === undefined) return failure("git_read");
    const comparison: RevisionComparison = {
      schemaVersion: 1,
      baseSessionId: input.baseSessionId,
      baseHeadSha: input.baseHeadSha,
      headSha: input.headSha,
      ancestry,
      source: "local_git",
      completeness: "complete",
      commits: parsedCommits,
      files: parsedFiles.files,
      additions: parsedFiles.additions,
      deletions: parsedFiles.deletions,
      createdAt: this.now(),
    };
    return this.persist({
      profileId: input.profileId,
      targetSessionId: input.targetSessionId,
      comparison,
      patch: patch.value.stdout,
      previousFindings: input.previousFindings,
      ...(input.stagingDirectory === undefined ? {} : { stagingDirectory: input.stagingDirectory }),
    });
  }

  /** Persists a complete comparison from a separately verified read boundary. */
  async persist(input: {
    readonly profileId: WorkspaceProfileId;
    readonly targetSessionId: ReviewSessionId;
    readonly comparison: RevisionComparison;
    readonly patch: string;
    readonly previousFindings: ReadonlyArray<PriorFindingEvidence>;
    /** Journal-owned staging directory; finals stay untouched until the caller promotes. */
    readonly stagingDirectory?: string;
  }): Promise<Result<PreparedComparison, ComparisonFailure>> {
    if (input.comparison.completeness !== "complete") return failure("git_read");
    const stage = (finalPath: string): string =>
      input.stagingDirectory === undefined ? finalPath : join(input.stagingDirectory, basename(finalPath));
    const comparisonPatchPath = stage(this.paths.comparisonPatchFile(input.profileId, input.targetSessionId));
    const comparisonMetadataPath = stage(this.paths.comparisonMetadataFile(input.profileId, input.targetSessionId));
    const previousFindingsPath = stage(this.paths.previousFindingsFile(input.profileId, input.targetSessionId));
    const lifecyclePath = stage(this.paths.findingLifecycleFile(input.profileId, input.targetSessionId));
    const writtenPatch = await writeAtomicText(comparisonPatchPath, input.patch);
    const writes = writtenPatch ? await Promise.all([
      writeAtomicJson(comparisonMetadataPath, input.comparison),
      writeAtomicJson(previousFindingsPath, input.previousFindings),
      writeAtomicJson(lifecyclePath, []),
    ]) : [];
    if (!writtenPatch || writes.some((result) => result._tag === "err")) return failure("storage");
    return ok({ comparison: input.comparison, comparisonPatchPath, comparisonMetadataPath, previousFindingsPath, lifecyclePath });
  }
}

function managedRef(profileId: WorkspaceProfileId, sessionId: ReviewSessionId, side: "base" | "head"): string {
  return `refs/patchdesk/reviews/${profileId}/${sessionId}/comparison/${side}`;
}

async function resolveRef(git: GitReadExecutor, root: string, ref: string): Promise<Result<GitSha, ComparisonFailure>> {
  const value = await git.run(["git", "-C", root, "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  if (value._tag === "err") return failure("git_read");
  const sha = parseGitSha(value.value.stdout.trim());
  return sha._tag === "ok" ? ok(sha.value) : failure("git_read");
}

function parseFiles(names: string, numstat: string): { readonly files: RevisionComparison["files"]; readonly additions: number; readonly deletions: number } | undefined {
  const stats = new Map<string, { readonly additions: number; readonly deletions: number; readonly binary: boolean }>();
  for (const line of numstat.split("\n")) {
    if (line.length === 0) continue;
    const [added, deleted, path] = line.split("\t");
    if (added === undefined || deleted === undefined || path === undefined) return undefined;
    const binary = added === "-" || deleted === "-";
    const additions = binary ? 0 : Number.parseInt(added, 10);
    const deletions = binary ? 0 : Number.parseInt(deleted, 10);
    if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) return undefined;
    stats.set(path, { additions, deletions, binary });
  }
  const files: Array<RevisionComparison["files"][number]> = [];
  for (const line of names.split("\n")) {
    if (line.length === 0) continue;
    const [rawStatus, ...paths] = line.split("\t");
    const path = paths.at(-1);
    if (rawStatus === undefined || path === undefined) return undefined;
    const status = rawStatus.startsWith("A") ? "added" : rawStatus.startsWith("D") ? "deleted" : rawStatus.startsWith("R") ? "renamed" : rawStatus.startsWith("C") ? "copied" : rawStatus.startsWith("M") ? "modified" : "unknown";
    const stat = stats.get(path) ?? { additions: 0, deletions: 0, binary: true };
    files.push({ path, ...(paths.length > 1 && paths[0] !== undefined ? { oldPath: paths[0] } : {}), status, additions: stat.additions, deletions: stat.deletions, binary: stat.binary, textPatchAvailable: !stat.binary });
  }
  return { files, additions: files.reduce((total, file) => total + file.additions, 0), deletions: files.reduce((total, file) => total + file.deletions, 0) };
}

function parseCommits(value: string): RevisionComparison["commits"] | undefined {
  const commits: Array<RevisionComparison["commits"][number]> = [];
  for (const line of value.split("\n")) {
    if (line.length === 0) continue;
    const [rawSha, author, authoredAt, subject] = line.split("\0");
    if (rawSha === undefined || author === undefined || authoredAt === undefined || subject === undefined) return undefined;
    const sha = parseGitSha(rawSha);
    const date = new Date(authoredAt);
    if (Number.isNaN(date.valueOf())) return undefined;
    const normalizedTimestamp = date.toISOString();
    const timestamp = parseIsoTimestamp(normalizedTimestamp);
    if (sha._tag === "err" || timestamp._tag === "err") return undefined;
    commits.push({ sha: sha.value, author, authoredAt: timestamp.value, subject });
  }
  return commits;
}

async function writeAtomicText(path: string, value: string): Promise<boolean> {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(value, "utf8");
    await handle.sync().catch(() => undefined);
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directoryHandle = await open(directory, "r").catch(() => undefined);
    if (directoryHandle !== undefined) {
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close().catch(() => undefined);
    }
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    return false;
  }
}
function failure(reason: ComparisonFailure["reason"]): Result<never, ComparisonFailure> { return err({ _tag: "ReviewComparisonFailed", reason }); }
